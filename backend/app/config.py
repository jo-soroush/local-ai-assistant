import os
from dataclasses import dataclass
from urllib.parse import urlparse

DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:7b"
DEFAULT_LLM_TIMEOUT_S = 120.0
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Settings:
    ollama_url: str
    ollama_model: str
    llm_timeout_s: float


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
    return Settings(
        ollama_url=_loopback_http_url(env.get("RISE_OLLAMA_URL") or DEFAULT_OLLAMA_URL),
        ollama_model=env.get("RISE_OLLAMA_MODEL") or DEFAULT_OLLAMA_MODEL,
        llm_timeout_s=timeout,
    )
