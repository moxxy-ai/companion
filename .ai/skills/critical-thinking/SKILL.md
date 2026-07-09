---
name: critical-thinking
description: >-
  A disciplined way to pressure-test your own work before calling it done —
  adversarial self-review, edge-case and failure-mode enumeration, checking a
  change against Companion's invariants, and separating what you've verified
  from what you're assuming. Use before finishing a nontrivial change or when
  reviewing a diff. The goal is to find the bug/gap yourself first, and to state
  confidence honestly rather than defaulting to "looks good".
---

# Critical thinking & self-review

Treat your own diff as something to *disprove*, not confirm. Most defects come
from the case you didn't picture and the assumption you didn't check. This skill
is the habit of looking for those on purpose.

## First, separate verified from assumed

Before you claim something works, sort your beliefs into two piles:

- **Verified** — you read the code, ran it, saw the output, or the typechecker
  proved it. State these plainly.
- **Assumed** — "the caller always passes a valid id", "this list is small",
  "the WS event fires here". Each assumption is a candidate bug. Either verify
  it (read the caller, check the schema, run it) or say it's unverified. Don't
  launder an assumption into a conclusion.

Report honestly: "typecheck passes and I drove the create path; I did **not**
test the concurrent-delete case" beats a confident "done."

## Adversarial pass — try to break it

For the change in front of you, actively look for:

- **Boundaries**: empty list, single element, max size; `0`, negative,
  off-by-one; first/last iteration; the `limit`/`offset` past the end.
- **Absence**: `null`/`undefined`/missing field, not-found row, empty string vs.
  absent (`SettingsStore` treats `''` as "inherit" — did you preserve that?),
  `noUncheckedIndexedAccess` means every index can be `undefined`.
- **Failure**: the DB throws, the GitHub call 404s/rate-limits, the moxxy
  gateway dies mid-run, the network drops. What state is left behind? Is it
  recoverable on restart (`resetDangling`, `orchestrator.recover`)?
- **Concurrency & order**: two requests race the same row; a WS event arrives
  before the initial load; a run completes while the user navigates away; a
  broadcast fires before the record is committed.
- **Auth & scope**: can a `business` role reach this? A non-member of a private
  workspace? Did the route declare the *right* `access`, and does the SPA hide
  it to match?
- **Wrong-but-plausible**: the value that passes the type but is semantically
  wrong (a `repo` cache row trusted as truth over GitHub; a stale token; a
  count computed before a filter).

If you can construct concrete inputs that produce a wrong output or a crash,
that's a finding — fix it or flag it, don't hand-wave it.

## Check it against the invariants

Run the change past Companion's load-bearing rules (see
`companion-architecture`) — a diff can typecheck and still violate one:

- Is auth enforced *only* in the router, not re-checked (or newly *skipped*) in
  the handler?
- Does every cross-boundary type come from `contract`, not a local redefinition?
- Is the GitHub cache still treated as a cache (only sync/applied actions write
  it)?
- Does every mutation `broadcast` its `*.changed` event, and does exactly one
  client hook consume it?
- Is the migration additive and idempotent, safe on a fresh DB *and* an old one?
- New dependency added — is it justified, or does the platform already cover it?

## Question the design, not just the code

- **Is this the right layer?** Business logic creeping into a store class, auth
  logic into a handler, a DTO into a component — right behaviour, wrong home.
- **Is the abstraction earning its keep?** A new interface/flag/parameter: does
  it remove duplicated *knowledge* or decouple independent change, or is it
  speculation (YAGNI) / fear of a visual dup (WET)? See `craft-principles`.
- **What did I make worse to make this work?** Coupling raised, a function that
  now does two things, a name that no longer matches behaviour, a comment left
  lying. Note the trade and whether it's worth it.
- **Simplest thing that could work?** If the diff is large for the problem,
  there's often a smaller design hiding in it.

## Reviewing someone else's diff

Same lenses, plus: read the *surrounding* code the diff assumes, not just the
lines changed — the bug is often in the unchanged caller's expectation. Rank
findings by severity (a correctness/security/data-loss bug outranks a style
nit) and give each a concrete failure scenario (inputs → wrong result), not a
vague worry. Distinguish "this is wrong" from "I'd have done it differently."
Prefer confirmed over speculative; if you're guessing, label it a question.

## Before you say "done"

1. What did I actually verify vs. assume? (state both)
2. Which edge/failure/concurrency cases did I check, and which did I not?
3. Does it hold every relevant invariant above?
4. Is it well-shaped (right layer, no needless abstraction, nothing worsened)?
5. What's the one input most likely to break it — and have I tried it?

Confidence is a claim you should be able to defend with evidence. If you can't,
lower it and say why.
