---
name: craft-principles
description: >-
  Design-quality principles — SOLID, KISS, DRY/WET, YAGNI, high cohesion / low
  coupling, composition over inheritance — applied to how THIS codebase is
  built, with concrete Companion examples and the failure modes to avoid. Use
  when designing a module, deciding whether to abstract, or judging if a change
  is well-shaped (not just correct). Principles serve readability; when they
  conflict, favour the simplest thing that a teammate can change safely.
---

# Craft principles (grounded in Companion)

Principles are tools for making code **easy to change safely**, not rules to
satisfy for their own sake. When two pull in opposite directions, optimise for
the next engineer's ability to read and modify the code. Below, each principle
is tied to how Companion already embodies it — imitate these, don't reinvent.

## KISS — keep it simple

The simplest design that fully solves the problem wins. Companion routes hashes
by hand (`location.hash` + a `Route()` switch) instead of pulling in a router;
persistence is hand-written prepared SQL, not an ORM. Both are deliberate: fewer
moving parts, nothing to learn, nothing to break.

- Prefer a plain function to a class, a class to a framework, the platform
  (`fetch`, `node:crypto`, `URLSearchParams`) to a dependency.
- A clever one-liner that needs a comment to decode is not simpler than three
  clear lines. Optimise for reading, which happens far more than writing.
- Signs you've over-built: an interface with one implementer and no second in
  sight, a config flag nobody sets, a layer that only forwards calls.

## DRY — but only for knowledge, not for coincidence

DRY means every *piece of knowledge* has one authoritative home — not that
similar-looking lines must be merged.

- Good DRY in this repo: the `Permission` grid lives once in `contract` and both
  apps consume it; the `route()` factory captures auth+zod+param-typing once;
  `useLive(refresh, when)` is the single data-loop; `rowToX` mappers are the one
  row⇄DTO translation. Copy that instinct — when a rule exists, give it one home.
- **WET trap**: two functions that look alike today but answer to different
  reasons to change. Merging them couples unrelated concerns; the next
  divergent requirement forces an ugly boolean parameter. If unifying needs a
  `mode`/`isX` flag to keep both callers happy, they weren't the same knowledge.
- Rule of thumb: extract on the *second* real duplication with the *same*
  reason to change, not on the first visual resemblance.

## YAGNI — build for today's requirement

Don't add generality for a future that may not come. The daemon adds an area as
"one file + one line" precisely *because* it didn't pre-build a plugin system —
the extension point is the registry array, which is enough.

- No speculative abstraction, config, or parameter "in case." Add it when the
  second concrete case arrives and shows you the real shape.
- Exception: cheap seams that cost little now and are expensive to retrofit —
  e.g. putting a cross-boundary type in `contract` from the start. Those are
  YAGNI-compatible because they're the *simplest correct* choice, not
  speculation.

## SOLID, in this codebase's dialect

- **S — Single responsibility.** One store class per table; one service per
  domain; routes declare, the router enforces, the service decides, the store
  persists. A file has one reason to change. If you're editing a store class to
  change business logic, the responsibility has leaked — move it to the service.
- **O — Open/closed.** Extend by adding, not by editing hot code.
  `buildRoutes()` and `MODULES` grow by one entry; `SpaServerMessage` grows by
  one union member. New behaviour appends; it doesn't rewrite the dispatcher.
- **L — Liskov.** The runner backends (`local-backend.ts`, `remote-backend.ts`)
  are interchangeable behind one `backend.ts` interface — the orchestrator can't
  tell which it holds. A new implementation of an interface must honour the
  whole contract (including null/error semantics), not a convenient subset.
- **I — Interface segregation.** `ApiDeps` is broad, but each service's
  *constructor* takes only the few deps it actually uses (a GitHub-client
  factory, `store`, `broadcast`). Depend on the narrow thing you need, not the
  world. Don't pass `ApiDeps` into a service just because it's handy.
- **D — Dependency inversion.** `index.ts` is the composition root: it
  constructs concretes and injects them; services hold *interfaces/callbacks*
  (`broadcast: (msg) => void`, `github: (ctx) => GitHubClient | null`). No
  service reaches out to `new Store()` or a global — dependencies arrive through
  the constructor. Keep it that way; it's what makes the code testable and the
  wiring legible in one file.

## Cohesion & coupling

- **High cohesion**: things that change together live together — a domain's
  service, store, routes, and contract types form one vertical slice. When you
  touch a feature you touch a predictable, small set of files.
- **Low coupling**: layers talk through narrow contracts — DTOs and callbacks,
  not shared mutable state. The SPA and daemon are coupled *only* through
  `@companion/contract`. Introducing a new back-channel (a global, a duplicated
  type, a direct import across an unintended boundary) raises coupling and is a
  smell — route it through the existing seam instead.

## Composition over inheritance

Companion has essentially no inheritance hierarchy — it composes small classes
and functions (the `Store` facade *holds* store instances; services *hold*
collaborators). Prefer composing behaviour to extending a base class. Reserve
`extends` for genuine `is-a` (e.g. `class HttpError extends Error`).

## Functions & data

- Small, single-purpose functions with explicit return types; push side effects
  (DB writes, broadcasts, network) to the edges and keep the core pure where you
  can (`parseAnalysis`, `rowToX`, `qs`).
- Prefer immutable data — DTOs are `readonly`; build a new object rather than
  mutating. This matches React's model and prevents spooky action at a distance.

## The meta-rule

Before adding an abstraction, ask: *does this remove duplicated knowledge or
decouple things that change independently — today, concretely?* If it only
*might* help later, it's YAGNI; if it only hides a few similar lines, it's WET
fear, not DRY. When unsure, write the simple thing and let the second real case
teach you the abstraction. See `critical-thinking` for how to pressure-test the
decision, and `performance-and-complexity` when the simple thing is too slow.
