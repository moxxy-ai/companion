# AGENTS.md — Companion

Universal entry point for any AI coding tool working in this repo. Most agent
tools (OpenAI Codex, Cursor, Amp, Jules, Aider, …) read the nearest `AGENTS.md`
automatically; this root file is the shared, lab-neutral instruction set. It
**routes** to the deep knowledge base and to each frontier lab's native config —
it does not duplicate them.

## Where things live

- **`.ai/`** — the single source of truth: reusable **skills** (`.ai/skills/*`)
  and **agent role definitions** (`.ai/agents/*`). Edit knowledge here, nowhere
  else. Start at [`.ai/README.md`](.ai/README.md).
- **`.claude/`** — Anthropic (Claude Code) entry point; symlinks
  `skills/` + `agents/` to `../.ai/` so Claude Code auto-discovers them, and
  holds Claude-specific config (`settings.local.json`).
- **`.codex/`** — OpenAI (Codex) entry point; a thin reference back to this file
  and `.ai/`.

Other labs need no new directory — they read this `AGENTS.md` and can open any
`.ai/agents/*.md` as a role prompt and any `.ai/skills/*/SKILL.md` as guidance.

## Read the relevant skill before non-trivial work

The `.ai/skills/` are the authoritative, verified conventions. Load the one(s)
that fit the task first:

| Task | Skill |
| --- | --- |
| Orient / find where something lives | `companion-architecture` |
| Write or edit any TS/React here | `companion-code-standards`, `craft-principles` |
| Add a permission / DTO / WS event | `companion-contract-and-rbac` |
| Touch the database | `companion-store-and-migrations` |
| Add a backend area | `companion-add-backend-area` |
| Add a web module | `companion-add-web-area` |
| Launch / drive / react to an AI agent run | `companion-agent-runs` |
| Prompt an agent or parse model output | `agent-prompting-and-parsing` |
| Read/write GitHub | `companion-github-integration` |
| Add/change a pipeline step kind | `companion-pipelines` |
| Reason about cost, or review a change | `performance-and-complexity`, `critical-thinking` |
| Verify a change / secure a boundary | `companion-verification`, `companion-security` |

Specialised agent roles live in `.ai/agents/`: **module-builder** (scaffolds an
area end-to-end), **companion-reviewer** (diff review, ranked findings),
**codebase-navigator** (traces the spine, returns `file:line` maps). In Claude
Code invoke them as subagents; in other tools, use the file as the system prompt.

## The project in one paragraph

Companion is a self-hosted engineering dashboard that drives GitHub repos with
[moxxy](https://github.com/moxxy-ai/moxxy) agents. It's a pnpm monorepo, all ESM,
strict TypeScript: `packages/contract` (shared types — the spine),
`apps/companiond` (SQLite + typed HTTP/WS daemon), `apps/web` (React 18 + Vite +
Tailwind SPA, hash-routed), `apps/companion-runner` (remote execution agent).
`moxxy` is an external CLI runtime, **never** a package dependency.

## Load-bearing invariants (full detail in `companion-architecture`)

1. **RBAC is enforced once, centrally** in the router from each route's `access`;
   the SPA mirrors the same `Permission`. Never re-check or skip auth in a handler.
2. **Every cross-boundary type lives in `@companion/contract`** — never redefined.
3. **`issues`/`prs` are a cache** of GitHub; GitHub stays authoritative.
4. **Every state mutation broadcasts** its `*.changed` event; exactly one client
   hook consumes it.
5. **Migrations are additive and idempotent** — no destructive/one-shot migrations.
6. **Relative imports end in `.js`** (NodeNext); DTOs are `readonly`.
7. **Secrets never cross to the client**; unattended agent runs auto-allow but
   stay fenced (isolated cwd + deny rules + token ceiling + review-then-apply).

## Quality gate

There is **no linter and no test suite yet.** The bar is: `pnpm typecheck`
(root) is clean **and** you drove the real behaviour in `pnpm dev` and observed
it — not types alone. Do not add dependencies without justification; prefer the
platform and the existing `ui.tsx` kit. See `companion-verification`.

## Commands

```sh
pnpm install      # corepack enable first; pnpm 10, Node >= 20
pnpm dev          # companiond :8901 + Vite :5173 (proxies /api, /ws)
pnpm build        # tsc across the workspace (+ vite build for web)
pnpm typecheck    # the quality gate
```

## Conventions this repo does NOT want

- Adding a package when the platform (`fetch`, `node:crypto`, `URLSearchParams`)
  or `components/ui.tsx` already covers it.
- A router library, an ORM, a new auth check in a handler, a locally-redefined DTO.
- Committing with a `Co-Authored-By`/AI-attribution trailer (the maintainer is
  the sole author). Only commit or push when asked.
