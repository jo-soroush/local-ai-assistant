cat > CLAUDE.md <<'EOF'
# RISE Local AI Coding Assistant — Claude Code

Role: Implementation and testing.
Codex performs independent, read-only review.

1. Read RISE_LOCAL_AI_ASSISTANT_6_CARDS.md and inspect the existing project.
2. Implement only the card approved by the owner.
3. Keep the solution simple: VS Code, TypeScript, FastAPI and local Ollama.
4. Never use cloud inference APIs in the application.
5. Add relevant tests and report actual results.
6. Stop after each card for independent Codex review.
7. Fix review findings only after owner approval.

Do not assume the final RISE model or inference server is known.
EOF