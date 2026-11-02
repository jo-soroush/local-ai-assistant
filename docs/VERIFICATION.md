# Verification record

Baseline commit `939d71c` plus the uncommitted C06 changes (prompt wording, tests, documentation). Last updated 2026-11-02.

Status labels:
- **VERIFIED**: evidence produced by commands run for this record (output below), by Claude Code or by the independent Codex audit.
- **OWNER-REPORTED**: confirmed manually by the owner on their Mac; not independently reproduced.
- **UNVERIFIED**: not yet executed.
- **BLOCKED**: cannot be executed in the environment used for this record.

## 1. Automated checks

### 1.1 Owner's Mac (OWNER-REPORTED)

| Check | Result | Status |
|---|---|---|
| Python tests | 118 passed, 1 non-blocking warning | OWNER-REPORTED |
| TypeScript tests | 79 passed, 0 failed | OWNER-REPORTED |
| TypeScript typecheck | PASS | OWNER-REPORTED |

These include the socket-based tests that cannot run in Claude Code's sandbox (see 1.3).

### 1.2 Independent Codex audits (results as recorded by the audit, 2026-11-01)

| Check | Result | Status |
|---|---|---|
| C05 security remediation audit | PASS (79 TypeScript and 117 Python tests passed at that time; Python is now 118 after the C06 prompt-wording test) | OWNER-REPORTED relay of the audit verdict |
| Python: `.venv/bin/python -B -m pytest -p no:cacheprovider -q` from `backend` | 118 passed; one Starlette deprecation warning | VERIFIED — PASS |
| TypeScript: compile into a temporary directory, then `node --test "$audit_build"/test/*.test.js` | 79 passed; zero failures or skips | VERIFIED — PASS |
| Typecheck: `npm run typecheck` from `vscode-extension` | exit 0 | VERIFIED — PASS |
| Current prompt builder and Ollama adapter → local `qwen2.5-coder:7b`, with synthetic editor code and an attached file | Correctly returned 5 for inputs 2 and 3 | VERIFIED — PASS; not a GUI or full HTTP walkthrough (the GUI path is covered by section 2) |
| C06 documentation audit | First verdict FAIL (one Medium, four Low findings); documentation remediated; re-audit PASS | OWNER-REPORTED relay of the audit verdicts |

### 1.3 Claude Code sandbox run (historical, 2026-11-01)

Run in a sandbox that forbids binding local sockets, so it could not execute everything.

| Check | Result | Status |
|---|---|---|
| Python tests | 117 passed, 1 failed (118 total). The failure, `test_ollama_provider.py::test_environment_proxies_are_ignored`, is `PermissionError` binding a socket. | VERIFIED for 117; the failing test BLOCKED there (passes on the owner's Mac, 1.1) |
| TypeScript typecheck | exit 0 | VERIFIED |
| TypeScript tests | 79 total: 71 passed, 8 failed. All 8 are in `client.test.ts` and fail with `listen EPERM`. | VERIFIED for 71; the 8 BLOCKED there (pass on the owner's Mac, 1.1) |
| Per file | context 17/17, placeholder 4/4, workspace 26/26, workspace-race 20/20, client 4/12 | VERIFIED |
| Live Ollama call from that sandbox | Loopback connections not permitted | BLOCKED (superseded by the live checks in 1.2 and section 2) |

### 1.4 Static inspection (VERIFIED, by `grep` over `backend/app` and `vscode-extension/src`, tests excluded)
- Only two URLs appear in application code: `http://127.0.0.1:11434` (Ollama default) and `http://127.0.0.1:8765` (backend default). Configured URLs are validated as `http` loopback in `config.py` and `client.ts`.
- The only network code is `fetch` in `client.ts` (extension → backend, redirects refused) and `httpx.AsyncClient` in `llm/ollama.py` (backend → Ollama, `trust_env=False`).
- No use of `child_process`, `subprocess`, `os.system`, `eval`, file write/delete APIs, `WorkspaceEdit`/`applyEdit`, terminals, telemetry or `openExternal`.
- Backend logging: one `logger.warning` with error code and request ID; no prompt text.
- Extension has no runtime npm dependencies; backend dependencies are `fastapi`, `uvicorn`, `httpx`.
- The webview uses `default-src 'none'` with nonce-based script and style.

Limits: this is a text search, not a network capture. It shows no unexpected network paths in the application code; it does not prove there is no traffic from VS Code itself, Ollama or the OS.

## 2. Manual GUI scenarios (owner's Mac, VS Code Extension Development Host)

All rows in this section are **OWNER-REPORTED** (result: PASS) unless stated.

| Scenario | Result |
|---|---|
| Real VS Code → FastAPI → Ollama response | PASS |
| General question without context | PASS |
| Selected-code context (C04; code explained correctly, expected output 3) | PASS |
| Whole-file context, no selection | PASS |
| Workspace file attached; model response used the file (C05) | PASS |
| Attachment removal | PASS |
| Backend unavailable | Visible connection error — PASS |
| Ollama unavailable | HTTP 503 — PASS |
| Model missing | HTTP 502 — PASS |
| No active editor | Clear error — PASS |
| Oversized selection (22,502 characters) | Rejected — PASS |
| Sensitive `.env` discovery | Blocked — PASS |
| Mixed-case `.SSH/config` discovery | Blocked — PASS |
| Symlink escaping the workspace | Blocked — PASS |
| Backend and Ollama listening on `127.0.0.1` (listener check) | PASS |

The listener check shows which addresses the two services are bound to. It does **not** show that the system makes no outbound connections or sends nothing off the machine; that is not claimed.

## 3. Items still UNVERIFIED

| Item | Status | Note |
|---|---|---|
| Outbound network observation while running (for example `lsof -nP -i -a -p <pid>` for the backend and extension host, or a firewall monitor) | UNVERIFIED | Needed to support a "no unexpected outbound traffic" statement beyond the static inspection. |
| Clean stop: nothing listens on 8765 after the README stop steps | UNVERIFIED | |
| README setup and run steps followed from a fresh checkout | UNVERIFIED | |
| Oversized whole active file (no selection) rejected in the GUI | UNVERIFIED | Only the oversized selection was run in the GUI; both paths are covered by unit tests. |
| Binary or over-64 KiB file attachment refused in the GUI | UNVERIFIED | Unit tests cover it. |
| Real-model tool-calling reliability | UNVERIFIED | Out of scope by decision; tools are user-driven. |
| Windows and Linux | UNVERIFIED | Only macOS has been used. |

## 4. Acceptance status

No failing test, open defect or unresolved audit finding is recorded. The remaining C06 acceptance gaps are evidence gaps, not known defects:
1. **Outbound-traffic observation** (above), which supports the roadmap criterion "no unexpected data exfiltration in the tested flow". Until it is run, that criterion rests on the static inspection plus the listener check, and the limits stated in 1.4 and section 2 apply.
2. **Fresh-checkout run and clean stop** (above), which support the criterion that the README explains how to run and stop the components.

Either run these two checks or accept them explicitly as documented limitations; otherwise the record stays as it is. Mark each outcome VERIFIED (with output) or note the defect; do not mark unrun items as passed.

### Commands for the remaining checks (owner's Mac)
- Outbound: while asking a question, `lsof -nP -i -a -p <backend pid>` and the same for the extension host. RISE Assistant's connections should use loopback (`127.0.0.1`, or `::1` where supported and configured; `localhost` may resolve to either). The extension host can also carry traffic from unrelated extensions; identify the source before attributing a connection to RISE Assistant.
- Clean stop: stop everything as in the root README, then `lsof -iTCP:8765 -sTCP:LISTEN` → expect no output.
- Fresh checkout: clone to a new directory and follow the root README Setup and Run sections unchanged.
