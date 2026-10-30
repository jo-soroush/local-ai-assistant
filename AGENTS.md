# RISE Local AI Coding Assistant — AGENTS.md

## Project Goal

Build a small, fully local AI coding assistant integrated with VS Code.

The initial prototype uses:
- VS Code Extension (TypeScript)
- FastAPI Backend (Python)
- Model-independent LLM Adapter
- Local Ollama inference
- Controlled workspace tools

The application must not depend on cloud AI services.

## Source of Truth

Before starting any work:

1. Read `RISE_LOCAL_AI_ASSISTANT_6_CARDS.md`.
2. Inspect the existing repository structure.
3. Work only on the currently approved card.
4. Do not assume unfinished features are implemented.

## Agent Responsibilities

### Claude Code — Implementer

- Implement the approved development card.
- Write and run relevant tests.
- Keep changes small and focused.
- Report modified files, test results, and limitations.
- Stop after completing the card for independent review.

### Codex — Independent Reviewer

- Review Claude Code's actual implementation.
- Inspect code, architecture, security, and relevant tests.
- Run appropriate read-only validation commands.
- Identify bugs, regressions, and unnecessary complexity.
- Report findings by severity with file references.
- Do not modify implementation files during review.
- Do not claim PASS without verification.

Claude Code fixes confirmed findings after owner approval.

## Architecture Rules

- Keep the VS Code Extension separate from the Backend.
- Keep model-specific API logic inside the LLM Adapter.
- Support Ollama first.
- Keep the architecture compatible with future local inference servers.
- Do not introduce RAG or fine-tuning unless explicitly approved.
- Prefer existing project files and dependencies.
- Avoid unnecessary frameworks and abstractions.

## Local Security

- No cloud inference or external AI API calls.
- Do not send project code to external services through the application.
- Restrict file access to authorized workspaces.
- Do not execute arbitrary model-generated shell commands.
- Require appropriate user approval for file modifications and sensitive operations.
- Never commit credentials or secrets.

## Development Workflow

For each approved card:

1. Inspect the existing implementation.
2. Implement the smallest working solution.
3. Add focused tests.
4. Run relevant validation.
5. Review the changed files.
6. Report the actual results.
7. Stop for Codex independent review.

Do not automatically start the next card.

## Git Rules

- Preserve existing user changes.
- Do not perform unrelated refactoring.
- Do not force-push or rewrite Git history.
- Do not commit or push without owner approval.

## Final Principle

Build a simple, working prototype.

Prioritize correctness, reliability, security,
and maintainability over unnecessary complexity.