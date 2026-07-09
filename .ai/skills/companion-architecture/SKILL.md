---
name: companion-architecture
description: >-
  Map of the Companion monorepo and its load-bearing invariants. Read this
  BEFORE any nontrivial change so you edit the right layer and don't break a
  cross-cutting rule. Use when you need to know where something lives, how a
  request flows contract → store → service → route → api → hook → page, or what
  must never be violated (end-to-end RBAC, GitHub-as-cache, the typed spine).
---

# Companion architecture

Companion is a self-hosted engineering dashboard that drives GitHub repositories
with [moxxy](https://github.com/moxxy-ai/moxxy) agents. It is a **pnpm workspace
monorepo**, all ESM, all TypeScript `strict`.

## The four packages

| Path | What it is | Depends on |
| --- | --- | --- |
| `packages/contract` | **The spine.** Shared domain types, the `Permission` grid, REST DTOs, the `SpaServerMessage` union, pipeline unions, the moxxy wire subset, the runner-agent protocol. Pure types + a few const arrays. | nothing |
| `apps/companiond` | **The daemon.** SQLite store, domain services, the typed HTTP/WS route registry + RBAC, run orchestration, GitHub sync, runner registry. Serves the built SPA in prod. | `@companion/contract` |
| `apps/web` | **The SPA.** React 18 + Vite + Tailwind v4. REST/WS client, data hooks, pages, the module registry. Hash-routed, no react-router. | `@companion/contract` |
| `apps/companion-runner` | **The remote agent.** A slim daemon a remote box runs to execute agent work (moxxy gateways, git worktrees) driven by a `companiond` over HTTP+WS. Publishes to npm. | `@companion/contract` (dev) |

`moxxy` is an **external runtime, not a dependency** — companiond shells out to
the `moxxy` CLI and drives gateway processes. Never add moxxy as a package dep.

## The request spine (learn this cold)

A feature is one vertical slice through these layers. Data always flows the same
way; each arrow is a file you touch when adding an area.

```
packages/contract/src/*.ts        ← types, DTOs, Permission, SpaServerMessage   (the shared truth)
        │
companiond: store/<x>.ts          ← SQLite class + migration           (persistence)
        │   store/db.ts            ← facade wires the store class
companiond: <x>/<x>.ts            ← service class: business logic, broadcasts WS   (behavior)
        │
companiond: http/routes/<x>.ts    ← route({...}) registry, access = Permission    (HTTP surface)
        │   http/routes/index.ts   ← buildRoutes() concatenates registries  (one line)
        │   http/deps.ts           ← ApiDeps: the DI container
        │   index.ts               ← composition root: construct + inject
        ▼
web: lib/api.ts                   ← typed REST/WS client method              (client surface)
        │
web: hooks/use<X>.ts              ← data hook, useLive(refresh, msg.t==='x.changed')
        │
web: pages/<X>.tsx                ← page component (ui.tsx kit)
        │   modules.tsx            ← nav entry + permission + shortcut
        │   App.tsx Route()        ← hash → page, guard(can(perm), <Page/>)
```

See `companion-add-backend-area` and `companion-add-web-area` for the exact
step-by-step recipes.

## Layer responsibilities (companiond)

- **`store/`** — one class per domain (`ProposalsStore`, `RunsStore`, …), each
  taking `Database.Database` in its constructor. Prepared SQL, row⇄DTO mapping.
  Composed in `store/db.ts` (`class Store`). Rows are the source of truth for
  run/proposal/spec **lifecycle**; issues & PRs are a **cache of GitHub**.
- **Domain services** (`proposals/`, `triage/`, `prs/`, `pipelines/`, `runs/`,
  `github/`, `automations/`, …) — business logic. Constructor-injected deps
  (`store`, `orchestrator`, `checkouts`, `broadcast`, a GitHub client factory).
  Every state change ends with a `broadcast({ t: 'x.changed' })`.
- **`http/router.ts`** — the `route()` factory + `Router.dispatch`. Auth,
  zod body parsing, param typing, and error→status mapping happen here, centrally.
- **`http/routes/<area>.ts`** — `export function <area>Routes(deps): CompiledRoute[]`.
  Pure declarations; no auth logic (the router enforces `access`).
- **`http/deps.ts`** — `ApiDeps`, the single injection surface routes can reach.
- **`index.ts`** — the composition root. Constructs everything once, wires
  `broadcast` (which also nudges services on run lifecycle), starts the server.

## Non-negotiable invariants

Break one of these and the change is wrong even if it typechecks.

1. **RBAC is enforced once, centrally.** Every route declares `access`
   (`Permission | 'public' | 'any'`); `Router.dispatch` calls `auth.require`.
   Handlers must **never** re-check permissions. The SPA mirrors the same
   `Permission` in `modules.tsx` + `App.tsx guard()`. A capability is threaded
   end-to-end by the type system — see `companion-contract-and-rbac`.
2. **The contract is the single source of truth.** Any type crossing the
   client/server boundary lives in `packages/contract`. Never redefine a DTO
   locally on either side; import it.
3. **GitHub stays authoritative.** `issues`/`prs` tables are a sync cache. Only
   `github/sync.ts` or an explicitly-applied action mutates them. Don't treat
   the cache as the record of truth, and don't write to it from unrelated code.
4. **Mutations broadcast.** After a service changes state, `broadcast` the
   matching `{ t: '<area>.changed' }`. The SPA is live; a silent mutation is a
   stale UI.
5. **Gateway processes are cattle, rows are pets.** Run/proposal lifecycle
   survives daemon restarts via the DB (`orchestrator.recover()`,
   `resetDangling()`); moxxy processes are disposable and re-derived.
6. **ESM import suffix.** Relative imports end in `.js` even from `.ts` sources
   (`from '../router.js'`). NodeNext resolution requires it. See
   `companion-code-standards`.

## Build, run, verify

```sh
pnpm install            # corepack enable first; pnpm 10, Node >= 20
pnpm dev                # companiond :8901 + Vite :5173 (proxies /api,/ws)
pnpm build              # tsc across the workspace (+ vite build for web)
pnpm typecheck          # THE quality gate — there is no linter and no test suite yet
```

There is **no ESLint/Prettier config and no test framework** wired up. The
quality bar is: `pnpm typecheck` is clean, and the code reads like its
neighbours. When you change `packages/contract`, both apps see it through
`workspace:*` — run `pnpm typecheck` at the root to catch breakage on both sides.

## When you're about to…

- **Add a whole new area** → `companion-add-backend-area` + `companion-add-web-area`.
- **Add/relax a permission or a DTO** → `companion-contract-and-rbac`.
- **Touch the database** → `companion-store-and-migrations`.
- **Write any code** → `companion-code-standards` (mechanics) and
  `craft-principles` (design).
- **Reason about cost or review a change** → `performance-and-complexity`,
  `critical-thinking`.
