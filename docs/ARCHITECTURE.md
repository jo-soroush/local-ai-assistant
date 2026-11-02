# Architecture

## Components
| Component | Location | Responsibility |
|---|---|---|
| Extension | `vscode-extension/src` | Chat view behind a dedicated Activity Bar icon (`WebviewViewProvider`, id `riseAssistant.chatView`); reads editor text and user-selected workspace files; posts to the backend over loopback. |
| Backend | `backend/app` | Validates requests (size, shape, relative paths), builds the prompt, returns replies and structured errors. Never opens developer files. |
| LLM adapter | `backend/app/llm` | `LLMProvider` interface; the Ollama implementation holds all Ollama wire formats, context-window checks and error mapping. |
| Ollama | external, local | Serves the installed model on loopback. |

The extension and the chat route do not know about Ollama's request format. A different local server (for example an OpenAI-compatible one, or a RISE API) would be a new `LLMProvider` implementation plus a line in `llm/factory.py`. None exists yet, and the RISE inference server is unknown.

## Request flow
1. The user types a question. Optionally: editor context (`context`) and one attached file (`tool_results[0]`).
2. Extension (`context.ts`, `workspace.ts`) checks and reads the text, then `client.ts` sends `POST /v1/chat` to the configured loopback URL (redirects refused).
3. Backend (`schemas.py`) validates; `prompt.py` places each piece in its own fenced block under a system note saying it is data, not instructions.
4. The Ollama adapter measures the prompt against the context window and refuses instead of truncating, then calls Ollama (`trust_env=False`, so proxy variables are ignored).
5. The reply returns as `{request_id, reply}`; errors as `{error:{code,message}, request_id}`.

## Workspace tools (C05)
`search_files` (names only) and `read_file` run **in the extension**, started by the user's "Attach workspace file…" click. The protocol is a typed request/result pair inside the extension; only a successful `read_file` result (`tool_results`, max 1) crosses to the backend.

Controls: workspace-relative paths only, real-path containment (symlink and `..` escapes refused), refusal of secret/credential files and `.git`/`.aws`, binary, non-UTF-8, empty and oversized files (64 KiB on disk, 16,000 characters), no special files, descriptor-identity checks against file swaps, and an attachment bound to the workspace and file selected. No write, edit or shell capability exists anywhere in the code.

## Trust boundaries
- Everything runs on one machine; only loopback addresses are accepted for the backend and Ollama URLs.
- The backend port is not authenticated. Any local process can call it.
- File and editor text is untrusted input to the model; the model has no tools, so the worst effect of injected text is a misleading answer.
