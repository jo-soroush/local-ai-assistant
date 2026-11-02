# RISE Local AI Coding Assistant (prototype)

A small AI coding assistant that runs **entirely on your own Mac**. It has three parts:

- a **VS Code extension** (the chat window you use),
- a **backend** (a small FastAPI program you start in a terminal),
- **Ollama** (runs the AI model locally).

Nothing is sent to the cloud. There is no cloud inference and no fallback to one.

> **Prototype only.** This is a learning prototype. It is **not production ready** and **not approved for deployment** at RISE. It has no login and no encryption, and is meant for one developer on one machine. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md). The final RISE model and inference server have not been decided.

## What it does
- **Ask** a coding question in the **RISE Assistant** chat view and get an answer from a local model.
- **Editor context:** optionally send your current selection (or the whole open file) with the question. The chat shows what will be sent before you send it.
- **Attach a workspace file:** optionally pick one file from the open folder to send with the question.
- **Model and Provider display:** the top of the chat shows which model the backend is configured to use.

It cannot edit files or run commands. The model never chooses what to read; you do.

```
VS Code extension ──(HTTP, this Mac only)──▶ Backend (FastAPI) ──▶ Ollama (this Mac only)
```
More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 1. Prerequisites

| You need | Version | Notes |
|---|---|---|
| macOS | — | The only system this has been run on. Windows and Linux are untested. |
| [VS Code](https://code.visualstudio.com) | 1.141.0 or newer (below 2.0) | Required by the extension (`engines.vscode`). |
| `code` command in your terminal | — | In VS Code: Command Palette → **Shell Command: Install 'code' command in PATH**. |
| Python | 3.13 | Developed and tested with 3.13.12. Other versions have not been tried. |
| Node.js and npm | Node 24 tested | Used only to build the extension. The minimum version has not been checked. |
| [Ollama](https://ollama.com) | recent | Runs the model. |
| Free disk space | several GB | For the model download. |

Internet is needed only for setup (cloning, installing packages, downloading the model). Once set up, the assistant works without sending anything outside your Mac.

Check what you have:
```bash
code --version
python3.13 --version
node --version && npm --version
git --version
```

## 2. Get the code
Replace the placeholder with the repository URL your team gives you:
```bash
git clone <REPOSITORY_URL> rise-local-ai-assistant
cd rise-local-ai-assistant
```
All commands below start from this folder (the **repository root**), unless stated otherwise.

## 3. Install Ollama and the model
1. Install Ollama from [ollama.com](https://ollama.com), or with Homebrew: `brew install ollama`.
2. Start it. The Ollama app starts the server for you when opened. If you installed only the command line tool, run this in its own terminal window and leave it open:
   ```bash
   ollama serve
   ```
   (If it says the address is already in use, Ollama is already running. That is fine.)
3. Download the model (several GB, once only):
   ```bash
   ollama pull qwen2.5-coder:7b
   ```
4. Check that Ollama is running and the model is installed:
   ```bash
   ollama list
   curl http://127.0.0.1:11434/api/tags
   ```
   `qwen2.5-coder:7b` must appear in both outputs. If `curl` cannot connect, Ollama is not running.

The application never downloads models by itself.

## 4. Set up the backend (once)
Create a fresh virtual environment and install the dependencies:
```bash
cd backend
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
cd ..
```
`requirements-dev.txt` includes the runtime packages (`fastapi`, `uvicorn`, `httpx`) plus `pytest` for the tests. You do not need to "activate" the environment; the commands below call it directly.

## 5. Start the backend
Working directory: the `backend` folder inside the repository. Run:
```bash
cd backend
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```
Leave this terminal open. The backend is running while you see `Uvicorn running on http://127.0.0.1:8765`. Always keep `--host 127.0.0.1`; never use `0.0.0.0`.

Check it from a **second** terminal:
```bash
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/v1/model-info
```
Expected:
```json
{"status":"ok"}
{"provider":"Ollama","model":"qwen2.5-coder:7b"}
```
- `/health` only says the backend itself is up. It does not check Ollama.
- `/v1/model-info` only repeats the backend's **configuration**. It does not contact Ollama, so it does not prove the model is installed or working.

## 6. Build and install the extension (once, then after updates)
From the repository root:
```bash
cd vscode-extension
npm install
npm run compile
npx --yes @vscode/vsce@3 package --no-dependencies --allow-missing-repository
code --install-extension rise-local-ai-assistant-0.0.1.vsix
```
This builds the file `rise-local-ai-assistant-0.0.1.vsix` and installs it in your normal VS Code. (`vsce` is downloaded temporarily by `npx`; it is not a project dependency.)

Then, in VS Code, open the Command Palette (**Cmd+Shift+P**) and run **Developer: Reload Window**. This restarts the VS Code window so it loads the newly installed extension. If you had no VS Code window open when you installed, just open one.

Confirm the install:
```bash
code --list-extensions --show-versions | grep rise
```
You should see `local.rise-local-ai-assistant@0.0.1`.

## 7. Use the assistant
1. Make sure Ollama and the backend are running (see "Every time" below).
2. In VS Code, open a **folder** (File → Open Folder…) containing the code you want to ask about.
3. Find the **RISE Assistant** icon in the **Activity Bar**, the vertical icon strip at the far left edge of the window. Click it to open the **Chat** view. If you cannot see it, see Troubleshooting. You can also run **RISE Assistant: Ask** from the Command Palette, which only reveals the chat view.
4. Look at the top of the chat. It shows `Model:` and `Provider:` (see below).
5. Type a question and click **Send** (or press **Cmd+Enter**). The first reply can be slow while the model loads.

**Using editor context.** The checkbox **Include editor context** is on by default.
- If you have text selected in an open editor, that selection is sent. If nothing is selected, the whole file is sent.
- Only **saved** files inside the open folder qualify, up to 16,000 characters. Nothing is cut off silently.
- Files that look secret (for example `.env`, `*.pem`, `*.key`, SSH keys) are refused.
- A line in the chat shows exactly what will be sent.
- To ask a general question with no code, **untick** the checkbox.

**Attaching a file.** Click **Attach workspace file…**, type part of a file name, pick the file, then ask. One file per message. Click **Remove** to detach it. Details and limits: [vscode-extension/README.md](vscode-extension/README.md).

**What Model and Provider mean.** The top of the chat shows, for example, `Model: qwen2.5-coder:7b` and `Provider: Ollama`. These are the **backend's configured settings**, not a health check. They do **not** confirm that Ollama is running or that the model is installed. They are read when the chat view opens or is shown again, and after a failed question. `Backend offline` means the extension could not reach the backend at all.

### Every time you want to use the assistant
1. **Ollama is running** (open the Ollama app, or `ollama serve`).
2. **Start the backend** (section 5) and keep its terminal open.
3. **Open VS Code** and click the RISE Assistant icon.

The extension does not start Ollama or the backend for you. The extension stays installed between sessions; you do not rebuild it.

## 8. Stop, restart, update, uninstall

**Stop the backend.** Click its terminal and press **Ctrl+C**. To check nothing is left running: `lsof -iTCP:8765 -sTCP:LISTEN` (no output means it has stopped). Ollama keeps running until you quit it from its menu bar icon (or press Ctrl+C in the `ollama serve` terminal).

**Restart the backend.** Stop it as above, then run the start command from section 5 again. Do this after changing any `RISE_…` setting.

**Update the installed extension.** Starting in the repository root, get the new code, rebuild, and reinstall:
```bash
git pull
cd vscode-extension
npm install
npm run compile
npx --yes @vscode/vsce@3 package --no-dependencies --allow-missing-repository
code --install-extension rise-local-ai-assistant-0.0.1.vsix --force
cd ..
```
(`cd ..` returns the terminal to the repository root.) Then run **Developer: Reload Window**. If the backend code changed, also update its packages and restart it:
```bash
cd backend
.venv/bin/python -m pip install -r requirements-dev.txt
cd ..
```
The installed extension is a snapshot: code changes only appear after you rebuild and reinstall.

**Uninstall the extension.**
```bash
code --uninstall-extension local.rise-local-ai-assistant
```
Then run **Developer: Reload Window**. To remove everything else, delete the cloned folder and (optionally) the model with `ollama rm qwen2.5-coder:7b`.

## 9. Troubleshooting

**The chat shows "Backend offline".**
The backend is not running or not reachable. Start it (section 5) and check `curl http://127.0.0.1:8765/health`. Then close and reopen the chat view (or click away and back) to refresh. If you started it on a different port, set `riseAssistant.backendUrl` in VS Code settings to match.

**Error mentioning "Cannot reach Ollama".**
The backend is running but Ollama is not. Open the Ollama app or run `ollama serve`, then check `curl http://127.0.0.1:11434/api/tags`. Try your question again; no backend restart is needed.

**Error "Model … was not found in Ollama".**
The model is not downloaded. Run `ollama pull qwen2.5-coder:7b`, then `ollama list` to confirm it is listed. Try again.

**The RISE Assistant icon is missing.**
1. Confirm the install: `code --list-extensions --show-versions | grep rise`. If nothing is printed, repeat section 6.
2. Run **Developer: Reload Window**.
3. The icon may be hidden: right-click the Activity Bar and tick **RISE Assistant**, or run **RISE Assistant: Ask** from the Command Palette.
4. Make sure you installed into the same VS Code that you are looking at, and that it is version 1.141.0 or newer.

**"Context unavailable", or a file or attachment is rejected.**
The question is not sent, and the chat gives the reason. Common causes: the file is not saved; it is outside the open folder; it is over 16,000 characters (select a smaller part); it is a protected or secret-looking file; or no folder is open. Untick **Include editor context** to ask without code. An attached file that fails to read stays attached until you click **Remove** or attach it again. A message that the request is too large means: select less code or ask without context.

**The Model line shows a wrong model name.**
The name comes from the backend's `RISE_OLLAMA_MODEL` setting. Stop the backend and restart it with the model you want (it must already be in `ollama list`):
```bash
cd backend
RISE_OLLAMA_MODEL="qwen2.5-coder:7b" .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```
Then reopen the chat view and check `curl http://127.0.0.1:8765/v1/model-info`.

## 10. Configuration
Defaults work without any changes.

| Setting | Default | Where |
|---|---|---|
| `riseAssistant.backendUrl` | `http://127.0.0.1:8765` (http, this Mac only) | VS Code settings |
| `riseAssistant.requestTimeoutMs` | `130000` (1000–180000) | VS Code settings |
| `RISE_OLLAMA_URL` | `http://127.0.0.1:11434` (http, this Mac only) | backend environment |
| `RISE_OLLAMA_MODEL` | `qwen2.5-coder:7b` | backend environment |
| `RISE_LLM_TIMEOUT_S` | `120` | backend environment |
| `RISE_OLLAMA_NUM_CTX` | `8192` (capped at the model's limit) | backend environment |
| `RISE_MAX_RESPONSE_TOKENS` | `2048` (at most half of `RISE_OLLAMA_NUM_CTX`) | backend environment |

Both URLs must be `http` loopback addresses (127.0.0.1, localhost or ::1); anything else is rejected.

---

## Developer section

Only needed if you are changing the code. Everyday users should use the installed extension above.

### Run with F5 (Extension Development Host)
1. Start Ollama and the backend (sections 3–5).
2. Open the repository root in VS Code, run `npm install` and `npm run compile` in `vscode-extension` once, then press **F5** and choose "Run RISE Assistant Extension". A second window opens on the `dev-workspace/` folder.
3. In that window, click the RISE Assistant icon and open `sample.py` (or untick **Include editor context**).
4. Stop with Shift+F5 in the original window, then Ctrl+C in the backend terminal.

While the VSIX is also installed, F5 still runs the development copy inside the second window.

### Tests
From the repository root:
```bash
(cd backend && .venv/bin/python -m pytest -q)
(cd vscode-extension && npm run typecheck && npm test)
```
Some tests open local sockets. In a restricted sandbox that forbids this they fail with `EPERM`/`PermissionError`; run them in a normal terminal. Recorded results: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## More
- [backend/README.md](backend/README.md): API reference and error codes.
- [vscode-extension/README.md](vscode-extension/README.md): extension features, context and file rules, developer notes.
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md): known limitations and risks.
