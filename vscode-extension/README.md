# RISE Local AI Assistant — VS Code extension (C01)

Minimal extension shell. Messages go to the local backend (`riseAssistant.backendUrl`, loopback only, default `http://127.0.0.1:8765`); request timeout `riseAssistant.requestTimeoutMs` defaults to 130000 ms (max 180000) to cover local model inference.

## Build and test
```bash
cd vscode-extension
npm install
npm run compile      # tsc -p ./
npm test             # compile + node --test
```

## Run in the Extension Development Host
1. Open the repository root in VS Code.
2. Press **F5** and choose "Run RISE Assistant Extension" (compiles first).
3. In the new window open the Command Palette and run **RISE Assistant: Ask**.
4. Type a message and click Send (or Cmd/Ctrl+Enter). A model reply appears (backend and Ollama must be running; see backend/README.md).

Debug: set breakpoints in `src/*.ts` in the original window; source maps are generated.

## Editor context (C04)
The panel has an **Include editor context** checkbox (on by default) and a line showing exactly what will be sent.
- Non-empty selection: the selected text. Otherwise the whole active file.
- Only saved `file:` documents inside the open workspace (symlinks resolved) are eligible. Max 16,000 characters; nothing is clipped.
- `.env`, `.env.*`, `*.pem`, `*.key`, `*.ppk`, `*.p12`, `*.pfx`, `id_*` SSH keys, files under `.ssh/` (except `.pub`) and any text containing a private key are never sent.
- If context is requested but unusable, the question is **not** sent and the reason is shown. Uncheck the box to ask without code.

## Workspace file tools (C05)

Click **Attach workspace file…** in the assistant panel, type part of a file name, pick a file from the list, and ask your question. The extension runs two read-only tools **on your request**:

- `search_files` — finds file names in the open workspace (names only, max 50 results, `node_modules`, `.git`, `out`, `dist`, `.venv`, `__pycache__` skipped).
- `read_file` — reads the file you picked and sends its text with your question to the local backend.

**Tool initiation is user-driven, not model-driven.** The model is never given tools and does not decide what to read; this is not autonomous agent tool calling. The backend never opens files; it only receives the text.

Limits and refusals: one file per message, max 64 KiB on disk and 16,000 characters, UTF-8 text only. Refused: paths outside the workspace (including `..` and symlinks that resolve outside), binary files, `.env*`, SSH/TLS keys and files with private-key text, and anything under `.git`/`.aws` or named `.npmrc`/`.netrc`/`.pypirc`. The file is re-read when you send; if that fails, nothing is sent. The chosen file is shown before sending and noted in the chat log. There is no write, edit or shell capability.

**Race and platform limits (C05).** Node has no `openat()`, so a path check alone cannot stop someone with write access to the workspace from swapping a file or parent folder for a symlink between checking and opening. The read therefore opens with `O_NOFOLLOW`/`O_NONBLOCK`, then requires the opened file (device + inode) to be the file the path resolves to, both after opening and after reading; anything else returns nothing ("changed"). A residual window remains for an attacker who can flip the filesystem several times between those checks in precise order; it is not closed by this design. Special files (FIFO, device, socket) are never read. Name checks for `.ssh`, `.git`, `.aws`, `.env*`, keys and credential files ignore case. The attachment is bound to the workspace folders and real file selected: if the folders change or the path now leads elsewhere, it is removed and nothing is sent.
