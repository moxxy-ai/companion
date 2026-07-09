# `.claude/` — Anthropic (Claude Code) entry point

This directory is **only a reference layer**. The actual skills and agents live
in the lab-neutral [`../.ai/`](../.ai/README.md) directory; here they are just
symlinked so Claude Code discovers them:

```
.claude/skills -> ../.ai/skills
.claude/agents -> ../.ai/agents
```

Claude Code auto-loads any `skills/<name>/SKILL.md` and `agents/<name>.md` it
finds under `.claude/`, so through these symlinks the shared `.ai/` knowledge is
available as first-class Claude skills and subagents — with **no duplicated
content** to keep in sync.

- **Edit knowledge** in `../.ai/`, never here.
- **Add a skill/agent**: create it under `../.ai/skills` or `../.ai/agents`; it
  shows up automatically through the symlink.
- `settings.local.json` (permissions) and other Claude-Code-specific config
  stay in this directory — those *are* Claude-specific and don't belong in
  `.ai/`.

Other frontier labs point at the same `.ai/` source from their own directory
(e.g. `.codex/` for OpenAI Codex). The lab-neutral, universal entry point that
every AGENTS.md-reading tool picks up is the repository-root
[`../AGENTS.md`](../AGENTS.md); it routes to `.ai/` and to each lab's config.
