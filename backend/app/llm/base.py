from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class ModelInfo:
    """What the backend is configured to use. Says nothing about whether the model is loaded or healthy."""

    provider: str
    model: str


class LLMProvider(Protocol):
    """Provider-neutral chat interface. Implementations hide all wire-format details."""

    async def generate(self, messages: list[ChatMessage]) -> str: ...

    def model_info(self) -> ModelInfo:
        """Configured provider and model name. Must not contact the model server."""
        ...


class LLMError(Exception):
    """Base class for provider failures. Messages must never contain prompt text."""

    status_code = 502
    code = "llm_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class LLMUnavailable(LLMError):
    status_code = 503
    code = "llm_unavailable"


class LLMModelNotFound(LLMError):
    status_code = 502
    code = "llm_model_not_found"


class LLMTimeout(LLMError):
    status_code = 504
    code = "llm_timeout"


class LLMBadResponse(LLMError):
    status_code = 502
    code = "llm_bad_response"


class LLMContextTooLarge(LLMError):
    status_code = 422
    code = "context_too_large"
