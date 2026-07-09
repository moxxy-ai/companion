# `.codex/` — OpenAI (Codex) entry point

This directory is **only a reference layer**. The actual skills and agents live
in the lab-neutral [`../.ai/`](../.ai/README.md) directory. For convenience they
are symlinked here too:

```
.codex/skills -> ../.ai/skills
.codex/agents -> ../.ai/agents
```

Codex's native instruction mechanism is an `AGENTS.md` file rather than
Claude-style skill folders. The **canonical, universal** `AGENTS.md` is at the
repository root ([`../AGENTS.md`](../AGENTS.md)) — Codex reads it automatically
for a session run at the repo root, so no symlink is needed. The
[`AGENTS.md`](./AGENTS.md) in this directory is only a thin pointer back to it.

- **Edit knowledge** in `../.ai/`, never here — no content is duplicated.
- The universal entry point is `../AGENTS.md`; the deep knowledge is `../.ai/`.
- The same `.ai/` source backs the Anthropic entry point in `../.claude/`.
