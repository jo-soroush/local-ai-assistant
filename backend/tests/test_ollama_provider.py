import asyncio
import http.server
import json
import threading

import httpx
import pytest

from app.llm.base import (
    ChatMessage,
    LLMBadResponse,
    LLMModelNotFound,
    LLMTimeout,
    LLMUnavailable,
)
from app.llm.ollama import OllamaProvider

MESSAGES = [ChatMessage("system", "sys"), ChatMessage("user", "hi")]


def provider(handler, timeout_s=5.0):
    return OllamaProvider(
        "http://127.0.0.1:11434/", "qwen2.5-coder:7b", timeout_s, transport=httpx.MockTransport(handler)
    )


def run(coro):
    return asyncio.run(coro)


def test_success_and_request_shape():
    seen = {}

    def handler(request: httpx.Request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"role": "assistant", "content": "hello!"}, "done": True})

    assert run(provider(handler).generate(MESSAGES)) == "hello!"
    assert seen["url"] == "http://127.0.0.1:11434/api/chat"
    assert seen["body"] == {
        "model": "qwen2.5-coder:7b",
        "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}],
        "stream": False,
    }


def test_model_not_found():
    def handler(_):
        return httpx.Response(404, json={"error": "model 'qwen2.5-coder:7b' not found"})

    with pytest.raises(LLMModelNotFound) as exc:
        run(provider(handler).generate(MESSAGES))
    assert "qwen2.5-coder:7b" in exc.value.message and "ollama list" in exc.value.message


def test_connection_refused():
    def handler(_):
        raise httpx.ConnectError("refused")

    with pytest.raises(LLMUnavailable):
        run(provider(handler).generate(MESSAGES))


def test_connect_timeout_is_unavailable():
    def handler(_):
        raise httpx.ConnectTimeout("slow")

    with pytest.raises(LLMUnavailable):
        run(provider(handler).generate(MESSAGES))


def test_read_timeout():
    def handler(_):
        raise httpx.ReadTimeout("stalled")

    with pytest.raises(LLMTimeout):
        run(provider(handler).generate(MESSAGES))


def test_total_timeout_bounds_a_slow_response():
    async def handler(_):
        await asyncio.sleep(5)
        return httpx.Response(200, json={})

    with pytest.raises(LLMTimeout):
        run(provider(handler, timeout_s=0.05).generate(MESSAGES))


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="boom"),
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json={}),
        httpx.Response(200, json={"message": {}}),
        httpx.Response(200, json={"message": {"content": 5}}),
        httpx.Response(200, json={"message": {"content": "   "}}),
        httpx.Response(200, json=["x"]),
    ],
)
def test_bad_responses(response):
    with pytest.raises(LLMBadResponse):
        run(provider(lambda _: response).generate(MESSAGES))


def test_error_messages_do_not_leak_prompt():
    with pytest.raises(LLMBadResponse) as exc:
        run(provider(lambda _: httpx.Response(500, text="echo hi sys")).generate(MESSAGES))
    assert "hi" not in exc.value.message.split() and "sys" not in exc.value.message


class _Recorder(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.hits.append(self.path)
        body = json.dumps({"message": {"role": "assistant", "content": "direct reply"}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def _serve():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
    server.hits = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def test_environment_proxies_are_ignored(monkeypatch):
    """Prompts must go straight to the loopback Ollama URL, never through HTTP(S)_PROXY/ALL_PROXY."""
    ollama, proxy = _serve(), _serve()
    try:
        proxy_url = f"http://127.0.0.1:{proxy.server_port}"
        for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            monkeypatch.setenv(var, proxy_url)
        for var in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(var, raising=False)

        p = OllamaProvider(f"http://127.0.0.1:{ollama.server_port}", "qwen2.5-coder:7b", 5.0)
        assert run(p.generate(MESSAGES)) == "direct reply"
        assert ollama.hits == ["/api/chat"]
        assert proxy.hits == []
    finally:
        ollama.shutdown()
        proxy.shutdown()
