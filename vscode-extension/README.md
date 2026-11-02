# RISE Local AI Assistant — VS Code extension

Prototype extension: a chat view behind its own Activity Bar icon, editor context and user-attached workspace files. Not production ready (see Limitations below). Messages go to the local backend (`riseAssistant.backendUrl`, loopback only, default `http://127.0.0.1:8765`); request timeout `riseAssistant.requestTimeoutMs` defaults to 130000 ms (max 180000) to cover local model inference.

## Build and test
```bash
cd vscode-extension
npm install
npm run compile      # tsc -p ./
npm test             # compile + node --test
```

## Run in the Extension Development Host
1. Open the repository root in VS Code `^1.141.0` (>=1.141.0 and <2.0.0) and start the backend (see the repository's root README).
2. Press **F5** and choose "Run RISE Assistant Extension" (compiles first). The new window opens on `dev-workspace/` (not the repository root, because VS Code will not open an already-open folder in a second window).
3. In the new window click the **RISE Assistant** icon in the Activity Bar. If the view is hidden, run **RISE Assistant: Ask** from the Command Palette; it focuses the view (no editor tab opens). The chat log and any attached file survive hiding and re-showing the view, and replies that arrive while it is hidden are shown, in order, when it is shown again; closing the view discards them. To keep the chat on the right, drag the icon to the Secondary Side Bar or set `workbench.sideBar.location` to `right`.
4. Open `sample.py` in the development window, or turn off **Include editor context** to ask without editor content. The checkbox is on by default; without an eligible editor, it prevents sending.
5. Type a message and click Send (or Cmd/Ctrl+Enter). A model reply appears (backend and Ollama must be running; see the backend README in the repository).

Debug: set breakpoints in `src/*.ts` in the original window; source maps are generated.

## Install as a normal extension
For everyday use, without F5 or the Extension Development Host, package and install a local VSIX. `@vscode/vsce` is used only as a temporary build tool: it is downloaded by `npx` when you package and is not a dependency of this project.
```bash
cd vscode-extension
npm install                   # first time only
npm run typecheck && npm test
npm run compile
npx --yes @vscode/vsce@3 package --no-dependencies --allow-missing-repository
code --install-extension rise-local-ai-assistant-0.0.1.vsix
```
Then run **Developer: Reload Window**. Check it with `code --list-extensions --show-versions | grep local.rise` and the Extensions view ("RISE Local AI Assistant", publisher `local`); click the RISE icon in the Activity Bar. Start Ollama and the backend first (see the repository's root README); the extension does not start them.

The package contains only `package.json`, `README.md`, `media/` and the compiled `out/*.js` (see `.vscodeignore`); it has no runtime dependencies. The installed copy is a snapshot: rebuild and reinstall after code changes. Remove it with `code --uninstall-extension local.rise-local-ai-assistant`. While the VSIX is installed, F5 still runs the development copy inside the Extension Development Host window.

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

## Limitations
This is a learning prototype: **not production ready** and **not an approved RISE deployment**.
- It talks only to a local backend and a local Ollama model, both on loopback. The backend has no authentication or TLS, so any local process can call it; never expose it on a network interface. The extension does not start the backend or Ollama.
- Tools are user-driven, not model-driven: there is no agent, no file editing and no terminal access.
- Secret detection is by file name and private-key text only. Other secrets inside ordinary files can be attached and sent to the local model.
- File reads have a residual race window (Node has no `openat()`), described above.
- Prompt injection from file content is mitigated, not eliminated.
- Tested on one macOS machine only; Windows and Linux are untested. Streaming, cancellation and other inference backends are not implemented.
- The installed copy is a snapshot; rebuild and reinstall after code changes.
