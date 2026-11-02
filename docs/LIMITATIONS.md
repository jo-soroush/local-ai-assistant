# Known limitations and residual risks

This is a prototype, **not production ready** and **not an approved RISE deployment**.

## Not implemented
- Model-driven tool calling, an agent loop, code edits, a terminal tool, a test runner.
- RAG, embeddings, fine-tuning, streaming, cancellation, queueing, concurrent users.
- Any inference backend other than Ollama (OpenAI-compatible and RISE adapters are deferred).
- Model tool-calling reliability for `qwen2.5-coder:7b` was never evaluated.

## Security
- The backend has no authentication or TLS and trusts anything that reaches `127.0.0.1:8765`. Other local processes or users on the machine can use it. It must not be bound to a network interface.
- Secret detection is by file name and private-key text only; it is not a secret scanner. Other secrets inside ordinary files can be attached and sent to the local model.
- **File-read race:** Node has no `openat()`. The extension opens with `O_NOFOLLOW`/`O_NONBLOCK` and checks that the opened file is the validated one both after opening and after reading, but an attacker with write access to the workspace who can switch the filesystem several times in a precise order may still win. A Linux `/proc/self/fd` check was not added.
- Prompt injection is mitigated (fenced data blocks, a system note) but not eliminated; a hostile file can make the answer wrong.
- The backend logs only LLM error codes and request IDs, never prompt text (the only application log call is in `main.py`); uvicorn's access log records request lines, not bodies. No log retention or review policy exists.

## Functional
- Only tested on one macOS machine. Windows and Linux are untested.
- One attached file and one editor selection or file per message, 16,000 characters each; larger content is refused, never trimmed.
- File search is by name only, up to 50 results (500 candidates examined first).
- The long default timeout (130 s) means a stuck model leaves the chat view waiting.
- Answer quality with a 7B model is untested beyond the demos listed in VERIFICATION.md.
- No automated GUI test; the webview and `extension.ts` wiring depend on manual checks.

## Deferred decisions (from the roadmap)
RISE inference backend (Ollama vs vLLM vs other); OpenAI-compatible adapter; RAG; fine-tuning; streaming and cancellation; edits, tests, terminal and agent loop; production authentication, transport security and host isolation.
