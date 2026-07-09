---
name: companion-security
description: >-
  Companion's security & trust boundaries — secrets that must never cross to the
  client, password/session handling (scrypt, hashed tokens, re-verified roles),
  HMAC webhook verification on raw bytes, why unattended agent runs can
  auto-allow yet stay fenced, and treating all moxxy/GitHub/webhook input as
  untrusted. Use when touching auth, tokens, secrets, webhooks, agent
  permissions, or any external input. Read alongside companion-contract-and-rbac.
---

# Security & trust boundaries

Companion holds real credentials (GitHub PATs, model-provider keys, user
passwords) and runs autonomous agents against real repos. These are the boundary
rules; violating one is a security bug even if it typechecks.

## Secrets never cross to the client

- **Tokens/secrets are write-only across the API.** Records expose derived
  facts, not the secret: a GitHub account returns `login` + `hasToken`, never the
  token; a runner returns `hasToken`, never its bearer. Password hashes are
  stripped by `sanitize()` before any `UserRecord` leaves the daemon. When you
  add a secret-bearing record, follow this — return a boolean/derived field,
  never the raw value, and never log it.
- Secrets live in the daemon (DB / env) and the runner's own environment. A
  remote runner receives a per-request git token with each clone/push; it holds
  no standing GitHub credential.

## Passwords & sessions

- Passwords are **scrypt** hashes at rest (`auth/passwords.ts`); compare with the
  constant-time verify, never a plain `===`.
- A session **token** is 32 random bytes; the DB stores only its **SHA-256**
  (`hashToken`). Sessions have a sliding TTL and are pruned.
- **`verify()` re-reads role and `disabled` from the account on every request** —
  so a demotion, disable, or password change takes effect immediately and no
  token can outrank or outlive its account. Role/disable/password changes delete
  the user's sessions. Don't cache authorization off the token; re-resolve it.
- Invariants enforced in `Auth`: always keep **one enabled admin**
  (`guardLastAdmin`); nobody changes their own role or deletes their own account.

## Authorization is central (never re-rolled)

RBAC is enforced once, in `Router.dispatch`, from each route's `access`. Handlers
must not re-check *or skip* auth. Private-workspace membership is a **second**
gate (`canAccessRepo`) on top of role — role says what kind of action, membership
says which workspaces' data. Keep both; don't conflate them. Full mechanics:
`companion-contract-and-rbac`.

## Webhooks: verify HMAC on the raw bytes

Inbound webhooks are HMAC-signed. Verify against the **exact raw request body**
(`readRawBody`) — not the parsed-and-reserialized JSON, which would change bytes
and break the signature. Reject on mismatch before doing any work. The per-repo
`webhook_secret` is the shared key; treat a delivery as untrusted until verified.

## Untrusted input everywhere at the edge

- **HTTP bodies**: validated by zod in the `route()` factory, with size caps
  (`readBody` 2 MB, `readRawBody` 5 MB). Add a schema for new input; don't trust
  shape.
- **moxxy wire events**: the contract subset is *intentionally permissive* and
  every inbound message is runtime-checked where it matters — a newer moxxy
  adding fields or unknown event types must never crash the daemon. Narrow via
  the `type` discriminator; tolerate unknowns (render opaque), skip corrupt JSONL
  lines. Never `as`-cast a wire event into a trusted shape without checking.
- **GitHub responses / model output**: also untrusted. Parse model output
  through `extractModelJson` + zod (`agent-prompting-and-parsing`); handle
  GitHub 404/409/rate-limit rather than assuming success.

## Why unattended agents can auto-allow — and still be safe

Unattended runs (triage/fix/pipeline agents) **auto-allow** permission asks
because no human is present. That is safe *only because of the other fences*, so
never remove them:

1. The run executes in an **isolated clone/worktree `cwd`** — its own sandbox,
   not the user's tree.
2. `permissions.json` **deny rules** are seeded into the moxxy home
   (`seedPermissionDenyRules`) to block dangerous tools.
3. The **output-token ceiling** (`MAX_RUN_OUTPUT_TOKENS`, 400k) is the primary
   runaway-cost guard since moxxy goal mode is uncapped.
4. Read-only agents are told **read-only rules** in the prompt and produce only a
   verdict; anything that writes to GitHub goes through **review-then-apply** with
   a permission check (`agent-prompting-and-parsing`).

If you add an unattended path, keep all four; if you widen what an agent may do,
re-justify against them.

## Quick checklist for a security-relevant change

- [ ] No secret/token/hash in any client-bound record, log line, or error.
- [ ] New credential stored server-side; exposed only as a derived flag.
- [ ] Auth enforced by route `access` only — not re-checked/skipped in a handler.
- [ ] External input (HTTP/webhook/moxxy/GitHub/model) validated & size-bounded
      before use; HMAC verified on raw bytes.
- [ ] Unattended agent paths keep the four fences above.
