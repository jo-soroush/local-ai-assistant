# RISE Local AI Assistant — Backend (C02)

FastAPI backend. `/v1/chat` returns real replies from a **local Ollama model** through a provider-neutral adapter (`app/llm/`). Binds to loopback only. No cloud inference.

## Setup
```bash
cd backend
python3.13 -m venv .venv          # already present in this repo
.venv/bin/python -m pip install -r requirements-dev.txt
```

## Ollama prerequisites
The application never downloads models. Before testing, make sure Ollama is running and the model exists:
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
- `POST /v1/chat` `{"message": "<1..4000 chars, not blank>"}` -> `{"request_id","reply"}` (model-generated)
- LLM errors: 503 `llm_unavailable`, 502 `llm_model_not_found` / `llm_bad_response`, 504 `llm_timeout`. `/health` does not check Ollama.
- Errors: `{"error":{"code","message"},"request_id"}` with 404/405/413/422/500. Every response carries `X-Request-ID`.
- Body guard: bodies over 64 KiB (counted on received bytes, including chunked) get 413.

## Test
```bash
cd backend && .venv/bin/python -m pytest
```
