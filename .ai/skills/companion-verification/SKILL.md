---
name: companion-verification
description: >-
  How to verify a change in Companion, which has NO automated test suite and NO
  linter — so `pnpm typecheck` plus driving the real app is the quality gate.
  Covers the typecheck gate, launching daemon+SPA, exercising a route/flow,
  tracing an agent run (transcript, session JSONL, logs), and inspecting the
  SQLite DB. Use before calling any non-trivial change done. Complements the
  built-in run/verify skills and critical-thinking.
---

# Verifying a change in Companion

There is **no test framework wired up** (`pnpm test` runs `-r test` but no
package defines tests) and **no ESLint/Prettier**. So "done" is not "tests pass"
— it's **typecheck clean + I drove the real behaviour and observed it**. Never
claim a runtime change works on types alone.

## 1. The type gate (always)

```sh
pnpm typecheck        # root: tsc --noEmit across all packages
```

This is your first and cheapest gate and it catches a lot *by design*: an
unhandled `SpaServerMessage` variant, an ungranted `Permission`, a missing
`ApiDeps` field, a DTO that drifted between client and server, an exhaustive
switch missing a case. When you change `packages/contract`, run it at the
**root** so both apps are checked (rebuild contract first if not running
`pnpm dev`: `pnpm --filter @companion/contract build`). Fix everything it flags;
do not `any` past it.

## 2. Drive the real app

```sh
pnpm dev              # companiond :8901 + Vite :5173 (Vite proxies /api, /ws)
```

Open <http://127.0.0.1:5173>, sign in (seeded admin from `.env`, or first-boot
onboarding). Then exercise the specific flow you changed:

- **A route**: hit it with a real session token — through the UI, or
  `curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8901/api/…`. Confirm
  the status, the body shape, and that a **wrong role gets 403** and the SPA
  hides the module. Get a token from `localStorage['companion.session']` in the
  browser console, or from a `POST /api/auth/login`.
- **A mutation**: confirm it broadcasts — the SPA list should update **live**
  without a manual refresh (that proves the `*.changed` broadcast + the hook's
  `useLive` predicate are wired). If it doesn't move, the broadcast or the
  predicate is wrong.
- **A UI change**: click it in both light and dark themes and for at least two
  roles (e.g. admin vs. business), since RBAC hides modules.

Prefer the `run` skill to launch/screenshot the app and the `verify` skill for
the end-to-end "drive the affected flow, observe behaviour" loop; this skill is
the project-specific knowledge those build on.

## 3. Verify an agent run end-to-end

Agent features fail in ways types can't catch (prompt drift, parse failure, a
dead gateway). To verify one:

- Trigger it (e.g. Triage an issue) and watch the **run** at `#/runs/:id` — the
  live transcript shows the agent's turns, tool calls, and final message.
- Confirm the **verdict parsed**: the result should be `pending`, not `failed`
  with a parse error. A `failed` result with "could not parse verdict" means the
  prompt/schema drifted (`agent-prompting-and-parsing`).
- For reaped runs, the transcript is read from the session **JSONL** on disk:
  `${COMPANION_HOME}/moxxy-home/**/sessions/<runId>.jsonl` (default
  `~/.companion`). Tail it to see raw events.
- Agent runs need the moxxy CLI + a configured provider. Without them the daemon
  still boots but runs fail — check `/api/status` (`MoxxyStatus`) first.

## 4. Inspect state (SQLite)

The DB is `${COMPANION_HOME}/companion.db` (WAL mode). Read it while the daemon
runs — don't hold a write lock:

```sh
sqlite3 ~/.companion/companion.db "SELECT id, kind, status, outcome FROM runs ORDER BY created_at DESC LIMIT 10;"
```

Useful for confirming a migration applied (`PRAGMA table_info(<table>)`), a row
was written with the shape you expect, or a lifecycle row didn't get stuck.

## 5. Read the logs

The daemon logs structured lines via `log.info/warn/error`. Watch the `pnpm dev`
output (or `pm2 logs companion` in prod) for the `log.warn` you added on the
failure path — a failure that isn't logged is a failure you can't diagnose.

## Before you say done (with `critical-thinking`)

- `pnpm typecheck` is clean.
- I drove the exact flow I changed in `pnpm dev` and **saw** the intended
  behaviour — not just "it compiled".
- Mutations reflect live (broadcast + hook verified); RBAC behaves for a
  low-privilege role.
- Agent changes: the verdict parsed, or the failure is surfaced honestly.
- I can state what I verified vs. what I only assume, and the one input most
  likely to break it. If I couldn't run something, I say so — I don't imply
  coverage that doesn't exist (there are no tests to hide behind).
