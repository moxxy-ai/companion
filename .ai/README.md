# `.ai/` — shared agent knowledge base

This directory is the **single, lab-neutral source of truth** for the skills and
agents that help work on Companion. It is not tied to any one AI vendor: the
frontier-lab tool directories (`.claude/` for Anthropic Claude Code, `.codex/`
for OpenAI Codex) hold **only references** back here — they do not duplicate
content. Edit knowledge in one place: `.ai/`.

```
.ai/
  skills/    # focused, trigger-described capabilities (Claude "skills")
  agents/    # subagent definitions (system prompt + tool scope)

.claude/skills -> ../.ai/skills   # symlink; Claude Code discovers them here
.claude/agents -> ../.ai/agents   # symlink
.codex/…                          # reference docs pointing at .ai/
```

## Skills (`skills/<name>/SKILL.md`)

Repo conventions — how Companion is built:

- **companion-architecture** — the monorepo map, the request spine, and the
  invariants you must not break. Read this first.
- **companion-code-standards** — mechanical conventions (ESM `.js` imports,
  strict TS, readonly DTOs, zod-at-the-edge, error types, Tailwind + `ui.tsx`,
  dependency discipline).
- **companion-contract-and-rbac** — evolving the shared `contract` spine and
  threading a `Permission` / DTO / WS event end-to-end.
- **companion-store-and-migrations** — SQLite store classes, additive
  migrations, row⇄DTO mappers.
- **companion-add-backend-area** — recipe to add a daemon area end-to-end.
- **companion-add-web-area** — recipe to add an SPA module end-to-end.

Product subsystems — the substance, not just the scaffolding:

- **companion-agent-runs** — moxxy orchestration: the run lifecycle & status
  machine, attended vs unattended, one-shot vs goal runs, runners, recovery.
- **agent-prompting-and-parsing** — designing agent prompts and turning model
  output into typed, validated data (extract → jsonrepair → zod); review-then-apply.
- **companion-github-integration** — the account registry (purposes/scopes/
  owner), resolving a client per purpose, sync-as-cache, checks, webhook HMAC.
- **companion-pipelines** — the typed pipeline/step system and the
  "one union member + one handler" way to add a step kind.

Craft & quality — how to build well:

- **craft-principles** — SOLID / KISS / DRY / YAGNI / cohesion / coupling,
  applied to this codebase with concrete examples.
- **performance-and-complexity** — time & space cost, the N+1 trap, SQLite
  indexing & paging, bounded memory, React re-render/refetch hygiene.
- **critical-thinking** — adversarial self-review, edge/failure/concurrency
  enumeration, verified-vs-assumed honesty, invariant checking.
- **companion-verification** — how to verify with no test suite: the typecheck
  gate, driving the app, tracing a run, inspecting the DB.
- **companion-security** — secret & trust boundaries: tokens never crossing to
  the client, scrypt/session handling, webhook HMAC, why unattended runs stay fenced.

## Agents (`agents/<name>.md`)

- **module-builder** — scaffolds and wires a new area end-to-end following the
  recipes; leaves a `typecheck`-clean tree. (edits code)
- **companion-reviewer** — reviews a diff for correctness + invariant/standard
  violations, ranked with concrete failure scenarios. (read-only)
- **codebase-navigator** — traces the contract→store→service→route→api→hook→page
  spine and returns a `file:line` map. (read-only)

## Authoring conventions for this directory

- A **skill** is a folder with `SKILL.md`; frontmatter needs `name` and a
  trigger-focused `description` (when to use it). Keep each skill focused and
  cross-link siblings by name.
- An **agent** is a single `.md` with frontmatter `name`, `description`, and
  (optionally) `tools` / `model`, followed by the system prompt.
- Ground every claim in the **actual** codebase. If a convention changes,
  update the skill in the same PR so this stays truthful — stale guidance is
  worse than none.
