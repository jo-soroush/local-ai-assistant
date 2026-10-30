# RISE Local AI Assistant — VS Code extension (C01)

Minimal extension shell. Replies are **local placeholders only**: no backend, no model, no network access.

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
4. Type a message and click Send (or Cmd/Ctrl+Enter). A placeholder reply appears.

Debug: set breakpoints in `src/*.ts` in the original window; source maps are generated.
