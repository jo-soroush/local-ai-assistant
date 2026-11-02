# RISE Local AI Coding Assistant (prototype)

A small, fully local AI coding assistant for VS Code: a TypeScript extension, a FastAPI backend and a local Ollama model. It is a **learning prototype**.

> **Not production ready.** It is not an approved RISE deployment, has no authentication or TLS, and is for one developer on one machine. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md). The final RISE model and inference server are not assumed.

## What it does
- **Ask** a coding question in the **RISE Assistant** chat view (its own Activity Bar icon, inside the normal VS Code window) and get a reply from a local Ollama model.
- **Editor context:** optionally send the current selection, or the whole active file, with the question. What will be sent is shown before sending.
- **Workspace file:** optionally attach one file you pick from the open workspace. Search and read are done by the extension at your request.

Tools are **user-driven**, not model-driven: the model is never given tools and decides nothing about what is read. This is not an autonomous agent.

## Prerequisites
- macOS developer machine (the only platform it has been run on).
- VS Code `^1.141.0` (>=1.141.0 and <2.0.0), Node.js and npm, Python 3.13.
- [Ollama](https://ollama.com) running locally with a model already pulled, e.g. `qwen2.5-coder:7b`. The application never downloads models.

## Architecture
```
VS Code extension (TypeScript) ── HTTP, loopback ──▶ FastAPI backend ──▶ LLM adapter ──▶ Ollama (loopback)
  reads editor / workspace files                       validates, builds prompt          model-specific code lives here
```
The backend never opens developer files; it receives text the extension chose to send. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Setup
```bash
# backend
cd backend
python3.13 -m venv .venv                       # skip if .venv exists
.venv/bin/python -m pip install -r requirements-dev.txt

# extension
cd ../vscode-extension
npm install
npm run compile
```

## Run
1. Check Ollama and the model: `ollama list` (the model must be listed).
2. Start the backend (loopback only):
   ```bash
   cd backend
   .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
   ```
   Check: `curl http://127.0.0.1:8765/health` → `{"status":"ok"}`.
3. Open the repository root in VS Code and press **F5** ("Run RISE Assistant Extension"). A second window opens on `dev-workspace/`.
4. In that window click the **RISE Assistant** icon in the Activity Bar. If the view is hidden, run **RISE Assistant: Ask** from the Command Palette: it only focuses/reveals the view and never opens an editor tab. (To keep the chat on the right, drag the icon to the Secondary Side Bar or set `workbench.sideBar.location` to `right`.)
5. Before asking, open `sample.py` in `dev-workspace/`, or turn off **Include editor context** in the chat view to ask without editor content. The checkbox is on by default; without an eligible editor, it prevents sending.

## Install as a normal VS Code extension (no F5)
F5 is for development. To use the assistant in your everyday VS Code window, build and install a local VSIX package (see [vscode-extension/README.md](vscode-extension/README.md#install-as-a-normal-extension)). Ollama and the backend must still be started yourself (steps 1–2 above); the extension does not launch them.

## Stop
Close the Extension Development Host window (or press Shift+F5 in the original window), then press Ctrl+C in the backend terminal. Ollama keeps running unless you quit it. Check for leftovers: `lsof -iTCP:8765 -sTCP:LISTEN`.

## Configuration
| Setting | Default | Where |
|---|---|---|
| `riseAssistant.backendUrl` | `http://127.0.0.1:8765` (http, loopback only) | VS Code settings |
| `riseAssistant.requestTimeoutMs` | `130000` (1000–180000) | VS Code settings |
| `RISE_OLLAMA_URL` | `http://127.0.0.1:11434` (http, loopback only) | backend environment |
| `RISE_OLLAMA_MODEL` | `qwen2.5-coder:7b` | backend environment |
| `RISE_LLM_TIMEOUT_S` | `120` | backend environment |
| `RISE_OLLAMA_NUM_CTX` | `8192` (capped at the model's limit) | backend environment |
| `RISE_MAX_RESPONSE_TOKENS` | `2048` (at most half of `NUM_CTX`) | backend environment |

## Tests
Run these together from the repository root; each subshell leaves the working directory unchanged.
```bash
(cd backend && .venv/bin/python -m pytest -q)
(cd vscode-extension && npm run typecheck && npm test)
```
Some tests start local servers or bind sockets. In a sandbox that forbids local sockets they fail with `EPERM`/`PermissionError`; run them in a normal terminal. What was run and by whom is recorded in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## More
- [backend/README.md](backend/README.md): API, errors, Ollama behaviour.
- [vscode-extension/README.md](vscode-extension/README.md): extension usage, context and file-tool rules.
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md): known limitations, risks and deferred decisions.
- Roadmap: `RISE_LOCAL_AI_ASSISTANT_6_CARDS.md`. Working rules: `AGENTS.md`, `CLAUDE.md`.
