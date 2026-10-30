import pytest

from app.config import ConfigError, load_settings


def test_defaults():
    s = load_settings({})
    assert (s.ollama_url, s.ollama_model, s.llm_timeout_s) == (
        "http://127.0.0.1:11434",
        "qwen2.5-coder:7b",
        120.0,
    )


def test_env_overrides_and_empty_values_use_defaults():
    s = load_settings(
        {"RISE_OLLAMA_URL": "http://localhost:9999/", "RISE_OLLAMA_MODEL": "qwen3:8b", "RISE_LLM_TIMEOUT_S": "30"}
    )
    assert (s.ollama_url, s.ollama_model, s.llm_timeout_s) == ("http://localhost:9999", "qwen3:8b", 30.0)
    assert load_settings({"RISE_OLLAMA_MODEL": ""}).ollama_model == "qwen2.5-coder:7b"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com:11434",
        "http://192.168.1.5:11434",
        "http://0.0.0.0:11434",
        "http://127.0.0.1.evil.com",
        "https://127.0.0.1:11434",
        "http://u:p@127.0.0.1:11434",
        "http://127.0.0.1:notaport",
        "garbage",
    ],
)
def test_non_loopback_or_invalid_url_rejected(url):
    with pytest.raises(ConfigError):
        load_settings({"RISE_OLLAMA_URL": url})


@pytest.mark.parametrize("value", ["abc", "0", "-5", "100000"])
def test_bad_timeout_rejected(value):
    with pytest.raises(ConfigError):
        load_settings({"RISE_LLM_TIMEOUT_S": value})
