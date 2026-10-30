# RISE Local AI Assistant — Backend (C02)

FastAPI backend. Chat replies are **deterministic placeholders**; no model is called. Binds to loopback only.

## Setup
```bash
cd backend
python3.13 -m venv .venv          # already present in this repo
.venv/bin/python -m pip install -r requirements-dev.txt
```

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
- `POST /v1/chat` `{"message": "<1..4000 chars, not blank>"}` -> `{"request_id","reply"}`
- Errors: `{"error":{"code","message"},"request_id"}` with 404/405/413/422/500. Every response carries `X-Request-ID`.
- Body guard: requests declaring a `Content-Length` over 64 KiB get 413 (chunked bodies are bounded only by the 4000-char field limit).

## Test
```bash
cd backend && .venv/bin/python -m pytest
```
