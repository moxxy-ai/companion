# Installing and running Companion

Three ways to run it, in order of how quickly they get you into the application.
Configuration for all of them is in [`configuration.md`](configuration.md);
upgrading and rolling back an existing install is covered in
[`upgrades.md`](upgrades.md).

## Prerequisites

- Node.js 24 or newer (Companion stores its data in Node's built-in SQLite).
- Git.
- Optional for agent runs: a supported, authenticated runtime such as Codex,
  Claude Code, or Moxxy. The daemon and dashboard start without one.
- Optional for the Docker path: Docker and Docker Compose.
- Only for building from source: pnpm 10 (`corepack enable`).

## npx

The published CLI contains both the daemon and the built SPA.

```sh
npx @moxxy/companion
```

On first launch Companion selects the slim module set, detects installed agent
runtimes and opens as a local superadmin. There is no login screen. If the
GitHub CLI is authenticated, its active `github.com` identity is attached to
that profile automatically. The token is read from `gh`, sent to the local API,
and never printed or copied into CLI setup data.

The UX is passwordless, but the security model is not: the daemon creates a
real admin and the browser receives an ordinary expiring session. That session
can only be bootstrapped while `authMode` is `local` and the daemon is bound to
`127.0.0.1`, `::1`, or `localhost`; any network bind fails startup. The session
endpoint also rejects non-loopback `Host`/`Origin` values, so DNS rebinding does
not turn a trusted-local instance into an attacker-controlled origin.

For Companion accounts and sign-in, initialize a fresh home with:

```sh
npx @moxxy/companion --with-auth
```

`npx @moxxy/companion init` prepares the data directory without starting the server. `--no-open`,
`--port` and `--home` do what they sound like.

`--background` keeps the terminal out of it. Setup and the first-run questions
still run in front of you, but the daemon is started detached and survives the
CLI and the shell that ran it:

```sh
npx @moxxy/companion --background
npx @moxxy/companion stop
```

If startup or runtime detection does not behave as expected, run:

```sh
npx @moxxy/companion doctor
npx @moxxy/companion doctor --json   # redacted output suitable for a public issue
```

The report checks Node, Git, `gh`, the data directory, bind, daemon and agent
runtimes. It deliberately excludes credentials, repository and log contents,
absolute paths, and the active GitHub username.

Its output goes to `~/.companion/companiond.log`, rolled at 5 MB with one
previous file kept, since nothing is watching the screen. `stop` sends SIGTERM
to the pid recorded in `instance.lock` and waits for the daemon's own shutdown,
escalating to SIGKILL only if that hangs; it therefore stops whatever holds that
data directory, including a daemon started in the foreground. Starting a second
time while one is already up prints where it is and opens a browser rather than
waiting out the instance lock.

Under a supervisor (pm2, systemd, Docker), keep using the supervisor's own start
and stop: `stop` kills the process, and a supervisor will simply start it again.

The published package is a `full` build, so every bundled module is available.
First launch enables the recommended slim module set; install the rest later
from the Modules page, or set `COMPANION_PROFILE=full` on a fresh scripted
install to enable the full first-run selection, including planning,
contribution-quality and Playground modules. OIDC, the built-in runtime and
other security-sensitive modules remain explicit installs. A Docker or source
build is needed only for a different compiled build profile. See
[`development.md`](development.md#build-profiles-what-ships) for the distinction
between what an artifact contains and what an instance has enabled.

### The first admin: wizard, or seeded from the environment

With password auth and no credentials in the environment, an instance with an
empty user store sends you through first-run setup in the browser. This is the
daemon/Docker behaviour, not the trusted local npx flow. The form also requires
the one-time capability written with mode `0600` to:

```sh
$COMPANION_HOME/bootstrap-token
```

Read it on the host running Companion, enter it once, and do not send it through
chat or logs. Companion stores only its digest in memory and deletes the file
after the administrator is created. For unattended provisioning, set a random
`COMPANION_BOOTSTRAP_TOKEN` of at least 32 characters through your secret
manager; it is ignored after the first account exists.

`COMPANION_ADMIN_USER` + `COMPANION_ADMIN_PASSWORD` **replace that ceremony**: the
account is seeded on the first boot that finds no users, and the setup screen
never appears. That is the normal shape for a container deployment, and it is
worth knowing before you go looking for a setup step that is not coming.

Those variables are seeds, not state. They are read only while the user store is
empty, after which the database is authoritative and the Users page owns
accounts. Two consequences: changing the variable later does nothing, and
recreating the database re-seeds the account with whatever the variable says
now, discarding a password changed in the UI.

## Docker

Every release publishes a ready-made image to GitHub Container Registry, so
the first Docker path is a pull, not a build:

```sh
docker pull ghcr.io/moxxy-ai/companion
docker run -d --name companion \
  -p 127.0.0.1:8901:8901 \
  -v companion-data:/data \
  -v companion-moxxy:/home/node/.moxxy \
  ghcr.io/moxxy-ai/companion
```

The published image is a `full`-profile build, tagged with each release version
and `latest`; an SPDX SBOM of the image is attached to the matching GitHub
release. Pin the version tag in anything long-lived, and see
[`upgrades.md`](upgrades.md) for moving between versions. Both volumes matter:
`/data` holds Companion's state and `/home/node/.moxxy` holds moxxy's provider
credentials (the vault agent runs authenticate with), which live outside the
database and are lost with the volume. With `COMPANION_BACKUP_DIR` set, the
daemon's scheduled job covers both: verified database snapshots plus a
`moxxy-home-<stamp>.tar.gz` archive of the credential home beside them; see
[`upgrades.md`](upgrades.md).

Building from source stays fully supported and is the path for a custom module
profile. The image runs the same bundle as the npx package: the build stage
compiles the workspace, the runtime stage carries only `dist/` plus three
runtime dependencies.

```sh
cp .env.example .env      # optional overrides; first login uses the bootstrap token above
docker compose up --build
```

Then open <http://127.0.0.1:8901>.

On a clean Compose volume, retrieve the first-admin capability from inside the
container before completing the browser form:

```sh
docker compose exec companion sh -c 'cat /data/bootstrap-token'
```

For automation, inject `COMPANION_BOOTSTRAP_TOKEN` as a deployment secret
instead. Do not set a fixed value in the Compose file or source control.

Data lives in the named volume `companion-data` at `/data`: the SQLite database,
cloned repositories and worktrees, the isolated moxxy home, and daemon config.
It also contains the generated `secret-key`. A database-only backup excludes
that key by design, so export it to a separate protected backup or mount
`COMPANION_SECRET_KEY_FILE` from your secret manager. A restore refuses an
encrypted database when no matching key is available. To replace that key later,
stop the daemon and run `companion rotate-key`: swapping it by hand leaves every
stored credential unreadable, because nothing re-encrypts them.

Both container targets run the application as the unprivileged `node` account
(uid/gid `1000`). Compose first runs a finite init service which assigns only
the two persisted roots to that account; this also handles Coolify's root-owned
persistent mounts and upgrades from older images. The long-running service
drops every Linux capability, enables `no-new-privileges`, mounts the image
read-only, and gives only `/tmp` an ephemeral, size-bounded writable filesystem.
Do not make state or private keys world-writable as a workaround.

```sh
docker compose up -d --build        # background
docker compose logs -f companion    # follow logs
docker compose down                 # stop
docker compose down -v              # stop and delete all persisted data
```

The module set is a **build argument**:

```sh
docker build --build-arg PROFILE=slim -t companion:slim .   # default
COMPANION_PROFILE=full docker compose up -d --build
```

The image installs `@moxxy/cli` globally so agent runs can start inside the
container. The build arg `INSTALL_MOXXY=false` (`--build-arg INSTALL_MOXXY=false`,
or `INSTALL_MOXXY=false` in the Compose environment) skips that install, which
is what a `cloud`-profile image running only the
[built-in runtime](cloud-runtime.md) wants. If your repositories need SSH,
mount an SSH configuration and key in, and check the key's GitHub permissions.

## Coolify

The image is self-contained (daemon, built SPA, git, moxxy CLI) and ships a
`HEALTHCHECK` against the unauthenticated `/healthz` endpoint, so Coolify can
gate deploys on it. Point Coolify at the repository. `/readyz` additionally
reports whether the kernel booted and every enabled module activated; gate
rollouts on it if your orchestrator distinguishes readiness from liveness. The
container `HEALTHCHECK` deliberately stays on `/healthz`, so one failed
optional module degrades the instance instead of restart-looping the
container.

**Use the Docker Compose build pack.** Both packs can build the image, but the
compose one avoids three separate problems, one of which has no other per-app
fix:

1. **Rolling updates.** One cannot work here: the replacement waits for the data
   directory, so it never becomes healthy, and the old container is not stopped
   until it is. Coolify has **no switch to turn them off**, at either level. They
   happen when four conditions all hold: a healthcheck configured and passing,
   default container naming, not a compose-based deployment, and no host port
   mapping. Choosing this build pack fails the third, and this compose file
   fails the fourth as well, which is the documented way to opt out.
2. **Both volumes.** `docker-compose.yml` declares `companion-data` and
   `companion-moxxy` itself. Under the Dockerfile pack you add persistent
   storage by hand at `/data` **and** `/home/node/.moxxy`, and forgetting the
   second loses every AI provider credential on each redeploy.
3. **The module profile.** The compose file maps `COMPANION_PROFILE` to the
   image's build argument, which is the reliable way to get a `full` build.

Set up:

- **Build Pack**: Docker Compose. Compose file location `/docker-compose.yml`,
  which auto-detection finds at the repository root. If Coolify will not let you
  set it while creating the resource, create it and set it afterwards.
- **Build variable**: `COMPANION_PROFILE=full`, marked as a build variable (the
  per-variable toggle). Leave it unset for `slim`.
- **Environment**: admin credentials, and `COMPANION_PUBLIC_URL` set to your
  domain so SSO has an address to come back to. Webhook delivery is a separate
  setting, see [`configuration.md`](configuration.md#webhook-delivery). Coolify's values
  take precedence over any `.env`. `COMPANION_HOST` and `COMPANION_HOME` are
  already set correctly by the compose file.

- **Domain**: set it on the `companion` service and **include the container
  port**, `https://companion.example.com:8901`. Coolify only infers the port for
  services listening on 80, and Companion listens on 8901. The number tells the
  proxy where to send traffic internally; externally it still serves 443. An
  empty domain field is the usual reason a running instance answers `503`: the
  container is healthy and the proxy simply has no backend to route to.
- **Remove the `ports:` block.** The compose file publishes `8901` for local
  use, and on a public server that serves Companion over plain HTTP on the
  host's IP, bypassing the proxy and TLS entirely, which is where the login form
  and its session cookie would go unencrypted. Coolify's own documentation warns
  that a published port is "outside the control of any proxy configuration".
  Removing it does not re-enable rolling updates: a compose deployment never
  gets one.

To tell the two apart when something is wrong, ask the container directly:

```sh
curl -s http://<server-ip>:8901/healthz    # only while ports: is still published
docker exec -it <container> node -e "fetch('http://127.0.0.1:8901/healthz').then(r=>r.text()).then(console.log)"
```

`{"ok":true}` there plus `503` through the domain is a routing problem, not a
Companion one.

### A redeploy that says the data directory is in use

```
another Companion daemon is already using /data (pid 1 on <container>),
and it kept heartbeating for 75s, so it is still running.
```

The old container was not stopped first, which is a rolling update. There is no
setting to disable those, so the fix is the build pack: see the note above.

It is a deadlock rather than a race, which is why waiting longer never helps.
The replacement waits for the data directory, so it never becomes healthy; the
rolling update does not stop the original until the replacement is healthy; the
original is healthy and keeps writing its heartbeat. The same old container id
turns up in every attempt.

Companion is single-node **because of the filesystem**, not the database. The
home holds clones, worktrees, scratch space, run configs and the isolated moxxy
home. Two daemons sharing it would both run every scheduled job and both check
out the same worktrees, and the damage would be silent. So the second one
refuses instead.

Whatever you change, clear the container that is already stuck, because a
correct deployment still has to get past it:

```sh
docker ps --filter name=<your-app> --format '{{.ID}} {{.Status}}'
docker stop <old-container-id>
```

Zero downtime is active/passive with a second `COMPANION_HOME`, not two daemons
on one volume.

### Deploying the full module set

**The profile is a build argument, not a runtime variable.** Setting
`COMPANION_PROFILE=full` as an ordinary environment variable changes nothing: by
the time the container starts, the module set is already compiled in. In Coolify,
mark it as a **build variable** (the per-variable toggle), or set the build arg
directly.

- **Dockerfile build pack**: build arg `PROFILE=full`.
- **Docker Compose build pack**: `COMPANION_PROFILE=full` marked as a build
  variable, which `docker-compose.yml` forwards to the same build arg.

Confirm it in the **build log**, not on the running instance. That one line
separates three things that look identical from outside:

| In the build log | What it means |
|---|---|
| `profile 'full': 20 module(s)` | The build was right. If the optional modules are still absent, a stale container is running. |
| `profile 'slim': 13 module(s)` | The slim build was selected. |
| no `profile '...'` line at all | Docker reused a cached layer, which also proves the argument never changed: a real change from `slim` to `full` invalidates that layer. |

If you requested `full`, either of the latter two means the full-profile build
argument did not reach this build. Switching to the **Docker Compose** build
pack is the reliable way out, since the compose file maps
`COMPANION_PROFILE` to the build argument itself.

A `full` build still boots with only the slim baseline enabled. The rest ship as
**Available** and an admin adopts them: see
[`operating-modules.md`](operating-modules.md#turning-on-everything-a-full-build-contains).

### Model providers in a container

The image ships the moxxy CLI, but a fresh container has no provider
credentials: there is no `~/.moxxy` to import from and `moxxy init` has never
run. Two ways out.

- **Exec in once.** `docker exec -it <container> sh`, then run moxxy's own
  login with the home pinned into the persistent volume:
  `MOXXY_HOME=/data/moxxy-home moxxy init`. Credentials survive redeploys
  because they live in `/data`. An API-key provider is the right choice on a
  server; OAuth credentials rotate their refresh token on every use and should
  not be shared across machines.
- **Skip local execution.** Leave the container provider-less as a pure control
  plane (UI, GitHub sync, orchestration) and attach [runners](runners.md) that
  already have moxxy configured.

## Behind a reverse proxy (TLS)

Companion expects TLS to terminate at a reverse proxy (Coolify above, or your
own nginx, Caddy or Traefik). Two settings make that topology behave:

- `COMPANION_PUBLIC_URL=https://companion.example.com` enables Secure cookies
  and HSTS and gives SSO, notifications and remote runners their outward
  address.
- `COMPANION_TRUSTED_PROXIES=<proxy IP or CIDR>` names the proxy. Behind a
  proxy every TCP connection arrives from the proxy's own address, so without
  this setting the login throttle keys every sign-in attempt to that one
  address and `X-Forwarded-For` is (correctly) ignored. With it, requests
  arriving from a listed address take the client address from
  `X-Forwarded-For`, using the rightmost hop that is not itself a trusted
  proxy, so a client cannot dodge the throttle by prepending fake hops.
  Connections from any other peer keep ignoring the header entirely. It also
  lets `X-Forwarded-Proto: https` from that proxy mark the session cookie
  `Secure`, so the browser session is not silently downgraded when
  `COMPANION_PUBLIC_URL` was never set. See
  [`configuration.md`](configuration.md#common-variables).

Configure the edge proxy to replace client-supplied `X-Forwarded-Proto` rather
than passing it through. Companion verifies who sent a forwarded header; the
proxy remains responsible for making the header describe the connection it
actually accepted.

Probe endpoints for the proxy or orchestrator: `/healthz` answers 200 as soon
as the process serves HTTP (liveness), and `/readyz` answers 200 only once the
kernel booted and every enabled module activated, with a body listing per-module
states (readiness). `/metrics` serves Prometheus metrics when
`COMPANION_METRICS=1`; a scrape arriving through the proxy is not loopback to
the daemon and therefore needs the `COMPANION_METRICS_TOKEN` bearer.

## From source, without Docker

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter companion-api start
```

After `pnpm build`, the daemon serves the built SPA from `apps/web/dist` when
present.

### Under pm2

`ecosystem.config.cjs` runs the whole suite, daemon plus local runner, as a
managed process:

```sh
npm i -g pm2
pnpm prod                 # pnpm -r build && pm2 startOrRestart ecosystem.config.cjs
pm2 logs companion
pm2 save && pm2 startup   # survive reboots
```

Configuration comes from the daemon's layered environment
(`process env > ./.env > ~/.companion/.env`), so no pm2-specific settings are
needed. The file also has a commented-out entry for serving a `companion-runner`
agent from the same checkout.
