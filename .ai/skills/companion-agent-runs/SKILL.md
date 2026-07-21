---
name: companion-agent-runs
description: >-
  How moxxy agent runs work in companiond — the run lifecycle and status
  machine, attended vs unattended runs, one-shot vs interactive/goal runs, the
  Orchestrator + RunnerBackend abstraction, ask/turn/event handling, the token
  ceiling, and boot recovery. Use whenever a feature needs to launch, drive, or
  react to an AI agent run, or when touching orchestration/runners. This is the
  core of the product — read it before building anything agent-backed.
---

# Agent runs (moxxy orchestration)

A **run** is one moxxy session (one `MOXXY_SESSION_ID`) executing on some
**runner** (machine). The `Orchestrator` (`runs/orchestrator.ts`) owns run
lifecycle; it never talks to a gateway directly — it goes through the run's
`RunnerBackend` (`runners/`), so **local and remote execution are
indistinguishable** to everything above it. moxxy is an external CLI runtime;
Companion mirrors only the wire subset it needs in `contract/src/moxxy.ts` and
treats every inbound message as untrusted.

## Run kinds and the status machine

`RunKind` = `interactive | triage | fix | analysis | implement | report |
assistant`. `RunStatus` = `queued → provisioning → running →
{ idle | review } → { completed | failed | stopped | interrupted | abandoned }`.

Two behavioural classes, and the difference drives almost everything:

- **Attended** (`interactive`, `assistant` = AI Help) — a human is in the loop.
  When a turn ends the run goes **`idle`** (gateway live, nothing in flight);
  asks **park in the UI** for the human to answer.
- **Unattended** (`triage`, `fix`, `analysis`, `implement`, `report`, pipeline
  agents) — no human. When the driving turn of a `fix`/`implement` run ends it
  goes **`review`** (a PR/diff awaits human approval). Permission asks are
  **auto-allowed** (`onAsk`) — the real fences are the isolated clone/worktree
  `cwd`, the `permissions.json` deny rules, and the output-token ceiling, **not**
  a human clicking allow.

`setStatus` is the single choke point for transitions and persists the change.
Run lifecycle is audit state, so it never creates inbox notifications; the
owning feature notifies for its action-level success or failure instead. Route
all status changes through `setStatus` — don't write `runs.status` from elsewhere.

## The two ways to run an agent

### One-shot (`orchestrator.runOneShot`) — the default for automation

Create run → send one prompt → await turn completion → return the final
assistant message → reap. It's **queued** (`this.queue`) so batch jobs respect
the pool cap instead of spawning unbounded gateways.

```ts
const { runId, finalMessage } = await this.orchestrator.runOneShot({
  kind: 'triage',
  title: `Triage #${issueNumber}: ${issue.title.slice(0, 60)}`,
  cwd: this.checkouts.cloneDir(repo), // an isolated clone/worktree — the sandbox
  repo,
  issueNumber,
  prompt: buildTriagePrompt(issue, openIssues),
  timeoutMs: 6 * 60_000,             // always bound it
});
const verdict = parseVerdict(finalMessage ?? ''); // see agent-prompting-and-parsing
```

This is how `Triage`, `Proposals` (analysis), `Specs`, `Docs`, and pipeline
agent steps invoke agents. `finalMessage` can be `null` (dead gateway, timeout,
aborted stream) — **never treat null as success**; `runOneShot` marks the run
`failed` in that case and you must handle the null.

### Interactive / goal (`createRun` + `sendPrompt`)

For attended chat and long-running goal work (`fix`/`implement`): `createRun`
provisions the run (placement + backend spawn), then `sendPrompt` drives turns.
The run stays live; the transcript streams to the browser. `fix`/`implement`
runs land in `review` when their turn ends and produce a PR via the shared
`Fixes` machinery.

## Placement, models, runners

`createRun` places the run on a runner: an explicit `runnerId` wins; a
caller-prepared `cwd` pins to local; otherwise `placeRun` picks a ready runner,
**provider-aware** — it resolves the effective model (explicit > per-runner kind
pin > global kind pin > daemon default) to the providers that serve it and
prefers a runner advertising one. A run whose model isn't available on its
runner quietly rides that runner's default. Don't bypass placement; if you
prepare a worktree first, call `placeRun` and pass the resulting `runnerId`.

## Reacting to a run: events, turns, asks

The `Orchestrator` implements `RunnerEventSink` — every backend feeds it:

- `onEvent(runId, event)` — folds `provider_response` token usage into the run
  and enforces `MAX_RUN_OUTPUT_TOKENS` (400k) as the **primary runaway-cost
  guard** (moxxy goal mode is uncapped).
- `onTurnComplete` — resolves `waitForTurn` waiters; flips `fix`/`implement`→
  `review`, attended→`idle`.
- `onAsk` / `onAskResolved` — parks or auto-allows (see attended split above);
  broadcasts `{ t: 'ask' }` / `{ t: 'askResolved' }`.
- `onGone` — gateway died; live runs become `stopped`.

Each of these broadcasts the matching `SpaServerMessage` so the SPA transcript
stays live. If you add run-adjacent state, follow the same broadcast discipline.

## Transcript & history

Live runs stream events over WS; reaped runs keep a readable transcript from the
append-only session **JSONL** on the runner's disk (`moxxy/history.ts`
`readSessionHistory`, paged with a `prevCursor`). Corrupt lines are skipped —
one bad line must never hide the transcript. `finalAssistantMessage` scans the
history backwards for the last non-empty `assistant_message`.

## Boot recovery (rows are the truth)

Gateway processes are cattle; DB rows are pets. On boot the daemon reconciles:
`orchestrator.recover()` marks orphaned live runs `interrupted` and sweeps stale
sockets; services call `resetDangling()` to unstick rows left mid-flight
(a proposal stuck `analyzing`, a spec stuck `generating`). Any new
long-lived agent state needs an equivalent recovery path — assume the daemon can
die at any instant.

## Building an agent-backed feature

1. Write a prompt builder + a zod verdict schema (`agent-prompting-and-parsing`).
2. In your service, call `orchestrator.runOneShot({ kind, cwd, prompt, timeoutMs })`
   against an isolated checkout (`checkouts.cloneDir(repo)` /
   `checkouts.worktree(...)`).
3. Parse `finalMessage`; on null or parse failure, store a `failed` result with
   the error — do not fabricate a verdict.
4. For anything that changes GitHub or the repo, use **review-then-apply**:
   store a `pending` verdict, broadcast, and let a human (or an explicit
   automation) Apply. Nothing touches GitHub inside the run.
5. Broadcast the `*.changed` event; add a recovery path if the row can hang.

See also: `agent-prompting-and-parsing`, `companion-github-integration`,
`companion-security` (why unattended auto-allow is safe), `companion-pipelines`.
