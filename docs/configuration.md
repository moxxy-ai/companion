# Configuration

Companion reads real environment variables first, then `./.env`, then
`~/.companion/.env` for local runs. In Docker, Compose passes variables from
`.env` and sets `COMPANION_HOME=/data`.

## Common variables

| Variable | Default | Description |
| --- | --- | --- |
| `COMPANION_HOST` | `127.0.0.1` | HTTP and WebSocket bind host. Docker Compose sets `0.0.0.0` for published ports. |
| `COMPANION_PORT` | `8901` | HTTP and WebSocket port. |
| `COMPANION_AUTH_MODE` | `password` | `password` for normal/networked installs; `local` bootstraps a superadmin session and is rejected unless the bind host and browser origin are loopback; `sso` disables password sign-in so only the enabled identity providers admit browser users (see [Sign-in and sessions](#sign-in-and-sessions)). The npx CLI writes `local` unless `--with-auth` is used; Docker pins `password`. |
| `COMPANION_HOME` | `~/.companion` | Data directory: SQLite database, clones, worktrees, isolated moxxy home. |
| `COMPANION_PUBLIC_URL` | unset | Where this instance is reachable: the SSO redirect target, the base for links in outgoing notifications, and the daemon address a remote runner calls back on. Required behind a domain. Webhook delivery is configured separately, below. |
| `COMPANION_BOOTSTRAP_TOKEN` | generated file | One-time capability required to create the first password-mode administrator. Must be at least 32 characters. When omitted, an owner-only token is written to `${COMPANION_HOME}/bootstrap-token`; the file is deleted after setup. |
| `COMPANION_SECRET_KEY` | generated file | Exactly 32 bytes encoded as base64url or 64 hex characters. Encrypts credentials in the default SQLite secret store. Prefer the file form in managed deployments. |
| `COMPANION_SECRET_KEY_FILE` | `${COMPANION_HOME}/secret-key` | File containing the same 32-byte key. Set only one key variable. The generated default is owner-only and excluded from database-only backups. |

Changing either key variable in place does **not** re-encrypt anything: the
stored ciphertext was written under the old key, so a daemon started with a new
one cannot read a single credential. Use `companion rotate-key` (daemon stopped)
to decrypt with the current key and re-encrypt with the replacement in one
transaction. A key held in a file is replaced in place, with the retired one
kept beside it as `secret-key.pre-rotate-<timestamp>`; a key injected through
the environment cannot be installed by the command, so pass the replacement you
have already stored with `--new-key`.
| `COMPANION_ADMIN_USER` / `COMPANION_ADMIN_EMAIL` / `COMPANION_ADMIN_PASSWORD` | unset | Seed admin account. Read only while the user store is empty. The password variables (admin, maintainer and business alike) are deleted from the daemon's own environment once read, so nothing it spawns (git, agent runs) inherits them; the `.env` file itself is untouched. |
| `COMPANION_MAINTAINER_USER` / `COMPANION_MAINTAINER_PASSWORD` | unset | Optional seed maintainer account. |
| `COMPANION_BUSINESS_USER` / `COMPANION_BUSINESS_PASSWORD` | unset | Optional seed business account. |
| `COMPANION_TRUSTED_PROXIES` | unset | Comma-separated IPs or CIDRs of the reverse proxies in front of Companion, e.g. `10.0.0.5` or `172.16.0.0/12,::1`. When the connecting peer matches an entry, the client address (which keys the login throttle) is taken from `X-Forwarded-For`: the rightmost hop that is not itself a trusted proxy. From any other peer the header is ignored, so clients cannot spoof it. The same trust decides whether `X-Forwarded-Proto: https` may mark the session cookie `Secure`. A malformed entry fails startup rather than silently widening or dropping trust. |
| `COMPANION_BACKUP_DIR` | unset | Enables daemon-scheduled daily backups into this directory: a `VACUUM INTO` database snapshot, integrity-checked, plus a `moxxy-home-<stamp>.tar.gz` archive of moxxy's credential home (`~/.moxxy`) when that directory exists. Unset means no scheduled backups; `companion backup` stays available either way. See [`upgrades.md`](upgrades.md). |
| `COMPANION_BACKUP_KEEP` | `7` | How many scheduled snapshots of each artifact to retain. Older ones are pruned after each successful run, snapshots and credential archives independently. |
| `COMPANION_LOG_LEVEL` | `info` | Daemon log verbosity: `debug`, `info`, `warn`, `error` or `silent`. Anything else falls back to `info`. The npx CLI sets `warn` unless started with `--verbose`. |
| `COMPANION_LOG_FORMAT` | `pretty` | `json` emits one JSON object per line (`ts` ISO8601, `level`, `scope`, `msg`, plus the call site's structured fields), which is what a log shipper ingests. Anything else keeps the human-readable format with a full ISO date-time. |
| `COMPANION_METRICS` | unset | `1` serves Prometheus metrics at `/metrics`: process memory and event-loop lag, `companion_http_requests_total` by route pattern and status class, and `companion_ws_connections`. Loopback scrapes need no credential; any other source must present the bearer token below and is refused without it (fail closed). |
| `COMPANION_METRICS_TOKEN` | unset | Bearer token required for non-loopback `/metrics` scrapes (`Authorization: Bearer <token>`). With metrics enabled and this unset, every remote scrape is refused. |
| `COMPANION_STATIC_DIR` | the built SPA beside the daemon | Directory the daemon serves the SPA from. The npx CLI and the Docker entrypoint point it at their bundled SPA; a source checkout needs no override. |
| `COMPANION_LICENSE_KEY` | unset | The licence issuer's Ed25519 public key (SPKI PEM), used to verify `$COMPANION_HOME/license.jwt` offline. Set by enterprise deployments; with it unset (every OSS install) no entitlement is satisfied. See [`../ENTERPRISE.md`](../ENTERPRISE.md) §7. |
| `COMPANION_LICENSE_FILE` | unset | Docker entrypoint only: a mounted licence file copied to `$COMPANION_HOME/license.jwt` at container start, so the licence can arrive as a read-only secret mount. |

Seed accounts are imported once into an empty user store; after that the Users
page owns accounts. See
[`install.md`](install.md#the-first-admin-wizard-or-seeded-from-the-environment)
for what that means in practice.

The secret key and database are a pair. A database snapshot intentionally does
not contain its decryption key; back up the key through a separate secret path.
Losing it makes encrypted GitHub, integration, provider, runner and pipeline
credentials unrecoverable. Copying both still exposes them, so full-volume and
host compromise remain outside application-level encryption's boundary.

`COMPANION_PROFILE` is **not** in this table on purpose. It is read when an
artifact is built, not when one runs. See
[`development.md`](development.md#build-profiles-what-ships).

## Daemon settings

Advanced settings such as `maxLiveRuns` and `moxxyCliPath` live in
`${COMPANION_HOME}/companiond.json`, written after first boot.

## Sign-in and sessions

Browser sessions have an absolute lifetime of 7 days from sign-in. Use never
extends it (there is no sliding window). On top of that, an optional idle
timeout signs out sessions that go unused:

```sh
companion module config core --set idleTimeoutMinutes=30
```

`0` (the default) disables the idle bound. It applies live, without a restart,
to every session, including the local CLI token; the daemon re-mints that token
at start, so a long-idle CLI recovers on the next daemon boot. Activity is
tracked at one-minute granularity, so very small values gain nothing.

`COMPANION_AUTH_MODE=sso` refuses password sign-in (HTTP 403) and the login page
offers only the enabled identity providers. Two recovery paths are unchanged by
design: the bootstrap token still creates the first admin on an empty instance,
and the local CLI token in `${COMPANION_HOME}/cli-token` keeps authenticating
the CLI. If the identity provider is down or misconfigured, those are how an
operator gets back in.

Local accounts can add a TOTP second factor from the Profile page (any
authenticator app; the key is shown as copyable text). An administrator resets
a lost second factor from the Users page.

## Webhook delivery

The GitHub receiver is always the same route on companiond,
`/webhooks/github/<owner>/<repo>`, verified with a per-repo HMAC secret. What is
configurable is how GitHub reaches it. Both settings belong to the `operate`
module, so they live under Settings → Modules → Operate, or:

```sh
companion module config operate --set webhookPublicUrl=https://companion.example.com
companion module config operate --set webhookTunnel=true
```

- **Self-managed webhook URL** (`webhookPublicUrl`): a public HTTPS base URL that
  forwards to companion-api, so deliveries arrive straight from GitHub. This is
  what an instance behind a domain wants, and what an internal network that
  blocks the relay needs. HTTP is accepted only on loopback. It takes precedence
  over the relay, and setting it closes an open relay tunnel so two public
  endpoints are never valid at once.
- **Public webhook delivery** (`webhookTunnel`): exposes the receiver through the
  moxxy proxy relay, with no ingress of your own. The public URL is stable across
  restarts because the subdomain derives from a persisted keypair. This is the
  practical option for a local instance.

`COMPANION_PUBLIC_URL` feeds neither of them. With neither set, installing a
repository webhook is refused rather than half-registered.

## MCP servers for the built-in runtime

External tools an agent run may call. Configure them under Settings → MCP
servers, or declare them in `companiond.json` so a container ships with its
integrations. Each server's one secret arrives by environment indirection and is
substituted wherever `${secret}` appears:

```json
{
  "mcpServers": [
    {
      "id": "inventory",
      "label": "Inventory",
      "transport": "http",
      "url": "https://mcp.acme.internal/mcp",
      "headers": { "authorization": "Bearer ${secret}" },
      "secretEnv": "INVENTORY_MCP_TOKEN",
      "access": ["workspace-write"],
      "tools": ["lookup"]
    }
  ]
}
```

`access` is the run accesses this server serves, and a run whose access is not
listed is never offered its tools. `tools` is an allowlist; omit it to offer
everything the server lists. `transport: "stdio"` takes `command`, `args` and
`env` instead, and the command must be installed on whichever machine runs the
agent. A remote runner is sent these definitions only over https, because they
carry credentials.

## GitHub Enterprise Server

Two settings, by environment or in `companiond.json`:

```sh
COMPANION_GITHUB_API_URL=https://ghe.corp/api/v3   # must include the API path
COMPANION_GITHUB_HOST=ghe.corp
```

They drive the REST client, `git clone`, the `gh --hostname` used to adopt your
local identity at boot, and the GitHub links in the UI. Defaults are github.com.

## Behind an egress proxy

Set `HTTP_PROXY` / `HTTPS_PROXY` and `NO_PROXY`. The daemon installs a
proxy-aware dispatcher at boot when one of them is present, and logs which one it
used. See [`../ENTERPRISE.md`](../ENTERPRISE.md) §6.

Built-in webhook destinations are protected against DNS rebinding by resolving
and validating every answer, then pinning the connection to an approved address
while preserving the original HTTP Host and TLS SNI. A generic HTTP proxy would
perform its own DNS lookup and break that guarantee, so webhook delivery
fails closed when a proxy is active. Enable it only when the proxy independently
blocks loopback, private, link-local, reserved and cloud-metadata destinations:

```sh
COMPANION_TRUST_EGRESS_PROXY=1
```

This flag is an operator assertion, not a proxy configuration mechanism.
