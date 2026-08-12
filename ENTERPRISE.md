# Companion for enterprise

How to run Companion for an organisation rather than one maintainer: which build
to deploy, how to shape access, what a regulated or air-gapped environment needs,
and what is not built yet.

This document is honest about the last part. Sections are tagged **[available]**
or **[not built]**, and the design for anything not built is in
[`docs/internal/modular-distribution.md`](docs/internal/modular-distribution.md),
[`docs/internal/acl-and-roles.md`](docs/internal/acl-and-roles.md) and
[`docs/internal/game-plan.md`](docs/internal/game-plan.md) (internal working
documents). For an actual evaluation, use the
[company-pilot gate](docs/security/company-pilot.md) and retain its evidence.

---

## 1. Which build to deploy **[available]**

The module set of a build is named in `profiles/*.json` and nowhere else:

| Profile | Contains |
|---|---|
| `slim` | Core/workspaces, integrations, execution, repositories/review, CodeRabbit, Jira, notifications, Workbench, administration, planning, board and automations (13 modules) |
| `full` | `slim` + `refinement`, `planner`, `slop`, `playground`, `cursor-bugbot`, `oidc`, `runtime` (20 modules) |
| `cloud` | `slim` + `oidc`, `runtime` (15 modules) |

```sh
pnpm gen:modules --profile slim
pnpm build
```

Deploy `slim` for repository operations and the governed contributor lifecycle.
Use `full` when you also want refinement, idea planning, slop scoring,
experimentation, OIDC and the built-in runtime. Use `cloud` for a hosted control
plane with that runtime and SSO but without the experimental planning/reactor
modules. Every module absent from a build is a module you never have to review,
audit or explain.

Being in the build is not the same as being on: optional modules land as
**Available**, and an admin installs them per instance. So one artifact can
serve teams that want different surfaces.

A third profile, `enterprise` (slim plus modules from a private repo), is the
intended shape for commercial modules. The build mechanism and the licence gate
both work today (§7); what does not exist yet is a commercial module to put
behind them. A module can also be installed **out of tree**, without being in any
profile: see the
[out-of-tree section of `docs/operating-modules.md`](docs/operating-modules.md#out-of-tree-modules).

---

## 2. Deployment **[available]**

Docker is the supported path. The image runs the same bundle the npx package
does, so what CI tests is what you deploy. Pick the module set at build time:

```sh
docker build --build-arg PROFILE=slim -t companion:slim .    # or PROFILE=full
COMPANION_PROFILE=full docker compose up -d --build           # via compose
```

Note that the profile changes **which code is present**, not the image size: the
base image and the moxxy CLI dominate, so slim and full are within a megabyte of
each other. Choose the profile for the surface you are willing to audit.

See the Docker sections of [`docs/install.md`](docs/install.md) for compose,
Coolify and volume details. Three things matter more here than in a single-user
install:

- **Persist both volumes.** `/data` holds the database, clones and the isolated
  moxxy home; `/home/node/.moxxy` holds the provider credentials. Losing the
  second means losing every AI provider on the next redeploy. The daemon and
  runner both execute as uid/gid `1000`, not root; bind-mounted directories and
  secret files must be readable or writable by that identity as appropriate.
- **Back up the database with `companion backup`.** Do NOT `cp` it: in WAL mode
  the most recent commits live in `companion.db-wal`, so copying the main file
  alone yields a database missing them, and copying both without coordination can
  yield a pair that disagree. `backup` uses `VACUUM INTO`, which writes one
  internally consistent file **while the daemon keeps serving**, then verifies the
  result with `integrity_check` before reporting success.
- **Stop it gracefully.** The entrypoint execs the daemon as PID 1, so `docker
  stop` delivers SIGTERM straight to it and every module's `onDisable` runs in
  reverse dependency order. Give it a real timeout (`stop_grace_period`), do not
  `kill -9` a busy instance.

### Companion is a single-node appliance. This is decided.

One daemon, one data directory. Execution scales **horizontally already**, just
not through the daemon: `companion-runner` turns any extra machine into
execution capacity, so the daemon is the control plane and runners are the data
plane. That is the split this product needs.

The reason the database is not the thing to change: the daemon holds git clones,
worktrees, scratch space, run configs and the isolated moxxy home **on local
disk**. Moving state to Postgres would be necessary for multi-node and nowhere
near sufficient, because two daemons would still fight over the same checkouts
and both run every scheduled job. It would cost a rewrite of every store plus an
async conversion across roughly 55k lines of module code, and not deliver the
thing it was for.

What the control plane actually has to survive is a GUI, webhooks and
orchestration. The ceilings you will hit first are GitHub API rate limits and
agent execution capacity, and both of those live somewhere else.

**So, concretely:**

| Requirement | Answer |
|---|---|
| Failover | Active/passive over a shared volume. Recovery time is one daemon boot, measured at about six seconds to healthy. |
| Scale out execution | Add runners. That is what they are for. |
| Backup | `companion backup [file]`, plus the moxxy home volume. |
| Active/active, multi-region | **No.** Not supported, not planned. If you need it, Companion is not the right fit today. |

A second daemon pointed at the same `COMPANION_HOME` **refuses to start** rather
than corrupting state, naming the process that holds it. If you scale replicas
to 2, that is the error you will get, and it is deliberate: give each instance
its own home, or run active/passive. A daemon killed with `SIGKILL` is taken over
immediately on restart, so supervisor restart loops are unaffected.

---

## 3. Accounts and roles **[available]**

Seed the first admin through the environment (`COMPANION_ADMIN_USER`,
`COMPANION_ADMIN_EMAIL`, `COMPANION_ADMIN_PASSWORD`); after that the Users admin
page owns accounts. Passwords are scrypt hashes; sessions are hashed rows.

Three roles are seeded: `admin`, `maintainer`, `business`. **What they hold is
yours to change, and you can add your own.** From the Roles page or the CLI:

```sh
companion role list
companion role create release-manager --title "Release Manager" --from maintainer
companion role revoke release-manager settings:manage
companion user role alice release-manager      # or the Users page
```

Modules only ever grant capabilities to the three built-in roles; a custom role
is composed from the permission catalogue. Adding a role therefore never
requires a code change, and a module upgrade never silently widens a custom role.

Two properties worth knowing:

- **An explicit revoke always wins** over what a module grants. "Maintainers may
  not merge pull requests" is `companion role revoke maintainer prs:act`.
- **Overrides survive a module being disabled.** The permission leaves every
  role while the module is off and comes back exactly as configured when it is
  re-enabled. Nothing is silently discarded.

### Multi-factor authentication **[available]**

Local accounts can carry a TOTP second factor: RFC 6238 (SHA-1, 30-second step,
6 digits, one step of clock skew), self-service enrollment confirmed with a live
code before it turns on, ten single-use recovery codes shown once and stored
hashed, and code attempts rate-limited like password attempts. The secret is
encrypted at rest through the same secret-store seam as every other credential,
so a Vault-backed instance keeps it there. `users:manage` can reset a lost
device from the Users page; the reset is audited like any user mutation. A
wrong-password attempt reads identically with or without MFA, so the login
response does not reveal which accounts are protected. Accounts arriving
through SSO are deliberately not covered: their MFA belongs to the identity
provider (see SSO-only mode in section 6).

### Session administration **[available]**

Sessions have an absolute 7-day lifetime that use never extends, plus an
optional idle timeout (`companion module config core --set idleTimeoutMinutes=30`;
0, the default, disables it). Every user sees and revokes their own sessions on
the Profile page (the current one is flagged; revoking it signs you out), and
`users:manage` can list a user's sessions and sign them out everywhere from the
Users page, which is the same revoke-all a password change already runs.

### Auditing an access decision

```
$ companion acl explain alice settings:manage
DENIED  alice -> settings:manage
  user 'alice' has role 'release-manager'
  owned by module 'core' (enabled): Manage instance settings
  REVOKED by an instance override, which beats every module grant
  hint: companion role reset release-manager settings:manage
```

It names the mechanism, not just the verdict, and distinguishes "no such
permission" from "its module is disabled" from "explicitly revoked here".

### Lockout recovery

Revoking the wrong thing can leave nobody able to fix it through the API. The
instance refuses the operation that would remove the last account able to manage
users, but if you get there another way (direct database edit, an account
deleted out of band), stop the daemon and run:

```sh
companion role repair --grant-admin <username>
```

It edits the database directly and refuses to run while the daemon is reachable,
because a running daemon holds the grid in memory.

---

## 4. Change control **[available]**

**Every mutating API call is audited**, not just RBAC edits. The router is a
single choke point (every route declares the permission it requires), so the
trail covers the whole surface without per-feature instrumentation:

```
actor  status  module  permission      action                            detail
admin  200     core    users:manage    rbac.change                       created role 'auditor'
admin  201     core    users:manage    POST /api/roles
admin  403     core    users:manage    POST /api/roles/:id/permissions
bob    403     core    modules:manage  POST /api/modules/:id/disable
```

Properties that matter for an audit:

- **Refusals are recorded** with the status the caller got, so "who tried and was
  stopped" is answerable, not just "who succeeded".
- **Reads are not recorded.** In an append-only table they would bury the writes.
- The action is the route pattern, so the table groups by action rather than
  fragmenting by id.
- It is a **table**, independent of log level. The CLI starts the daemon at
  `COMPANION_LOG_LEVEL=warn`, so a log-based trail would be missing exactly where
  it matters.
- A failing audit write never fails the request it is recording.
- **Each entry commits to the one before it.** Every row carries a SHA-256 over
  its own fields plus the previous row's digest, so editing an entry, forging a
  digest, or removing one from the middle breaks every link after it.

Read and export it over the API, behind a dedicated `audit:read` permission so a
custom **auditor** role can read the trail and nothing else:

```sh
GET /api/audit?actor=alice&since=<epoch-ms>&limit=100   # newest first, keyset-paged
GET /api/audit/export?since=<epoch-ms>                  # NDJSON, one entry per line
GET /api/audit/integrity                                # recompute the chain
```

`integrity` answers `{ ok, checked, from, to, brokenAt, unchained }`: how many
links were recomputed, over which id range, and the first row that no longer
follows its predecessor. Be precise about what a pass means. It proves no
retained entry was altered and none was removed from the middle. It does not
prove the oldest retained entry is the oldest that ever existed, because
retention deletes from the front and an attacker with database access is
indistinguishable from it; nor does it stop someone who can write the table from
re-chaining it wholesale. `unchained` counts the entries no digest covers.
Forwarding to a collector off this host is what closes both gaps, which is why
`auditForwardUrl` stays the primary control and the chain is defence in depth.

Paging is keyset on `id` (pass the previous page's `nextBefore`), not OFFSET, so
deep pages of a large trail stay cheap. The export is `application/x-ndjson`,
which most log pipelines ingest directly.

**Retention** is the `auditRetentionDays` setting on the Core module (default
365, minimum 7). A daily job sweeps older entries, bounded per run so it cannot
lock the database. Shortening the window is destructive: export first.

In the repo, `pnpm acl check` runs in CI and fails when the effective permission
grid changes without `docs/acl-grid.json` being updated, so "this PR changes who
may do what" is visible in review rather than discovered in production.

**Reading it** is the Audit trail page under Admin, behind `audit:read`: filter by
actor and window, page with keyset (following the API rather than fighting it, so
a deep page does not scan the table before it), tick "refusals only", and export
the window as NDJSON. The export is fetched with the session in a header and
handed to the browser as a blob, never as a URL carrying a token.

**Shipping it out** is `auditForwardUrl` on module-core: an https endpoint that
receives entries as NDJSON batches, optionally signed as
`x-companion-signature-256: sha256=<hex>` over the exact bytes, the same recipe
GitHub uses. This is a stream ALONGSIDE the table, not a replacement:
`provideAudit` exists for a module that wants to own audit storage, and almost
nobody does, because the local table is what answers "who tried and was stopped".

Three properties worth checking before you rely on it:

- **It can never fail the request it describes.** Recording appends to an array;
  every network concern happens on a ten-second timer.
- **It is bounded.** A collector that is down keeps at most 5,000 entries in
  memory, then drops the OLDEST and counts them. The page shows that count,
  because a silent gap is the failure mode that matters, and `/api/audit/export`
  can always backfill.
- **Order survives a retry.** A failed batch goes back to the front of the buffer,
  not the back: a trail that silently reorders is worse than one with a visible
  gap.

**Still not built:** a dedicated audit module taking over storage via
`provideAudit`. The seam is there and untouched by the above.

### Spend control **[available]**

Agent execution is the one thing this instance does that costs money per use, so
it has a ceiling. Two, on module-operate's configuration, both **off by default**:

| Setting | What it does |
|---|---|
| `monthlyBudgetUsd` | Estimated spend the whole instance may reach in a calendar month |
| `userMonthlyBudgetUsd` | The same ceiling applied to one profile's own runs |
| `budgetAlertPercent` | Raise an inbox notification at this much of a ceiling (default 80) |

Enforcement is at the top of run creation, before any side effect, so a refused
run leaves no row, no worktree and no queue entry. The refusal names both
numbers and answers `402`, because the person who hit it did nothing wrong:

```
this instance has spent $412.80 of its $400.00 monthly budget — an administrator
can raise it under Settings, or it resets at the start of next month
```

Three properties worth knowing before you rely on it:

- **It is a stop, not a guarantee.** A run's cost is unknowable before it
  executes, so the check is "already at the ceiling", not "would this run cross
  it". The last run of a period may overshoot.
- **It counts everything, not what the reader may see.** The aggregate ignores
  the per-viewer visibility scoping the dashboard uses; a ceiling that only
  counted your own runs would not be a ceiling.
- **Models with no list price contribute zero, and say so.** Estimates come from
  the one pricing table (`modules/operate/src/contract/model-pricing.ts`), which
  carries Anthropic list prices. Anything else is real money the ceiling cannot
  see, so its token count is reported separately on the budget card rather than
  silently ignored. Prompt caching is not tracked either, which makes estimates
  lean high.

**Where it went** is the Spend page (`settings:manage`), attributing the period
to a person, a kind of work and a repository, priced per model rather than per
bucket average. Attribution is only as old as the `task` column, so runs from
before it show as unattributed rather than being bucketed into a guess.

### What agent work may do **[available]**

The fences that keep an unattended run safe used to be constants. Two of them are
now instance configuration on module-operate, so a security review has something
to read and an auditor something to check:

| Setting | Effect |
|---|---|
| `agentGitWrite` | `refused` makes every agent read-only on every runner |
| `agentGitHubWrite` | `attended` posts only while a person is asking; `refused` never posts |
| `protectedBranches` | Branch patterns agent work may never push to (default `main, master, release/*, prod`) |
| `maxRunOutputTokens` | Per-run ceiling, previously a 400k constant |

Enforced at the credential seam, not per feature: every network git operation on
every runner resolves its write credential through one function on the daemon, so
a caller added next year cannot route around it. The branch gate sits at the two
places that know the branch, both **before** a credential is minted.

Worth knowing precisely what read-only means, because it is narrower than it
sounds: only pushes request write access. Clones, fetches and worktrees ask for
read, so a read-only instance still triages, reviews, screens for slop and
proposes changes exactly as before. It simply cannot land them.

`agentGitHubWrite` is the second axis, and independent of the first: comments,
labels, reviews, merges and PR creation, gated at `GitHubClient`'s single write
path so a method added later is covered without touching the gate.

**`attended` is the setting most people want.** It lets automation analyse, triage
and screen continuously while nothing appears under the instance's GitHub identity
unless a person asked for it in that moment. On a public repository that is the
difference between a useful screening tool and a bot that comments on a stranger's
first contribution unprompted. Verdicts are produced and stored either way; only
publishing them is gated.

Attendance is read from the request-scoped invoker the account resolver already
uses to decide which credential to act as, so it has one definition here rather
than two that drift: work outside an HTTP request (a webhook, a schedule, a queued
run) sees no user and is unattended by construction.

Refusals go to the audit trail (`policy.git-write.refused`,
`policy.push.refused`), and `GET /api/agent-policy` returns the effective policy
to anyone who may launch runs, so being refused is explainable rather than
mysterious.

The other two fences stay in code because they are structural rather than
policy: an agent's isolated worktree, and review-then-apply for everything that
reaches GitHub (which is additionally gated by `prs:act` / `issues:act` /
`slop:act`).

### Proving a diff builds before a person reads it **[available]**

Set a **verification command** per repository (Repositories, or
`PUT /api/repos/:owner/:name/verify-command`, behind `repos:manage`). When an
agent run enters review, that command runs in its worktree on whichever runner
holds it, and the result appears above the diff.

It is executed through a shell, deliberately: the value people put here is
`pnpm -s typecheck && pnpm -s test`. That is not new authority on the machine,
because the agent that just produced the diff had a shell in the same directory,
and the command comes from repository configuration rather than from a request.
The worktree path is checked against the runner's managed root, so a `cwd` from
anywhere else is refused.

"Not verified" is its own state and never renders as a pass. A repository with no
command configured, or a runner agent too old to have the endpoint, says so.

### Being told about it **[available]**

An inbox nobody has open is not an alert. The default build forwards inbox
entries through notification providers configured in **Integrations**: Slack,
Discord, Jira Automation, ntfy or an HMAC-signed webhook. Connections can be
instance-, workspace- or repository-scoped and filtered by notification kind.

It subscribes to a single bus event that every `ctx.notify.emit` raises, so a
module that starts raising notifications later is delivered without a change
here.

**Connections are shared or personal, never both.** A notification carries an
optional recipient and personal connections carry an owner; delivery matches
them 1:1. A shared connection therefore receives team events, while a personal
one receives only what names its owner. The bundled Slack and Discord providers
allow personal destinations because their webhook hosts are fixed and
validated. Arbitrary ntfy and generic webhook hosts remain admin-managed shared
connections. Ownership, secret storage and scope are enforced once by the
integration plane rather than reimplemented by notify.

Properties that matter operationally:

- **Delivery cannot fail the thing it reports.** The inbox row is durable before
  any request is made; a dead destination is recorded, never thrown.
- **The destination URL is a credential** (a Slack webhook URL is enough to post
  into that channel), so the integration plane stores it as a write-only secret
  and never returns it to a browser.
- **A generic webhook body can be HMAC-signed** as `x-companion-signature-256:
  sha256=<hex>`, the same recipe GitHub uses, so a receiver already has code to
  verify it.
- Requests use the daemon's global dispatcher, so an instance behind
  `HTTPS_PROXY` reaches Slack the same way it reaches GitHub. Transient failures
  (429, 5xx, network) get one retry; a 404 gets none. Every final outcome is in a
  14-day delivery log, because a destination that silently stopped working is the
  failure mode that matters.

---

## 5. Modules in a managed environment **[available]**

```sh
companion module list
companion module install <id> --set key=value
companion module disable <id>      # reversible: keeps tables and config
companion module uninstall <id>    # destructive: rolls back migrations, wipes config
```

`install` runs the module's migrations; `uninstall` rolls them back to zero and
clears the ledger, so a re-install starts clean. `uninstall` confirms before
running and requires `--yes` when there is no terminal. There is **no backup
before uninstall**: take one first.

Module configuration is declarative. Fields marked `secret` never leave the
daemon: the read API returns only a set/unset flag.

Modules run **in-process** with the database handle and full filesystem access.
There is no sandbox. Every module in this repo is first-party; treat any future
third-party module as code you are installing on the host, because that is what
it is.

---

## 6. Network and identity constraints **[available]**

### GitHub Enterprise Server **[available]**

Point the instance at a GHES install with two settings, by environment or in
`$COMPANION_HOME/companiond.json`:

```sh
COMPANION_GITHUB_API_URL=https://ghe.corp/api/v3
COMPANION_GITHUB_HOST=ghe.corp
```

`apiUrl` must include the path GHES serves its API under (`/api/v3`); the
resource paths below it are identical to github.com, so everything composes. The
host drives `git clone`, the `gh --hostname` used to adopt the operator's local
identity at boot, and every user-facing GitHub link in the UI (the SPA reads it
from the pre-login bootstrap, so links are correct before anyone signs in).

Verified end to end against a stub API: with `COMPANION_GITHUB_API_URL` pointed
at it, connecting a token performs its `/user` probe against that host and stores
the account it returns.

### Outbound HTTP proxy **[available]**

Set the usual variables; the daemon installs a proxy-aware dispatcher at boot and
every outbound request follows it, including the GitHub REST client.

```sh
HTTPS_PROXY=http://proxy.corp:3128
NO_PROXY=ghe.corp,127.0.0.1,.internal
```

The dispatcher is installed **only** when one of `HTTP_PROXY` / `HTTPS_PROXY` is
set (lowercase accepted), so an instance without a proxy keeps Node's default
request path unchanged. `NO_PROXY` is honoured. The daemon logs which variable it
picked up, so a misconfiguration is visible in the first lines of the log rather
than as an inexplicable timeout.

Verified against a CONNECT proxy three ways: proxy set routes traffic through it,
no proxy variable routes none, and `NO_PROXY` covering the target bypasses it.

Note that `git clone` and the moxxy CLI are separate processes: they read the
same environment, so a proxy set for the container covers them, but they do not
go through this dispatcher.

### SSO sign-in **[available for OIDC; SAML not built]**

An identity module registers `{ id, label, startUrl }` in its `onEnable`, the
login page renders a button per provider, and once the module has verified the
handshake it calls `signInExternal` to mint an ordinary Companion session. Token
verification is deliberately NOT pluggable, so SSO adds nothing to the
per-request path.

Just-in-time provisioning is **off by default** (`externalSignup` on the Core
module) and **can never create an administrator**: provisioning into any role
that holds `users:manage` is refused. A misconfigured identity provider should
lock people out rather than hand over the instance. Accounts created this way get
a password nobody holds, so they are reachable only through their provider.

#### SSO-only mode **[available]**

With providers enabled, password login stays open beside them by default, which
means IdP policy (MFA, offboarding) can be walked around with a local password.
`COMPANION_AUTH_MODE=sso` closes that: password sign-in answers 403, the login
page shows only the provider buttons, and the recovery paths stay what they
were, meaning the bootstrap token still creates the first admin on an empty
instance and the local CLI token keeps working (see
[`docs/configuration.md`](docs/configuration.md)).

#### The OIDC module

Ships in the `full` build, is **not** installed by default (identity is never
something an instance should acquire by accident), and works with Okta, Entra ID,
Auth0, Google Workspace and Keycloak.

```bash
companion module install oidc
companion module config oidc \
  --set issuer=https://example.okta.com \
  --set clientId=0oa1b2c3 \
  --set clientSecret=... \
  --set usernameClaim=preferred_username
companion module enable oidc
```

`COMPANION_PUBLIC_URL` must be set: the provider redirects the browser back to
`$COMPANION_PUBLIC_URL/api/oidc/callback`, which is the redirect URI to register
with the provider. Turn provisioning on separately, and pick the role new
accounts land in:

```bash
companion module config core --set externalSignup=true --set externalSignupRole=business
```

Protocol notes, because a security review will ask:

- Authorization Code with **PKCE (S256)**, `state`, and `nonce`, all single-use.
  The `state` lookup is constant-time.
- The client secret goes in the `Authorization` header, never a query string.
- A signed ID token is mandatory. RS256 and ES256 are verified against bounded,
  cached provider JWKS with exact `kid`/algorithm/key-use matching and one forced
  refresh for key rotation. `none`, symmetric algorithms, ambiguous keys and
  unsupported curves are refused.
- Issuer, subject, audience/authorised party, expiry, not-before, issued-at,
  nonce, optional ACR and maximum authentication age are validated. Userinfo is
  accepted only when its `sub` matches the verified token subject.
- Set `requiredAcr` to one or more space-separated assurance values and
  `maxAuthAgeMinutes` to bind Companion sign-in to the company's IdP MFA/session
  policy. The IdP remains responsible for actually enforcing that assurance.
- Every sign-in is written to the audit log with the issuer and the claimed
  username. The two routes are public GETs, so the router does not audit them
  automatically; the module records the event itself.

SAML is deliberately absent: it needs XML signature verification, which is a
much larger attack surface. Every provider above offers OIDC.

### Where secrets are stored **[available]**

`kind: 'secret'` module config (client secrets, tokens) lives in the SQLite home
by default: one file to back up, one file to protect, no extra service. That is
the right default for an appliance and the wrong one for an organisation that
already keeps secrets in Vault, AWS Secrets Manager or a KMS-wrapped store and
audits them there.

So storage is a seam. A module implements `SecretStore` (`get` / `set` /
`delete` / `keys` / `deleteAll`) and exposes it as `provideSecrets`, the same
shape as `provideAudit`. On enable the kernel **moves** the secrets already
stored into the new backend and deletes the originals, so swapping does not
silently un-configure every module and does not leave plaintext behind in the
file the swap was meant to empty. The provider's own credentials stay in SQLite,
because it needs them to reach the backend it is about to become. Non-secret
config is unaffected.

No Vault module ships. The seam is core work and is done; the backend is a
module anyone can write.

### GitHub App credentials **[available]**

An account connects with a personal access token or with a **GitHub App
installation**. The second exists for the organisation that cannot use the
first: GitHub Enterprise Cloud with SAML SSO requires every token to be
SSO-authorised, and some organisations ban PATs outright.

Create the app, give it Metadata read plus Contents, Issues and Pull requests
read-write, generate a private key, and install it on the organisation. Connect
it from the GitHub accounts page with the App ID, the Installation ID and the
PEM. The key is stored server-side and never sent back to a browser; the
hour-long installation token is cached and re-minted by a background job with a
25-minute margin, so one failed refresh interrupts nothing.

A custom CA works today via `NODE_EXTRA_CA_CERTS` (a Node-level setting, mounted
into the container), which a TLS-intercepting proxy will need. Webhook delivery
need not leave the network either: operate's **Self-managed webhook URL**
(`webhookPublicUrl`) points GitHub at your own ingress and takes precedence over
the moxxy proxy relay, which an internal network often blocks outright.
`COMPANION_PUBLIC_URL` does not feed it; the two are set separately.

The split between OSS core work and what belongs in a commercial module is in
`docs/internal/modular-distribution.md` §10 (internal working document): the
seams are core work, because a separate module cannot change a constant inside
another one.

---

## 7. Licensing and commercial modules **[gate available; modules not built]**

### The entitlement gate **[available]**

A module declares `entitlement: '<feature>'` in its manifest. The kernel then
refuses to install or enable it without a licence granting that feature, and
disables it at boot if the licence lapses.

Install the licence at `$COMPANION_HOME/license.jwt` (in Docker,
`COMPANION_LICENSE_FILE` names a mounted file the entrypoint copies there).
Verification is **offline**: a detached Ed25519 signature over a JSON payload,
checked against the issuer's public key supplied at runtime in the
`COMPANION_LICENSE_KEY` environment variable
(`packages/services/src/license.ts`). There is no licence server, no
activation call and no phone-home, because air-gapped installs are a
requirement rather than an edge case. It is read at boot and at most once a
day, never on a request path.

Refusals name the reason:

```
module 'slop' requires the 'slop-pro' entitlement: licence for ACME Corp expired 2026-07-26
module 'slop' requires the 'slop-pro' entitlement: no licence installed
```

**Expiry degrades, it does not brick.** A licence lapse disables the module at
the next boot with a warning; its tables, its stored configuration and the rest
of the instance are untouched, and everyone can still sign in and administer it.
Renewing the licence and re-enabling restores the module with its configuration
exactly as it was. Verified by running it.

The corollary is worth stating: the gate is enforced at install, enable and
boot, so a licence that expires while the daemon is up is enforced at the
**next boot**, not live. An already-running entitled module keeps running until
then; only new installs and enables are refused immediately.

A deployment with no `COMPANION_LICENSE_KEY` set (every OSS install) satisfies
no entitlement. That is deliberate: an OSS build contains no entitled module,
and a deployment that cannot verify a licence must not pretend it can.

Licence enforcement in a self-hosted, source-available product is a contractual
control with a technical speed bump, not a security boundary. It is designed for
the honest customer and for audit.

### Commercial modules **[not built]**

The intended shape: enterprise modules live in a separate private repository
under a commercial licence and are compiled into an `enterprise` build profile,
while the OSS repository stays MIT and contains no commercial code. The build
mechanism and the gate both support this today; the modules do not exist yet.

---

## 8. Air-gapped operation **[available]**

No telemetry, no update check, no CDN fetch on any boot or request path, and no
external fonts or scripts in the SPA. `NODE_EXTRA_CA_CERTS` covers
TLS-intercepting proxies.

Licence verification is offline by construction: a detached Ed25519 signature
over a JSON payload at `$COMPANION_HOME/license.jwt`, read at most once a day.
No licence server, no activation call, no phone-home.

Modules install from a directory. An out-of-tree module is unpacked into
`$COMPANION_HOME/modules/<id>/` and picked up at boot, so a mounted volume or a
copied tarball is a complete install path with no registry access; everything
else is compiled into the build.

**The blocker for a genuinely disconnected deployment is §6, not this section:**
AI agent runs reach a model provider, and repository sync reaches GitHub.

---

## 9. Getting the parts that are missing

The sequencing, with what each mechanism cost, is in
[`docs/internal/game-plan.md`](docs/internal/game-plan.md) (internal working
document). Every phase P0 to P9 is built.

The full list of what is not built, with what exists in each case, is
[`docs/internal/open-items.md`](docs/internal/open-items.md) (internal working
document). Two of them appear on this page,
and neither is a mechanism: **commercial modules** to put behind the entitlement
gate, and a **Vault or KMS backend** for the secret store. Both seams exist and
are tested; what is missing is a module.

If you are evaluating Companion for an organisation, the two questions worth
raising first are whether you need GitHub Enterprise or an egress proxy (§6),
and whether single-node is acceptable (§2).
