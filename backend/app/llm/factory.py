"""The only place that selects a concrete provider. Ollama is the sole implementation for now."""
from functools import lru_cache

from ..config import load_settings
from .base import LLMProvider
from .ollama import OllamaProvider


@lru_cache(maxsize=1)
def get_provider() -> LLMProvider:
    settings = load_settings()
    return OllamaProvider(settings.ollama_url, settings.ollama_model, settings.llm_timeout_s)
