import asyncio
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.llm.base import ChatMessage
from app.llm.factory import get_provider
from app.main import DEFAULT_HOST, DEFAULT_PORT, MAX_BODY_BYTES, app
from app.schemas import MAX_MESSAGE_CHARS

client = TestClient(app, raise_server_exceptions=False)


class FakeProvider:
    def __init__(self):
        self.calls = []

    async def generate(self, messages):
        self.calls.append(messages)
        return f"fake reply to: {messages[-1].content}"


@pytest.fixture(autouse=True)
def fake_provider():
    provider = FakeProvider()
    app.dependency_overrides[get_provider] = lambda: provider
    yield provider
    app.dependency_overrides.clear()


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


def test_chat_returns_provider_reply(fake_provider):
    resp = client.post("/v1/chat", json={"message": "  hello  "})
    assert resp.status_code == 200
    body = resp.json()
    assert body["reply"] == "fake reply to: hello"
    uuid.UUID(body["request_id"])
    assert resp.headers["X-Request-ID"] == body["request_id"]
    roles = [m.role for m in fake_provider.calls[0]]
    assert roles == ["system", "user"]
    assert fake_provider.calls[0][1] == ChatMessage("user", "hello")


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
    assert resp.json()["reply"].endswith("fake reply to: hello")


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
    chunks = [b"a" * 16384] * (MAX_BODY_BYTES // 16384 + 2)  # over the limit, no Content-Length header
    status, headers, body = _raw_asgi_post(chunks, [("content-type", "application/json")])
    assert status == 413
    assert body["error"]["code"] == "payload_too_large"
    uuid.UUID(body["request_id"])
    assert headers[b"x-request-id"].decode() == body["request_id"]


def test_understated_content_length_cannot_bypass_limit():
    chunks = [b"a" * 16384] * (MAX_BODY_BYTES // 16384 + 2)
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
    assert body["reply"].endswith("fake reply to: hello")


@pytest.mark.parametrize(
    "exc_cls, status, code",
    [
        ("LLMUnavailable", 503, "llm_unavailable"),
        ("LLMModelNotFound", 502, "llm_model_not_found"),
        ("LLMTimeout", 504, "llm_timeout"),
        ("LLMBadResponse", 502, "llm_bad_response"),
        ("LLMContextTooLarge", 422, "context_too_large"),
    ],
)
def test_llm_errors_use_structured_contract(exc_cls, status, code):
    from app.llm import base

    class Failing:
        async def generate(self, messages):
            raise getattr(base, exc_cls)("provider problem")

    app.dependency_overrides[get_provider] = lambda: Failing()
    body = assert_error(client.post("/v1/chat", json={"message": "hi"}), status, code)
    assert body["error"]["message"] == "provider problem"


def test_route_and_extension_do_not_contain_ollama_wire_format():
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[2]
    main_src = (root / "backend/app/main.py").read_text().lower()
    assert "/api/chat" not in main_src and "ollama" not in main_src
    for f in (root / "vscode-extension/src").glob("*.ts"):
        text = f.read_text().lower()
        assert "ollama" not in text and "/api/chat" not in text, f.name
