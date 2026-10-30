# RISE Local AI Coding Assistant — Six Development Cards

**Document status:** Proposed implementation plan (not implemented)  
**Purpose:** Build a small, end-to-end, fully local VS Code AI coding assistant on the developer's Mac, using Ollama for the first working integration.  
**Owners:** Claude Code — implementation; Codex — independent review, test assessment, and audit.  
**Scope:** Learning prototype, not a production-ready Codex replacement.

## 1. Goal and boundaries

**Target demonstration:** A developer opens a Python file in VS Code, asks the assistant to explain or diagnose it, and sees a real answer produced by a locally running Ollama model. The user can also ask a general coding question. The solution must have a clean architectural seam for additional on-premises model APIs later.

### Constraints

- **No cloud APIs, telemetry with code content, or hosted inference.** Ollama, backend, and extension run locally for this prototype. Do not silently download models or invoke external services during operation.
- **Technology:** VS Code extension in TypeScript; Python FastAPI backend; Ollama for inference; model adapter boundary.
- **Keep it minimal:** No RAG, embeddings, vector database, fine-tuning, Docker, authentication platform, multi-agent framework, or autonomous repository-wide modifications.
- **Local access only:** Backend and Ollama bound to loopback for this single-user prototype; do not expose endpoints to the LAN.
- **Workspace safety:** Read only the active VS Code workspace and selected/active editor content with user intent. No uncontrolled terminal commands, automatic file edits, shell execution, or access to unrelated filesystem paths.
- **No assumption about RISE infrastructure:** Actual RISE model, inference server, API protocol, server access, and security rules remain unknown. The prototype must not claim to be an approved RISE deployment.
- **Development discipline:** Work card by card, in order. Each card should be reviewed before moving on; keep changes small and auditable.

## 2. Target architecture

```text
Developer in VS Code
        |
        v
VS Code Extension (TypeScript)
  - chat / command entry point
  - user-visible output
  - selected editor / workspace context
  - permitted local workspace tool executor
        |
        | HTTP over localhost
        v
FastAPI Backend (Python)
  - request validation and errors
  - simple chat orchestration
  - provider-neutral LLM interface
        |
        v
LLM Adapter
  - Ollama implementation: ACTIVE for prototype
  - OpenAI-compatible: INTERFACE READY, implementation deferred
  - RISE custom API: DEFERRED until specification is available
        |
        v
Local Ollama inference server -> installed local model

Workspace tool requests (if needed): Backend -> Extension -> approved local workspace action -> Backend
```

**Architectural rule:** The backend should not access the developer's VS Code workspace directly through arbitrary server-side paths. For the prototype, context can be supplied explicitly by the extension; any tool execution added later must remain under extension-side workspace controls.

## 3. Work allocation and delivery protocol

- **Claude Code (implementer):** Implement only the currently authorized card, document actual files changed and commands run, and report tests with exact results. Avoid unrelated refactors or speculative infrastructure.
- **Codex (independent reviewer):** Read-only architectural review, security review, and validation of acceptance criteria. May propose fixes but should not modify implementation files without an explicit change in role.
- **Owner:** Approves card boundaries and reviews results before beginning the next card.
- **Every card closes with:** Scope summary, files changed, evidence of tested behavior, known limitations, and a clear PASS / FAIL / BLOCKED assessment.
- **No false verification:** If a model is unavailable or VS Code integration is not exercised, mark the related acceptance check unverified rather than passing it.

---

## C01 — Minimal VS Code Extension Shell

**Objective:** Establish a working TypeScript VS Code extension with a simple UI entry point and a place to display assistant responses.

**Implementation scope**
- Create or complete the minimal extension scaffold (`package.json`, TypeScript configuration, activation entry point).
- Register a command such as `RISE Assistant: Ask`.
- Provide a small input/output experience (simple webview chat or equivalent minimal VS Code UI). Avoid polished UI work.
- Add concise local run/debug instructions using Extension Development Host.
- Ensure the extension does not require a cloud account or internet service.

**Acceptance criteria**
- Extension launches in VS Code Extension Development Host.
- Command is discoverable and accepts user input.
- A local placeholder response displays correctly; no LLM request yet.
- Build/TypeScript checks pass; startup does not require cloud connectivity.

**Out of scope:** FastAPI integration, Ollama, workspace file reading, tool execution.

**Depends on:** None.

## C02 — Minimal FastAPI Backend and Extension Transport

**Objective:** Establish actual local HTTP communication from the extension to a FastAPI backend.

**Implementation scope**
- Create a minimal FastAPI app with a health endpoint and a versioned chat/request endpoint.
- Define narrow request/response schemas, request IDs, input limits, and error responses.
- Connect the extension to the backend on a configurable loopback URL; display backend responses and connection errors.
- Use reasonable request timeouts and preserve useful errors in the UI.
- Add small API tests and startup instructions.

**Acceptance criteria**
- `/health` responds from the locally launched backend.
- A message entered in VS Code reaches FastAPI and a deterministic placeholder reply returns to VS Code.
- Invalid input produces a useful validation error; unavailable backend produces a visible error.
- API tests pass and backend binds to localhost by default.

**Out of scope:** Actual model calls, queueing, RAG, streaming.

**Depends on:** C01.

## C03 — Provider-Neutral LLM Interface + Ollama

**Objective:** Replace placeholder backend replies with real answers from a locally installed Ollama model without coupling the extension to the provider.

**Implementation scope**
- Define a small backend `LLMProvider` abstraction for generating a chat response.
- Implement one provider: Ollama via its local HTTP API.
- Make Ollama base URL and model name configurable; no forced model download.
- Keep provider-specific payloads inside the adapter; backend chat route remains provider-neutral.
- Handle model-not-found, Ollama-unavailable, timeout, and malformed response conditions.
- Document how to verify the selected model exists before testing.

**Acceptance criteria**
- VS Code prompt -> FastAPI -> Ollama -> FastAPI -> VS Code returns a **real model-generated reply**.
- Extension and primary backend route do not import Ollama-specific request formats.
- Error cases are tested with mocks; at least one live local Ollama call is performed and reported separately.
- No requests to cloud inference endpoints.

**Out of scope:** Implementing vLLM/OpenAI-compatible adapter, RISE proprietary adapter, model downloads/training.

**Depends on:** C02.

## C04 — Active File / Selection Context

**Objective:** Let the assistant explain or diagnose the current code by receiving explicit editor context.

**Implementation scope**
- Read only the user's active editor selection; if none, use the active file within the open workspace, with clear UI indication of what is being sent.
- Send path metadata and text to backend as request context; never send arbitrary full-workspace archives.
- Respect practical size limits; if too large, tell the user and ask for a smaller selection rather than silently clipping critical content.
- Avoid unsupported/binary files and exclude files outside the open workspace.
- Provide an option to ask without file context.

**Acceptance criteria**
- User can ask `Explain this function` with an active selection; response references the supplied code.
- Without selection, the assistant can use the active workspace file subject to size limit.
- No-file and oversized-file states are handled clearly.
- Tests cover context extraction and the backend request shape.

**Out of scope:** Repository-wide retrieval, vector search, embeddings, automatic file modifications.

**Depends on:** C03.

## C05 — Controlled Workspace Read Tools (Minimal)

**Objective:** Establish the safe architectural path for future agent tools without adding unbounded autonomy.

**Implementation scope**
- Implement minimal extension-side workspace tools: list/discover relevant workspace files and read a specific permitted text file.
- Define a small, explicit tool request/result protocol between backend and extension (or an equivalent extension-mediated approach).
- Require actions to remain under the open workspace root, with path traversal, symlink/real-path escape, binary-file, and file-size checks.
- Show which file is being accessed; do not execute shell commands or edit files.
- If the selected Ollama model cannot reliably emit structured tool calls, use a deterministic extension-mediated tool invocation for the demo; **do not** present it as autonomous agent tool calling.

**Acceptance criteria**
- Demonstrate discovering a workspace file, reading an allowed file, and using its content in a real model prompt.
- Reject attempts to access a path outside the workspace; include negative security tests.
- No arbitrary terminal execution or automatic code edits are possible.
- Document whether tool initiation is model-driven or user/application-driven.

**Out of scope:** Agent loop, terminal tool, editing tool, automated test runner, full tool-call protocol for every model.

**Depends on:** C04.

## C06 — End-to-End Verification and Handover

**Objective:** Produce a reproducible local demo and a clear assessment of readiness for the RISE team discussion.

**Implementation scope**
- Run an end-to-end walkthrough: start Ollama and the installed model, start FastAPI, launch the VS Code extension, ask a question, provide selected-file context, and perform one controlled workspace read.
- Add/complete focused backend and extension tests as feasible.
- Verify key failure scenarios: backend stopped, Ollama stopped/model absent, no active file, oversized context, blocked outside-workspace path.
- Document exact run steps, architecture, configuration variables, test commands, known limitations, and follow-on decisions.
- Independently audit with Codex, then remediate any high-severity defects through Claude Code before declaring completion.

**Acceptance criteria**
- Documented end-to-end scenarios execute on the developer's Mac using local services only.
- Tests and independent review findings are reported with actual results.
- README explains prerequisites and how to run/stop components.
- No cloud calls, uncontrolled local file access, or unexpected data exfiltration are present in the tested flow.
- Project clearly labels unimplemented features and is not misrepresented as production ready.

**Out of scope:** Full Codex feature parity, production deployment, RISE server integration, RAG and fine-tuning.

**Depends on:** C01–C05.

---

## 4. Milestones

| Milestone | Cards | Demonstrable result |
|---|---|---|
| M1 — End-to-end chat | C01–C03 | Ask in VS Code and receive a real local Ollama response |
| M2 — Code context | C04 | Explain code from active editor/selection |
| M3 — Safe workspace tools | C05 | Controlled discovery and reading of a workspace file |
| M4 — Verified prototype | C06 | Reproducible demo and independently reviewed evidence |

## 5. Explicitly deferred decisions

1. **RISE inference backend:** Ollama vs vLLM vs another local serving stack; wait for real RISE API details.
2. **OpenAI-compatible adapter:** planned extension point only; implement when a compatible server is available for testing.
3. **RAG:** evaluate only if targeted workspace search cannot serve larger codebases or documentation.
4. **Fine-tuning:** not necessary for the initial prototype; consider only after measured baseline failures and validated data rights.
5. **Streaming, cancellation, queues, multi-user concurrency:** important for subsequent maturation; not required to close the six-card single-user prototype unless explicitly added in a future scoped card.
6. **Code edits, tests, terminal, and autonomous agent loop:** future capability requiring permissions, sandboxing, and separate acceptance gates.
7. **Production security:** Authentication, transport security, host/network isolation and organizational policies must be re-evaluated before any shared RISE deployment.

## 6. Final definition of done

The prototype is complete **only if** C01–C06 satisfy their acceptance criteria, the local Ollama end-to-end demonstration has been performed, relevant automated checks pass (or limitations are transparently recorded), and independent review finds no unresolved critical safety defects. A plan or code scaffold alone does not count as delivery.
