import os
from dataclasses import dataclass
from urllib.parse import urlparse

DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:7b"
DEFAULT_LLM_TIMEOUT_S = 120.0
DEFAULT_OLLAMA_NUM_CTX = 8192
DEFAULT_MAX_RESPONSE_TOKENS = 2048
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Settings:
    ollama_url: str
    ollama_model: str
    llm_timeout_s: float
    ollama_num_ctx: int
    max_response_tokens: int


def _loopback_http_url(raw: str) -> str:
    try:
        url = urlparse(raw)
        host = url.hostname
        url.port  # raises ValueError on a bad port
    except ValueError:
        raise ConfigError(f"RISE_OLLAMA_URL is not a valid URL: {raw!r}") from None
    if url.scheme != "http":
        raise ConfigError("RISE_OLLAMA_URL must use http (loopback only).")
    if host not in LOOPBACK_HOSTS:
        raise ConfigError(f"RISE_OLLAMA_URL host {host!r} is not loopback (127.0.0.1, localhost or ::1).")
    if url.username or url.password:
        raise ConfigError("RISE_OLLAMA_URL must not contain credentials.")
    return raw.rstrip("/")


def load_settings(env: dict[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    try:
        timeout = float(env.get("RISE_LLM_TIMEOUT_S") or DEFAULT_LLM_TIMEOUT_S)
    except ValueError:
        raise ConfigError("RISE_LLM_TIMEOUT_S must be a number.") from None
    if not 0 < timeout <= 600:
        raise ConfigError("RISE_LLM_TIMEOUT_S must be between 0 and 600.")
    try:
        num_ctx = int(env.get("RISE_OLLAMA_NUM_CTX") or DEFAULT_OLLAMA_NUM_CTX)
    except ValueError:
        raise ConfigError("RISE_OLLAMA_NUM_CTX must be an integer.") from None
    if not 512 <= num_ctx <= 131072:
        raise ConfigError("RISE_OLLAMA_NUM_CTX must be between 512 and 131072.")
    try:
        max_response = int(env.get("RISE_MAX_RESPONSE_TOKENS") or DEFAULT_MAX_RESPONSE_TOKENS)
    except ValueError:
        raise ConfigError("RISE_MAX_RESPONSE_TOKENS must be an integer.") from None
    if not 16 <= max_response <= num_ctx // 2:
        raise ConfigError("RISE_MAX_RESPONSE_TOKENS must be between 16 and half of RISE_OLLAMA_NUM_CTX.")
    return Settings(
        ollama_url=_loopback_http_url(env.get("RISE_OLLAMA_URL") or DEFAULT_OLLAMA_URL),
        ollama_model=env.get("RISE_OLLAMA_MODEL") or DEFAULT_OLLAMA_MODEL,
        llm_timeout_s=timeout,
        ollama_num_ctx=num_ctx,
        max_response_tokens=max_response,
    )
