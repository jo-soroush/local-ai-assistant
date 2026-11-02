# Verification record

Baseline commit `939d71c` plus the uncommitted C06 changes (prompt wording, tests, documentation). Last updated 2026-11-02.

**Later addition (2026-11-02):** the model-information display (`GET /v1/model-info` and the chat header). Its results are recorded separately in sections 1.5 and 1.6. Sections 1.1 to 1.4 and 2 are earlier evidence and are kept as they were; they were **not** re-run for the latest numbers and must not be read as the latest results.

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

### 1.5 Latest automated run, after the model-information feature (VERIFIED, 2026-11-02)

Run by Claude Code **outside the restricted sandbox** (sandbox disabled for these commands, loopback sockets allowed), from the repository root with the working tree as of this feature. This supersedes the counts in 1.1 to 1.3 for the current code; those rows remain as history.

| Check | Command | Result | Status |
|---|---|---|---|
| Backend tests | `cd backend && .venv/bin/python -m pytest -q` | **122 passed**, 1 warning (Starlette `httpx` deprecation notice) | VERIFIED — PASS |
| TypeScript tests | `cd vscode-extension && npm test` | **121 passed**, 0 failed (121 run) | VERIFIED — PASS |
| TypeScript typecheck | `cd vscode-extension && npm run typecheck` | exit 0 | VERIFIED — PASS |

Notes:
- This run was made by Claude Code on the developer's Mac and has not been repeated by the independent reviewer or the owner.
- Earlier in the same session, the same suites were also run **inside** the sandbox. They did not complete there: TypeScript 112 passed and 9 failed, all with `listen EPERM` (8 existing `postChat` tests in `client.test.ts` plus the new real-server model-info test); Python 121 passed and 1 failed (`test_environment_proxies_are_ignored`, a socket `PermissionError`). Those failures are the sandbox restriction described in 1.3, not code defects, and the tests pass outside the sandbox as shown above. Another test failed once outside the sandbox (`test_route_and_extension_do_not_contain_ollama_wire_format`), because a tooltip text in the webview contained the word "Ollama"; the text was reworded and the suite passed. The counts in the table are from the final run.
- The earlier TypeScript count of 79 (1.1 to 1.3) predates this run. How the suite grew from 79 to 121 is not itemised here; only the 18 tests of this feature are (see 1.6). The earlier Python count of 118 plus the 4 new tests of this feature gives 122.

### 1.6 Model-information display: what it is and how it is tested

**Feature (IMPLEMENTED).** The chat view shows `Model:` and `Provider:`, or `Backend offline` / `Model info unavailable`. The values come from `GET /v1/model-info`, which returns the provider and model name from the backend's runtime configuration (`RISE_OLLAMA_MODEL`, default `qwen2.5-coder:7b`). The language model is not asked, and Ollama is not contacted. The extension asks when the view opens, when it is shown again, and after a failed question. The display shows the **configured** name only. It does not show that Ollama is running, that the model is installed or loaded, or that it is generating.

**Automated coverage (VERIFIED by the run in 1.5; 22 new tests):**

| Area | Tests | What they check |
|---|---|---|
| Backend, `backend/tests/test_api.py` | 4 | Endpoint returns the configured provider and model without calling the model; a custom `RISE_OLLAMA_MODEL` is reported, with the Ollama HTTP client replaced by one that fails if used; the default model comes from settings; `POST` is refused (405). |
| Extension client, `src/test/client.test.ts` | 6 | `GET /v1/model-info` with redirects refused; unreachable backend and timeout become an offline error; HTTP errors and malformed or oversized answers become a different error (not "offline"); non-loopback, non-http and credential URLs are rejected before any request; against a real local server, then the same server stopped. |
| Chat page, `src/test/webview-model.test.ts` | 5 | The generated page script is valid and starts as "Checking backend…"; model and provider are drawn on two lines; offline replaces the model text and leaves no model name; "unavailable" and "checking" show no model; the page text makes no loaded/healthy/generating claim. Uses a small fake page, not a real webview. |
| Extension wiring, `src/test/sidebar-wiring.test.ts` | 7 | The real `extension.ts` against a fake `vscode`: model shown when the view opens; offline shows no model name; re-showing the view re-checks and replaces an old model with offline; a failed chat re-checks; a successful chat does not; an older slow answer cannot overwrite a newer one; no chat request is made to learn the model name. |

Limits of this coverage: the tests use fakes for `vscode` and for the page. They do not show how the display looks or behaves in a real VS Code window.

### 1.7 Independent validation after the model-information feature (VERIFIED, 2026-11-02)

Run by the independent reviewer against baseline commit `5641918` plus the uncommitted working-tree changes. This repeats, independently, the Claude Code run in 1.5.

| Check | Result | Status |
|---|---|---|
| Python tests | 122 passed | VERIFIED — PASS |
| TypeScript tests | 121 passed | VERIFIED — PASS |
| TypeScript typecheck | PASS | VERIFIED — PASS |
| `git diff --check` | PASS | VERIFIED — PASS |

The "has not been repeated by the independent reviewer" note in 1.5 is superseded for the test counts by this row; the rest of 1.5 stays as written.

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

### 2.1 Model-information display in normal VS Code (OWNER-REPORTED)

| Scenario | Result |
|---|---|
| Model and provider lines shown in the chat view in the normal VS Code window (installed extension) | PASS — OWNER-REPORTED |

Only this scenario was reported. The offline, custom-model and tooltip scenarios were not reported and remain UNVERIFIED (section 3).

## 3. Items still UNVERIFIED

| Item | Status | Note |
|---|---|---|
| Outbound network observation while running (for example `lsof -nP -i -a -p <pid>` for the backend and extension host, or a firewall monitor) | UNVERIFIED | Needed to support a "no unexpected outbound traffic" statement beyond the static inspection. |
| Clean stop: nothing listens on 8765 after the README stop steps | UNVERIFIED | |
| README setup and run steps followed from a fresh checkout | UNVERIFIED | |
| Oversized whole active file (no selection) rejected in the GUI | UNVERIFIED | Only the oversized selection was run in the GUI; both paths are covered by unit tests. |
| Binary or over-64 KiB file attachment refused in the GUI | UNVERIFIED | Unit tests cover it. |
| **Model-information display in the real VS Code GUI: remaining scenarios** (`Backend offline` after stopping the backend and re-showing the view; the display after changing `RISE_OLLAMA_MODEL` and restarting the backend; tooltip) | **UNVERIFIED** | The model and provider lines in normal VS Code are OWNER-REPORTED as working (2.1). The scenarios listed here have not been confirmed. The automated tests in 1.5 and 1.6 use fakes. Not claimed as passed. |
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
