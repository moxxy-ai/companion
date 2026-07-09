---
name: companion-github-integration
description: >-
  How Companion talks to GitHub — the multi-account registry (purposes + shared/
  delegated scopes + owner preference), resolving a client per purpose/context,
  the sync-as-cache model, CI checks snapshots, and webhook secrets/HMAC. Use
  whenever a feature reads or writes GitHub (comments, labels, PRs, checks,
  sync) or when adding a GitHub-backed capability. Tokens never leave the daemon.
---

# GitHub integration

All GitHub access goes through `GitHubAccounts` (`github/accounts.ts`) →
`GitHubClient` (`github/client.ts`). A service **never** constructs a client
from a raw token; it is injected with a resolver and asks for a client *by
purpose* at call time.

## The account registry: purposes, scopes, owners

A connected account is a PAT bound to:

- **purposes** — `fetch | runs | pipelines | webhooks` (`GITHUB_PURPOSES`). What
  the account is allowed to be used for.
- **scope** — `shared` (any workspace) or `delegated` (only its assigned
  `workspaceIds`). Mirrors `RunnerScope`.
- **owner** — `ownerId` is the user who connected it. A **personal** account
  (non-null owner) is usable **only by its owner**, is never a default, and never
  acts for another user. `ownerId: null` = a shared default an admin manages.

`rowFor(purpose, ctx)` resolution order (know this — it decides *whose* identity
acts): **explicit `accountId`** the caller may use → **the invoking user's own**
eligible account holding the purpose → **repo pin** (shared or the caller's own)
→ **shared default** (delegated-to-workspace before shared). With no shared
default, an action gets **no** client — it does not fall back to someone's
personal account.

## Getting a client in a service

Inject a factory and resolve per call; handle `null` (GitHub not configured):

```ts
// constructor
private readonly github: (ctx?: { repo?: string; accountId?: string }) => GitHubClient | null,

// use — the purpose is chosen by the caller wiring in index.ts, the ctx here
const client = this.github({ repo: result.repo, accountId: opts.accountId });
if (!client) throw new Error('GitHub is not configured');
await client.addLabels(repo, issueNumber, dedupe(labels));
```

In `index.ts` the factory is bound to the right **purpose**:
`(ctx) => ghAccounts.clientFor('pipelines', ctx)` for pipeline/triage/review
writes, `'fetch'` for sync/reads, `'runs'` for clone/push tokens, `'webhooks'`
for receiver setup. Choose the purpose that matches what the code does.

The request-scoped invoking user is threaded automatically via
`http/request-context.ts` (`withRequestUser`) so "act as my account" works
without passing a username down every call. Pass an explicit `username` only for
out-of-request contexts (schedules, webhooks).

## Sync is a cache; GitHub is authoritative

`github/sync.ts` fills the `issues`/`prs` tables from GitHub on a cadence and on
demand. **Only sync and explicitly-applied actions write those tables** — see
`companion-store-and-migrations`. Never treat a cached row as the record of
truth for a decision that matters (mergeability, latest state); re-read from
GitHub when correctness depends on freshness. Every sync also refreshes CI
snapshots for the repo's freshest open PRs (`sync.onSynced → prChecks.refreshOpenPrs`).

## CI checks

`prs/checks.ts` folds GitHub's check-runs + commit statuses into a
`ChecksSnapshot` (contract `checks.ts`) stored on the PR. It's the signal behind
the `checks-gate` pipeline step and auto-merge. Fetch/refresh through `PrChecks`;
don't call the checks API ad hoc from unrelated code.

## Webhooks

Repos can generate a webhook **secret**; deliveries are HMAC-verified against the
**raw request bytes** (`readRawBody`, not the parsed body — see
`companion-security`). Public delivery is optional via the moxxy-proxy tunnel
(`webhookTunnel`), which yields a public base URL when up. The `webhooks`
purpose account is used to register/manage the hook on GitHub. Webhook-driven
work (auto-triage, PR gate, auto-run pipelines) runs unattended.

## Client discipline

- `GitHubClient` wraps REST with paging where GitHub's single-shot endpoints
  fail on scale — e.g. PR files use the **paginated files API** so a huge diff
  doesn't 406. Prefer the existing client methods; add one there rather than
  fetching GitHub from a service.
- Rate limits and 404/409s are real; surface them as `HttpError`/logged failures,
  don't swallow. Batch rather than looping per item (`companion-performance-and-complexity`).
- Tokens are write-only across the API boundary: records expose `hasToken`/
  `login`, never the token. Keep it that way.
