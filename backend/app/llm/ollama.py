"""Ollama adapter. All Ollama-specific request/response formats live in this file."""
import asyncio

import httpx

from .base import (
    ChatMessage,
    LLMBadResponse,
    LLMModelNotFound,
    LLMTimeout,
    LLMUnavailable,
)

CONNECT_TIMEOUT_S = 3.0


class OllamaProvider:
    def __init__(
        self,
        base_url: str,
        model: str,
        timeout_s: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._timeout_s = timeout_s
        self._transport = transport

    async def generate(self, messages: list[ChatMessage]) -> str:
        payload = {
            "model": self._model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": False,
        }
        try:
            # asyncio.timeout bounds the whole exchange; httpx timeouts only bound each socket operation.
            async with asyncio.timeout(self._timeout_s):
                async with httpx.AsyncClient(
                    transport=self._transport,
                    timeout=httpx.Timeout(self._timeout_s, connect=CONNECT_TIMEOUT_S),
                    trust_env=False,  # never route prompts through HTTP(S)_PROXY/ALL_PROXY from the environment
                ) as client:
                    response = await client.post(f"{self._base_url}/api/chat", json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout):
            raise LLMUnavailable(f"Cannot reach Ollama at {self._base_url}. Is it running?") from None
        except (TimeoutError, httpx.TimeoutException):
            raise LLMTimeout(f"Ollama did not respond within {self._timeout_s:g} s.") from None
        except httpx.TransportError:
            raise LLMUnavailable(f"Connection to Ollama at {self._base_url} failed.") from None

        if response.status_code == 404:
            raise LLMModelNotFound(
                f"Model '{self._model}' was not found in Ollama. Check `ollama list`; "
                "this application does not download models."
            )
        if response.status_code != 200:
            raise LLMBadResponse(f"Ollama returned HTTP {response.status_code}.")

        try:
            content = response.json()["message"]["content"]
        except (ValueError, KeyError, TypeError):
            raise LLMBadResponse("Ollama returned a malformed response.") from None
        if not isinstance(content, str) or not content.strip():
            raise LLMBadResponse("Ollama returned an empty reply.")
        return content
