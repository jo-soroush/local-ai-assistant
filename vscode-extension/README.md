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
