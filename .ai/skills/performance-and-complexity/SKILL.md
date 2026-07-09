---
name: performance-and-complexity
description: >-
  How to reason about time and space cost in Companion and where it actually
  matters — algorithmic complexity, the N+1 / per-row query trap, SQLite
  indexing and server-side paging, bounded memory/retention, and avoiding
  needless React re-renders and refetch storms. Use when a change touches a loop
  over data, a DB query, a list endpoint, or a hot render path. Measure the real
  bottleneck before optimising; keep it simple until profiling says otherwise.
---

# Performance & complexity (grounded in Companion)

Order of operations: **make it correct and clear first, then make it fast where
it measurably matters.** Most code here is not hot — a daemon serving a handful
of maintainers. Spend the complexity budget on the paths that scale with data
(lists, sync, per-run loops), not on micro-tuning cold code. When you do
optimise, know the input size and the current complexity before changing it.

## Complexity: know your input size

- State the growth: is this loop O(n) in issues, O(n·m) in issues×labels, or
  bounded by a constant? Nested loops over two data sets are the usual quadratic
  trap — build a `Map`/`Set` for lookups instead of a nested `.find`/`.includes`.
- Companion example: `NotificationsStore.list` builds an `IN (?, ?, …)` clause
  from accessible workspace ids — one indexed query, not one query per
  workspace. Follow that shape: **fold a fan-out into a single set-based query**.
- `Set`/`Map` membership is O(1); `Array.includes`/`.find` in a loop is O(n)
  each → O(n²). `hasPermission` uses `.includes` on a tiny fixed array (fine —
  bounded); the same pattern over per-request data would not be.

## The N+1 / per-row query trap (the #1 real cost here)

Never issue one query (or one network call) per element of a list.

- Bad: `ids.map(id => db.prepare('… WHERE id = ?').get(id))`.
- Good: one `WHERE id IN (…)` (or a `JOIN`) and map the rows — the store layer
  is the place to express this. GitHub calls are the network analogue: batch/
  paginate (`prFiles` uses GitHub's paginated files API precisely to avoid the
  406 on a single huge diff) rather than looping per item.
- Prepared statements are reusable — prepare once, run many — but that does not
  make N round-trips acceptable; reduce N.

## SQLite specifics

- **Index the columns you filter/sort on.** Companion adds
  `idx_issues_state ON issues(repo, state)`, `idx_runs_status ON runs(status)`.
  A new hot `WHERE`/`ORDER BY` path needs a matching `CREATE INDEX IF NOT EXISTS`
  in `migrations.ts`. An unindexed filter on a growing table is a full scan.
- **Page at the database, not in memory.** List endpoints take `limit`/`offset`
  (+ `q`) and return `{ items, total, facets }` — see `workspaceIssues` /
  `workspacePrs`. Don't `SELECT *` a whole table and `.slice()` in JS; let SQL
  do `LIMIT/OFFSET` and `COUNT`.
- **WAL is on**; keep write transactions short. Wrap a multi-row write in a
  single statement or transaction rather than a JS loop of individual `.run()`s.
- `better-sqlite3` is synchronous — a heavy query blocks the event loop for the
  whole daemon. Keep per-request queries indexed and bounded.

## Memory & space

- **Bound anything that grows per event.** Notifications self-prune past 30
  days on insert; run history and reports should be windowed similarly. An
  unbounded table or in-memory array is a slow leak.
- **Stream/cap large bodies.** `readBody` rejects >2 MB, `readRawBody` caps at
  5 MB. Don't buffer unbounded input or hold a whole large payload if you can
  process it incrementally.
- Prefer references and lazy work to eager copies of big structures; but don't
  contort clear code to save a few KB that never mattered — space optimisation,
  like time, is for the paths where the size is real.

## Frontend: renders and refetch storms

- **`useLive` reloads on a matching WS message.** Make `when` specific
  (`msg.t === 'widgets.changed'`) so an unrelated event doesn't trigger a
  refetch. A too-broad predicate turns every server change into a network round.
- **For high-frequency singular events, patch in place** instead of a full
  reload — `useRuns` patches the one changed run on `run.changed` and only does
  a full `refresh` on the coarse `runs.changed`. Full reload per event on a long
  list is wasteful.
- **Stabilise callbacks.** `refresh` is `useCallback`'d on the active workspace
  so effects don't resubscribe every render; `useLive` reads `when` through a
  ref for the same reason. Unstable deps cause resubscribe/refetch loops.
- Don't compute heavy derived data on every render for large lists; derive
  server-side (facets/counts come from the API) or memoise.

## When to actually optimise

1. Is this path hot — does it run per request, per row, per WS event, or scale
   with repo/issue count? If it's cold boot code, leave it simple.
2. What's the current complexity and input size? Name them.
3. Is there a cheaper shape that stays readable (set lookup, single query,
   index, in-place patch)? Prefer it.
4. Otherwise, measure first. Don't trade clarity for a speedup you haven't shown
   is needed — that violates KISS (see `craft-principles`) for no gain.
