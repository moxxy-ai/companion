# Companion

Companion is a self-hosted engineering dashboard that plugs into GitHub and manages repositories end-to-end with [moxxy](https://github.com/moxxy-ai/moxxy) agents. It can triage issues, review pull requests with CI context, run user-defined PR pipelines, implement proposals into PRs, and automate work through webhooks and schedules.

## What you get

Everything is scoped to a **workspace** (a named group of repositories). Each workspace includes:

- **Proposals** — capture business requests, analyze them, and turn approved proposals into implementation runs.
- **Issues** — sync GitHub issues and launch triage/fix agents.
- **Pull Requests** — review PRs, inspect CI status, and run manual or automatic pipelines.
- **Pipelines** — compose typed steps such as CI gates, AI review, custom agent runs, labels, and comments.
- **Agent Runs** — monitor every moxxy-backed run and its lifecycle.
- **Automations, Repositories, Settings, and Users** — configure workspace behavior and access.

Auth and RBAC are built in. The three roles are `admin` (everything), `maintainer` (day-to-day repo work), and `business` (proposals only). Every REST route declares the permission it requires, and the SPA hides modules the signed-in role cannot use.

Keyboard shortcuts: `g` + a module key jumps between modules, `/` focuses search, and `?` opens the shortcuts cheatsheet.

## Architecture

moxxy is an **external runtime**, not a package dependency in this repository. Companion expects the `moxxy` CLI to be installed and drives it over the moxxy gateway wire protocol.

Every agent run uses its own `moxxy serve` + gateway process pair under an isolated `MOXXY_HOME` inside Companion's data directory (`~/.companion/moxxy-home` by default, `/data/moxxy-home` in Docker). This keeps Companion sessions separate from the user's normal moxxy desktop/TUI/CLI sessions.

## Repository layout

- `apps/companiond` — local daemon: typed route registry + RBAC, auth sessions, run orchestration, gateway pool, GitHub sync/checks, pipeline engine, SQLite store, HTTP+WS server.
- `apps/web` — React SPA served by companiond in production and by Vite in development.
- `packages/contract` — shared domain types, RBAC permissions, REST DTOs, pipeline step unions, and the moxxy gateway wire subset.

## Prerequisites

- Node.js 20 or newer.
- pnpm 10 (Corepack is recommended: `corepack enable`).
- Git.
- Optional for local agent runs: moxxy CLI (`npm i -g @moxxy/cli`). The daemon still starts without it, but agent runs fail until it is installed.
- Optional for Docker bootstrap: Docker and Docker Compose.

## Getting started locally

1. Install dependencies:

   ```sh
   corepack enable
   pnpm install
   ```

2. Create a local environment file:

   ```sh
   cp .env.example .env
   ```

   Edit `.env` and change at least `COMPANION_ADMIN_PASSWORD`. Accounts in `.env` are seed accounts: they are imported once into an empty user store, after which the Users admin module owns accounts.

   A clean setup with no seeded credentials runs first-boot onboarding in the browser instead.

3. Start the development servers:

   ```sh
   pnpm dev
   ```

   This runs companiond on <http://127.0.0.1:8901> and Vite on <http://127.0.0.1:5173>. Vite proxies `/api` and `/ws` to companiond.

4. Open <http://127.0.0.1:5173> and sign in with the seeded admin account, or complete first-boot onboarding.

5. In Settings, add a GitHub token/account for repository sync and agent operations.

## Docker quick start

Docker is the fastest way to bootstrap Companion on a new machine.

1. Create an environment file:

   ```sh
   cp .env.example .env
   ```

   Change the default password before exposing the service beyond localhost.

2. Build and start the stack:

   ```sh
   docker compose up --build
   ```

3. Open <http://127.0.0.1:8901>.

The compose file stores Companion data in the named volume `companion-data` mounted at `/data` in the container. That volume contains the SQLite database, cloned repositories/worktrees, the isolated moxxy home, and daemon config.

Useful Docker commands:

```sh
# Start in the background
docker compose up -d --build

# Follow logs
docker compose logs -f companion

# Stop the service
docker compose down

# Stop and remove persisted Companion data (destructive)
docker compose down -v
```

The image installs `@moxxy/cli` globally so agent runs can start inside the container. If your repositories require SSH access, mount an SSH configuration/key into the container and make sure the key has the appropriate GitHub permissions.

## Configuration

Companion reads configuration from real environment variables, then `./.env`, then `~/.companion/.env` for local runs. In Docker, Compose passes variables from `.env` and sets `COMPANION_HOME=/data`.

Common variables:

| Variable | Default | Description |
| --- | --- | --- |
| `COMPANION_HOST` | `127.0.0.1` | HTTP and WebSocket bind host. Docker Compose sets this to `0.0.0.0` for published ports. |
| `COMPANION_PORT` | `8901` | HTTP and WebSocket port for companiond. |
| `COMPANION_HOME` | `~/.companion` | Data directory for the SQLite DB, cloned repos, worktrees, and isolated moxxy home. |
| `COMPANION_MODEL` | `gpt-5.5` | Default model passed to agent runs. |
| `COMPANION_ADMIN_USER` / `COMPANION_ADMIN_PASSWORD` | unset | Seed admin account. |
| `COMPANION_MAINTAINER_USER` / `COMPANION_MAINTAINER_PASSWORD` | unset | Optional seed maintainer account. |
| `COMPANION_BUSINESS_USER` / `COMPANION_BUSINESS_PASSWORD` | unset | Optional seed business account. |

Advanced daemon settings such as `maxLiveRuns` and `moxxyCliPath` are stored in `${COMPANION_HOME}/companiond.json` after first boot.

## Development commands

```sh
pnpm dev        # run companiond and the Vite web app in development mode
pnpm build      # build all workspace packages
pnpm typecheck  # type-check all workspace packages
pnpm test       # run workspace tests where present
```

## Production build without Docker

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter companiond start
```

After `pnpm build`, companiond serves the built SPA from `apps/web/dist` when present.
