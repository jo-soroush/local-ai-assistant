import asyncio
import http.server
import json
import threading

import httpx
import pytest

from app.llm.base import (
    ChatMessage,
    LLMBadResponse,
    LLMContextTooLarge,
    LLMModelNotFound,
    LLMTimeout,
    LLMUnavailable,
)
from app.llm.ollama import OllamaProvider

MESSAGES = [ChatMessage("system", "sys"), ChatMessage("user", "hi")]


OVERFLOW_400 = '{"error":"request (%d tokens) exceeds the available context size (8192 tokens), try increasing it"}'
SHOW_OK = {"model_info": {"general.architecture": "qwen2", "qwen2.context_length": 32768}}


def provider(handler, timeout_s=5.0, show=None, measure=True, **kwargs):
    """Mock Ollama: /api/show and (unless measure=False) the probe/token-count calls are answered here;
    the real chat call goes to the test's handler."""

    async def routed(request: httpx.Request):
        if request.url.path == "/api/show":
            return show if show is not None else httpx.Response(200, json=SHOW_OK)
        if measure:
            body = json.loads(request.content)
            if body["options"]["num_predict"] == 1:
                if body["messages"][0]["content"].startswith("0123456789"):
                    return httpx.Response(400, text=OVERFLOW_400 % 99999)
                return httpx.Response(200, json={"message": {"content": "x"}, "prompt_eval_count": 10})
        result = handler(request)
        return await result if asyncio.iscoroutine(result) else result

    return OllamaProvider(
        "http://127.0.0.1:11434/",
        "qwen2.5-coder:7b",
        timeout_s,
        transport=httpx.MockTransport(routed),
        **kwargs,
    )


def rec_provider(rec, **kwargs):
    return provider(rec, measure=False, **kwargs)


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
        "truncate": False,
        "shift": False,
        "options": {"num_ctx": 8192, "num_predict": 2048},
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
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        self.server.hits.append(self.path)
        status, reply = 200, {"message": {"role": "assistant", "content": "direct reply"}, "prompt_eval_count": 10}
        if request.get("options", {}).get("num_predict") == 1 and request["messages"][0]["content"].startswith("0123456789"):
            reply = {"error": "request (99999 tokens) exceeds the available context size (8192 tokens), try increasing it"}
            status = 400
        body = json.dumps(reply).encode()
        self.send_response(status)
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
        assert set(ollama.hits) == {"/api/show", "/api/chat"}  # show, probe, count, real call
        assert proxy.hits == []
    finally:
        ollama.shutdown()
        proxy.shutdown()


# -- context-window budget ---------------------------------------------------------------------

class Recorder:
    """Stateful fake for /api/chat that distinguishes the probe, the token count and the real call."""

    def __init__(self, prompt_tokens=3000, rejects_overflow=True, final=None):
        self.calls = []
        self.prompt_tokens = prompt_tokens
        self.rejects_overflow = rejects_overflow
        self.final = final or httpx.Response(200, json={"message": {"content": "answer"}, "done_reason": "stop"})

    def __call__(self, request: httpx.Request):
        body = json.loads(request.content)
        if body["options"]["num_predict"] == 1:
            if body["messages"][0]["content"].startswith("0123456789"):
                self.calls.append("probe")
                if self.rejects_overflow:
                    return httpx.Response(400, text=OVERFLOW_400 % 99999)
                return httpx.Response(200, json={"message": {"content": "x"}, "prompt_eval_count": 4096})
            self.calls.append("count")
            if self.prompt_tokens > 8192:
                return httpx.Response(400, text=OVERFLOW_400 % self.prompt_tokens)
            return httpx.Response(200, json={"message": {"content": "x"}, "prompt_eval_count": self.prompt_tokens})
        self.calls.append("chat")
        return self.final


BIG = [ChatMessage("user", "x" * 7000)]


def test_every_request_is_measured_by_the_server_before_sending():
    rec = Recorder()
    assert run(rec_provider(rec).generate(MESSAGES)) == "answer"
    assert rec.calls == ["probe", "count", "chat"]


def test_custom_template_overhead_cannot_bypass_the_reply_budget():
    """Codex scenario: a tiny prompt (10 bytes) whose server-side template inflates it past the budget."""
    tiny = [ChatMessage("user", "hi")]
    for tokens in (7000, 6145):  # > 8192 - 2048 reserved; a byte-length estimate would call this ~tiny
        rec = Recorder(prompt_tokens=tokens)
        with pytest.raises(LLMContextTooLarge) as exc:
            run(rec_provider(rec).generate(tiny))
        assert f"{tokens} tokens" in exc.value.message
        assert "chat" not in rec.calls  # never sent to the model
    assert run(rec_provider(Recorder(prompt_tokens=6144)).generate(tiny)) == "answer"


def test_large_request_that_fits_is_counted_then_sent():
    rec = Recorder(prompt_tokens=4200)
    assert run(rec_provider(rec).generate(BIG)) == "answer"
    assert rec.calls == ["probe", "count", "chat"]


def test_overflow_rejection_is_verified_only_once():
    rec = Recorder(prompt_tokens=4200)
    p = rec_provider(rec)
    run(p.generate(BIG))
    run(p.generate(BIG))
    assert rec.calls.count("probe") == 1 and rec.calls.count("count") == 2


def test_request_larger_than_window_is_refused_with_clear_error():
    rec = Recorder(prompt_tokens=12000)
    with pytest.raises(LLMContextTooLarge) as exc:
        run(rec_provider(rec).generate(BIG))
    assert "12000 tokens" in exc.value.message and "6144" in exc.value.message and "2048 reserved" in exc.value.message
    assert "chat" not in rec.calls


def test_prompt_that_fits_window_but_not_with_reply_allowance_is_refused():
    rec = Recorder(prompt_tokens=7000)  # < 8192 window, but 7000 + 2048 reply > 8192
    with pytest.raises(LLMContextTooLarge):
        run(rec_provider(rec).generate(BIG))
    assert "chat" not in rec.calls


def test_exact_boundary_fits():
    assert run(rec_provider(Recorder(prompt_tokens=6144)).generate(BIG)) == "answer"
    with pytest.raises(LLMContextTooLarge):
        run(rec_provider(Recorder(prompt_tokens=6145)).generate(BIG))


def test_server_that_does_not_reject_oversized_prompts_is_refused():
    rec = Recorder(rejects_overflow=False)
    with pytest.raises(LLMBadResponse, match="does not reject oversized prompts"):
        run(rec_provider(rec).generate(BIG))
    assert rec.calls == ["probe"]  # nothing containing user code was sent


def test_model_window_caps_configured_num_ctx():
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"message": {"content": "ok"}})

    show = httpx.Response(200, json={"model_info": {"llama.context_length": 4096}})
    run(provider(handler, show=show).generate(MESSAGES))
    assert seen["options"]["num_ctx"] == 4096


def test_show_failure_falls_back_to_configured_window_and_404_means_model_missing():
    def ok(_):
        return httpx.Response(200, json={"message": {"content": "ok"}})

    assert run(provider(ok, show=httpx.Response(500)).generate(MESSAGES)) == "ok"
    with pytest.raises(LLMModelNotFound):
        run(provider(ok, show=httpx.Response(404)).generate(MESSAGES))


def test_server_side_overflow_error_on_final_call_is_mapped():
    final = httpx.Response(400, text=OVERFLOW_400 % 9000)
    with pytest.raises(LLMContextTooLarge):
        run(rec_provider(Recorder(final=final)).generate(MESSAGES))


def test_reply_cut_off_by_token_limit_is_flagged_not_silent():
    final = httpx.Response(200, json={"message": {"content": "partial"}, "done_reason": "length"})
    reply = run(rec_provider(Recorder(final=final)).generate(MESSAGES))
    assert reply.startswith("partial") and "cut off at the 2048-token limit" in reply
