"""Ollama adapter. All Ollama-specific request/response formats live in this file.

Context-window safety: Ollama silently drops the start of a prompt that exceeds the window unless
asked not to. The adapter therefore sends truncate=false and shift=false (the server then rejects
oversized requests), and checks up front, with the server's own token count, that prompt tokens
+ reply allowance fit the window. Nothing is estimated: the template (and so its overhead) is the
server's.
"""
import asyncio
import re

import httpx

from .base import (
    ChatMessage,
    LLMBadResponse,
    LLMContextTooLarge,
    LLMModelNotFound,
    LLMTimeout,
    LLMUnavailable,
    ModelInfo,
)

CONNECT_TIMEOUT_S = 3.0
_OVERFLOW_RE = re.compile(r"request \((\d+) tokens\) exceeds the available context size")
CUT_OFF_NOTICE = "\n\n[Response cut off at the {n}-token limit.]"


class OllamaProvider:
    def __init__(
        self,
        base_url: str,
        model: str,
        timeout_s: float,
        num_ctx: int = 8192,
        max_response_tokens: int = 2048,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._timeout_s = timeout_s
        self._num_ctx = num_ctx
        self._max_response = max_response_tokens
        self._transport = transport
        self._window: int | None = None  # min(configured num_ctx, model's own limit)
        self._overflow_rejection_verified = False

    def model_info(self) -> ModelInfo:
        return ModelInfo(provider="Ollama", model=self._model)

    async def generate(self, messages: list[ChatMessage]) -> str:
        wire = [{"role": m.role, "content": m.content} for m in messages]
        try:
            # asyncio.timeout bounds the whole exchange; httpx timeouts only bound each socket operation.
            async with asyncio.timeout(self._timeout_s):
                async with httpx.AsyncClient(
                    transport=self._transport,
                    timeout=httpx.Timeout(self._timeout_s, connect=CONNECT_TIMEOUT_S),
                    trust_env=False,  # never route prompts through HTTP(S)_PROXY/ALL_PROXY from the environment
                ) as client:
                    window = await self._window_size(client)
                    await self._ensure_fits(client, wire, window)
                    return await self._chat(client, wire, window)
        except (httpx.ConnectError, httpx.ConnectTimeout):
            raise LLMUnavailable(f"Cannot reach Ollama at {self._base_url}. Is it running?") from None
        except (TimeoutError, httpx.TimeoutException):
            raise LLMTimeout(f"Ollama did not respond within {self._timeout_s:g} s.") from None
        except httpx.TransportError:
            raise LLMUnavailable(f"Connection to Ollama at {self._base_url} failed.") from None

    # -- requests -----------------------------------------------------------------------------

    def _payload(self, wire: list[dict], window: int, num_predict: int) -> dict:
        return {
            "model": self._model,
            "messages": wire,
            "stream": False,
            "truncate": False,
            "shift": False,
            "options": {"num_ctx": window, "num_predict": num_predict},
        }

    def _not_found(self) -> LLMModelNotFound:
        return LLMModelNotFound(
            f"Model '{self._model}' was not found in Ollama. Check `ollama list`; "
            "this application does not download models."
        )

    def _too_large(self, tokens: int | None, window: int) -> LLMContextTooLarge:
        budget = window - self._max_response
        need = f"needs {tokens} tokens" if tokens is not None else "is too large"
        return LLMContextTooLarge(
            f"The request {need} but only {budget} fit (model window {window}, "
            f"{self._max_response} reserved for the reply). Select less code or ask without editor context."
        )

    async def _window_size(self, client: httpx.AsyncClient) -> int:
        if self._window is None:
            response = await client.post(f"{self._base_url}/api/show", json={"model": self._model})
            if response.status_code == 404:
                raise self._not_found()
            limit = None
            if response.status_code == 200:
                try:
                    info = response.json().get("model_info", {})
                    limit = next(
                        (v for k, v in info.items() if k.endswith(".context_length") and isinstance(v, int)), None
                    )
                except (ValueError, AttributeError):
                    pass
            self._window = min(self._num_ctx, limit) if limit else self._num_ctx
        return self._window

    async def _ensure_fits(self, client: httpx.AsyncClient, wire: list[dict], window: int) -> None:
        budget = window - self._max_response
        if not self._overflow_rejection_verified:
            await self._verify_overflow_rejection(client, window)
        tokens = await self._count_tokens(client, wire, window)
        if tokens > budget:
            raise self._too_large(tokens, window)

    async def _verify_overflow_rejection(self, client: httpx.AsyncClient, window: int) -> None:
        """Confirm the server really rejects oversized prompts instead of silently truncating them."""
        probe = [{"role": "user", "content": "0123456789" * (window // 2)}]  # >= window tokens for any tokenizer
        response = await client.post(
            f"{self._base_url}/api/chat", json=self._payload(probe, window, num_predict=1)
        )
        if response.status_code == 400 and _OVERFLOW_RE.search(response.text):
            self._overflow_rejection_verified = True
            return
        raise LLMBadResponse(
            "This Ollama server does not reject oversized prompts (it may truncate them silently), "
            "so code context cannot be sent safely. Update Ollama."
        )

    async def _count_tokens(self, client: httpx.AsyncClient, wire: list[dict], window: int) -> int:
        """Exact prompt size as measured by the server; the reply to this call is discarded."""
        response = await client.post(
            f"{self._base_url}/api/chat", json=self._payload(wire, window, num_predict=1)
        )
        if response.status_code == 400:
            match = _OVERFLOW_RE.search(response.text)
            if match:
                raise self._too_large(int(match.group(1)), window)
        if response.status_code == 404:
            raise self._not_found()
        if response.status_code != 200:
            raise LLMBadResponse(f"Ollama returned HTTP {response.status_code}.")
        try:
            count = response.json()["prompt_eval_count"]
        except (ValueError, KeyError, TypeError):
            raise LLMBadResponse("Ollama did not report a prompt size.") from None
        if not isinstance(count, int):
            raise LLMBadResponse("Ollama did not report a prompt size.")
        return count

    async def _chat(self, client: httpx.AsyncClient, wire: list[dict], window: int) -> str:
        response = await client.post(
            f"{self._base_url}/api/chat", json=self._payload(wire, window, self._max_response)
        )
        if response.status_code == 400 and _OVERFLOW_RE.search(response.text):
            raise self._too_large(int(_OVERFLOW_RE.search(response.text).group(1)), window)
        if response.status_code == 404:
            raise self._not_found()
        if response.status_code != 200:
            raise LLMBadResponse(f"Ollama returned HTTP {response.status_code}.")

        try:
            data = response.json()
            content = data["message"]["content"]
        except (ValueError, KeyError, TypeError):
            raise LLMBadResponse("Ollama returned a malformed response.") from None
        if not isinstance(content, str) or not content.strip():
            raise LLMBadResponse("Ollama returned an empty reply.")
        if data.get("done_reason") == "length":
            content += CUT_OFF_NOTICE.format(n=self._max_response)
        return content
