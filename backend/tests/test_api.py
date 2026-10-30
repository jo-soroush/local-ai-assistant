import asyncio
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import DEFAULT_HOST, DEFAULT_PORT, MAX_BODY_BYTES, app
from app.schemas import MAX_MESSAGE_CHARS

client = TestClient(app, raise_server_exceptions=False)


def assert_error(resp, status, code):
    assert resp.status_code == status
    body = resp.json()
    assert body["error"]["code"] == code
    assert body["error"]["message"]
    uuid.UUID(body["request_id"])
    assert resp.headers["X-Request-ID"] == body["request_id"]
    return body


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_chat_returns_deterministic_placeholder():
    resp = client.post("/v1/chat", json={"message": "  hello  "})
    assert resp.status_code == 200
    body = resp.json()
    assert body["reply"] == "[backend placeholder] No model is connected yet. You asked: hello"
    uuid.UUID(body["request_id"])
    assert resp.headers["X-Request-ID"] == body["request_id"]
    assert client.post("/v1/chat", json={"message": "hello"}).json()["reply"] == body["reply"]


def test_request_ids_are_unique():
    a = client.get("/health").headers["X-Request-ID"]
    b = client.get("/health").headers["X-Request-ID"]
    assert a != b


def test_max_length_message_accepted():
    resp = client.post("/v1/chat", json={"message": "a" * MAX_MESSAGE_CHARS})
    assert resp.status_code == 200


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"message": ""},
        {"message": "   \n "},
        {"message": 123},
        {"message": None},
        {"message": "a" * (MAX_MESSAGE_CHARS + 1)},
        {"message": "hi", "extra": 1},
    ],
)
def test_invalid_chat_input_is_422(payload):
    body = assert_error(client.post("/v1/chat", json=payload), 422, "validation_error")
    assert "message" in body["error"]["message"] or "extra" in body["error"]["message"]


def test_malformed_json_is_422():
    resp = client.post("/v1/chat", content="{not json", headers={"Content-Type": "application/json"})
    assert_error(resp, 422, "validation_error")


def test_oversized_body_is_413():
    resp = client.post("/v1/chat", json={"message": "a" * (MAX_BODY_BYTES + 1)})
    assert_error(resp, 413, "payload_too_large")


def test_unknown_route_and_wrong_method():
    assert_error(client.get("/nope"), 404, "not_found")
    assert_error(client.get("/v1/chat"), 405, "method_not_allowed")


def test_defaults_are_loopback():
    assert DEFAULT_HOST == "127.0.0.1"
    assert DEFAULT_PORT == 8765


def _chunks(*sizes):
    for n in sizes:
        yield b"a" * n


def test_oversized_chunked_request_is_413():
    # A generator body is sent with Transfer-Encoding: chunked and no Content-Length.
    resp = client.post(
        "/v1/chat",
        content=_chunks(MAX_BODY_BYTES // 2, MAX_BODY_BYTES // 2, 10),
        headers={"Content-Type": "application/json"},
    )
    assert "content-length" not in resp.request.headers
    assert resp.request.headers["transfer-encoding"] == "chunked"
    assert_error(resp, 413, "payload_too_large")


def test_valid_chunked_request_below_limit_is_ok():
    payload = json.dumps({"message": "hello"}).encode()
    resp = client.post(
        "/v1/chat",
        content=iter([payload[:5], payload[5:]]),
        headers={"Content-Type": "application/json"},
    )
    assert resp.request.headers["transfer-encoding"] == "chunked"
    assert resp.status_code == 200
    assert resp.json()["reply"].endswith("You asked: hello")


def test_body_just_below_limit_is_not_413():
    # Whole body < limit but invalid JSON: must reach validation (422), not the size guard.
    resp = client.post(
        "/v1/chat", content=b"a" * (MAX_BODY_BYTES - 1), headers={"Content-Type": "application/json"}
    )
    assert_error(resp, 422, "validation_error")


def _raw_asgi_post(chunks, headers):
    """Drive the ASGI app directly with a streamed body and caller-chosen headers."""
    sent = []
    queue = list(chunks)

    async def receive():
        if queue:
            body = queue.pop(0)
            return {"type": "http.request", "body": body, "more_body": bool(queue)}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/v1/chat",
        "raw_path": b"/v1/chat",
        "query_string": b"",
        "headers": [(k.encode(), v.encode()) for k, v in headers],
        "server": ("127.0.0.1", 8765),
        "client": ("127.0.0.1", 1),
        "scheme": "http",
    }
    asyncio.run(app(scope, receive, send))
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], dict(start["headers"]), json.loads(body)


def test_oversized_stream_without_content_length_is_413():
    chunks = [b"a" * 16384] * 5  # 80 KiB total, no Content-Length header at all
    status, headers, body = _raw_asgi_post(chunks, [("content-type", "application/json")])
    assert status == 413
    assert body["error"]["code"] == "payload_too_large"
    uuid.UUID(body["request_id"])
    assert headers[b"x-request-id"].decode() == body["request_id"]


def test_understated_content_length_cannot_bypass_limit():
    chunks = [b"a" * 16384] * 5
    status, _, body = _raw_asgi_post(
        chunks, [("content-type", "application/json"), ("content-length", "10")]
    )
    assert status == 413
    assert body["error"]["code"] == "payload_too_large"


def test_valid_stream_without_content_length_is_ok():
    payload = json.dumps({"message": "hello"}).encode()
    status, _, body = _raw_asgi_post(
        [payload[:7], payload[7:]], [("content-type", "application/json")]
    )
    assert status == 200
    assert body["reply"].endswith("You asked: hello")
