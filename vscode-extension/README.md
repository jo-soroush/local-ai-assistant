# RISE Local AI Assistant — VS Code extension

Prototype extension: a chat view behind its own Activity Bar icon, editor context and user-attached workspace files. Not production ready and not approved for deployment (see Limitations below). Messages go to the local backend (`riseAssistant.backendUrl`, loopback only, default `http://127.0.0.1:8765`); request timeout `riseAssistant.requestTimeoutMs` defaults to 130000 ms (max 180000) to cover local model inference.

## Install and use
Installation is described once, in the repository's [root README](../README.md): install Ollama and the model, start the backend, build the VSIX, install it in your normal VS Code window and run **Developer: Reload Window**. Then click the **RISE Assistant** icon in the Activity Bar (the strip of icons at the far left of the window), or run **RISE Assistant: Ask** from the Command Palette, which only reveals the chat view. Ollama and the backend are not started by the extension; start them yourself each time (see "Every time you want to use the assistant" in the root README).

The chat log and any attached file survive hiding and re-showing the view, and replies that arrive while it is hidden are shown, in order, when it is shown again; closing the view discards them. To keep the chat on the right, drag the icon to the Secondary Side Bar or set `workbench.sideBar.location` to `right`.

**Model and Provider.** The top of the chat shows `Model:` and `Provider:` from the backend's `GET /v1/model-info`. They are the backend's *configured* values, not a health check: they do not confirm that Ollama is running or the model is installed. `Backend offline` means the extension could not reach the backend.

The package contains only `package.json`, `README.md`, `media/` and the compiled `out/*.js` (see `.vscodeignore`) and has no runtime dependencies.

## Editor context
The chat view has an **Include editor context** checkbox (on by default) and a line showing exactly what will be sent.
- Non-empty selection: the selected text. Otherwise the whole active file.
- Only saved `file:` documents inside the open workspace (symlinks resolved) are eligible. Max 16,000 characters; nothing is clipped.
- Protected names (case-insensitive): `.env`, `.env.*`, `*.pem`, `*.key`, `*.ppk`, `*.p12`, `*.pfx`, and `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, each optionally followed by `_` and any suffix. Files under `.ssh/` are blocked unless their name ends in `.pub`. Private-key text is also blocked.
- If context is requested but unusable, the question is **not** sent and the reason is shown. Uncheck the box to ask without code.

## Workspace file tools

Click **Attach workspace file…** in the chat view, type part of a file name, pick a file from the list, and ask your question. The extension runs two read-only tools **on your request**:

- `search_files` — finds file names in the open workspace (names only, max 50 results, `node_modules`, `.git`, `out`, `dist`, `.venv`, `__pycache__` skipped).
- `read_file` — reads the file you picked and sends its text with your question to the local backend.

**Tool initiation is user-driven, not model-driven.** The model is never given tools and does not decide what to read; this is not autonomous agent tool calling. The backend never opens files; it only receives the text.

Limits and refusals: one file per message, max 64 KiB on disk and 16,000 characters, UTF-8 text only. Refused: paths outside the workspace (including `..` and symlinks that resolve outside), binary files, the protected names listed under Editor context, files with private-key text, and anything under `.git`/`.aws` or named `.npmrc`/`.netrc`/`.pypirc`. The file is re-read when you send; if that fails, nothing is sent and the attachment remains until you remove or replace it. Once validation succeeds, the attachment is consumed before contacting the backend, even if that transport attempt or backend request fails; reattach the file to retry with its content. The chosen file is shown before sending and noted in the chat log. There is no write, edit or shell capability.

**Race and platform limits.** Node has no `openat()`, so a path check alone cannot stop someone with write access to the workspace from swapping a file or parent folder for a symlink between checking and opening. The read therefore opens with `O_NOFOLLOW`/`O_NONBLOCK`, then requires the opened file (device + inode) to be the file the path resolves to, both after opening and after reading; anything else returns nothing ("changed"). A residual window remains for an attacker who can flip the filesystem several times between those checks in precise order; it is not closed by this design. Special files (FIFO, device, socket) are never read. Name checks for `.ssh`, `.git`, `.aws`, `.env`, `.env.*`, the listed key names and credential files ignore case. The attachment is bound to the workspace folders and real file selected. A workspace-folder change clears it with a visible message. If its path is retargeted, send-time validation fails, nothing is sent, and the attachment remains until you remove or replace it.

## Developer notes
Only needed when changing the code.

**Build and test**
```bash
cd vscode-extension
npm install
npm run compile      # tsc -p ./
npm test             # compile + node --test
npm run typecheck
```

**Run in the Extension Development Host (F5).**
1. Open the repository root in VS Code `^1.141.0` (>=1.141.0 and <2.0.0) and start Ollama and the backend (see the root README).
2. Press **F5** and choose "Run RISE Assistant Extension" (compiles first). The new window opens on `dev-workspace/` (not the repository root, because VS Code will not open an already-open folder in a second window).
3. In the new window click the RISE Assistant icon, then open `sample.py` or untick **Include editor context**.

Set breakpoints in `src/*.ts` in the original window; source maps are generated. While the VSIX is installed, F5 still runs the development copy inside the Extension Development Host window.

**Packaging.** The VSIX commands are in the root README. `@vscode/vsce` is downloaded temporarily by `npx` and is not a dependency of this project. The installed copy is a snapshot: rebuild and reinstall after code changes. The extension ID is `local.rise-local-ai-assistant`.

## Limitations
This is a learning prototype: **not production ready** and **not an approved RISE deployment**.
- It talks only to a local backend and a local Ollama model, both on loopback. The backend has no authentication or TLS, so any local process can call it; never expose it on a network interface. The extension does not start the backend or Ollama.
- Tools are user-driven, not model-driven: there is no agent, no file editing and no terminal access.
- Secret detection is by file name and private-key text only. Other secrets inside ordinary files can be attached and sent to the local model.
- File reads have a residual race window (Node has no `openat()`), described above.
- Prompt injection from file content is mitigated, not eliminated.
- Tested on one macOS machine only; Windows and Linux are untested. Streaming, cancellation and other inference backends are not implemented.
- The installed copy is a snapshot; rebuild and reinstall after code changes.
