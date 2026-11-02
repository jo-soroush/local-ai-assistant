# RISE Local AI Assistant — Backend

FastAPI backend. `/v1/chat` returns real replies from a **local Ollama model** through a provider-neutral adapter (`app/llm/`). Binds to loopback only. No cloud inference.

## Setup
Full step-by-step instructions (Ollama, model, install, checks) are in the [root README](../README.md). In short, from the repository root:
```bash
cd backend
python3.13 -m venv .venv          # creates a fresh environment (it is not stored in git)
.venv/bin/python -m pip install -r requirements-dev.txt
```

## Ollama prerequisites
The application never downloads models. Before using the backend, make sure Ollama is running and the model exists:
```bash
ollama list                                   # model must appear, e.g. qwen2.5-coder:7b
curl http://127.0.0.1:11434/api/tags          # same check via the API
```
Configuration (environment variables, read at startup; the Ollama URL must be an `http` loopback URL):

| Variable | Default |
|---|---|
| `RISE_OLLAMA_URL` | `http://127.0.0.1:11434` |
| `RISE_OLLAMA_MODEL` | `qwen2.5-coder:7b` |
| `RISE_LLM_TIMEOUT_S` | `120` |
| `RISE_OLLAMA_NUM_CTX` | `8192` (capped at the model's own limit from `/api/show`) |
| `RISE_MAX_RESPONSE_TOKENS` | `2048` (reserved for the reply; must be <= half of `RISE_OLLAMA_NUM_CTX`) |

## Run (127.0.0.1:8765)
```bash
cd backend
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```
Stop with Ctrl+C. Do not bind to `0.0.0.0`.

## Check
```bash
curl http://127.0.0.1:8765/health
curl -X POST http://127.0.0.1:8765/v1/chat -H 'Content-Type: application/json' -d '{"message":"hi"}'
```

## API
- `GET /health` -> `{"status":"ok"}`
- `GET /v1/model-info` -> `{"provider":"Ollama","model":"<RISE_OLLAMA_MODEL>"}`: the configured provider and model name, read from the backend's settings. It does not contact Ollama, so it does not show that the model is installed, loaded or healthy. The extension shows it at the top of the chat.
- `POST /v1/chat` `{"message": "<1..4000 chars, not blank>"}` -> `{"request_id","reply"}` (model-generated)
- Optional `context` on `/v1/chat`: `{kind: selection|file, path (workspace-relative), language?, start_line, end_line, text (<=16,000 chars)}`. The path is display metadata only; the backend never opens files. Code is passed to the model in a fenced block marked as data.
- Optional `tool_results` on `/v1/chat` (max 1 item): `{tool: "read_file", path (workspace-relative), start_line, end_line, text (<=16,000 chars)}`. The extension reads the file the user picked; the backend never opens the path and the text is passed to the model in a fenced block marked as data. Tool use is user-initiated, not model-driven.
- Context budget: the adapter sends `truncate=false`/`shift=false` so Ollama refuses instead of silently dropping the start of a prompt, and checks that system prompt + question + code + reply allowance fit. Every request is measured by the server: the adapter asks Ollama for the exact prompt-token count (including whatever chat template the model applies), with no byte-length shortcut. The reply allowance (`RISE_MAX_RESPONSE_TOKENS`) is reserved out of the window, so the prompt must fit in `window - allowance`. A request that does not fit is rejected with 422 `context_too_large` before normal generation starts, and is never truncated. Before the first request the adapter probes once that the server really rejects oversized prompts, and refuses to send anything if it does not. This costs one extra short server call per request (the token count). A reply that hits the token limit is marked `[Response cut off ...]`.
- LLM errors: 503 `llm_unavailable`, 502 `llm_model_not_found` / `llm_bad_response`, 504 `llm_timeout`. `/health` does not check Ollama.
- Errors: `{"error":{"code","message"},"request_id"}` with 404/405/413/422/500. Every response carries `X-Request-ID`.
- Body guard: bodies over 256 KiB (counted on received bytes, including chunked) get 413.

## Test
```bash
cd backend && .venv/bin/python -m pytest
```
