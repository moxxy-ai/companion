<div align="center">

<img src="https://raw.githubusercontent.com/moxxy-ai/companion/main/docs/brand/mark-tile.svg" width="72" height="72" alt="Companion" />

# Companion

**A local-first control plane for software teams and AI agents.**

[![npm](https://img.shields.io/npm/v/@moxxy/companion?color=111&label=npm)](https://www.npmjs.com/package/@moxxy/companion)
[![downloads](https://img.shields.io/npm/dm/@moxxy/companion?color=111&label=downloads)](https://www.npmjs.com/package/@moxxy/companion)
[![node](https://img.shields.io/node/v/@moxxy/companion?color=111&label=node)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@moxxy/companion?color=111&label=license)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/moxxy-ai/companion/actions/workflows/ci.yml/badge.svg)](https://github.com/moxxy-ai/companion/actions/workflows/ci.yml)

```sh
npx @moxxy/companion
```

</div>

---

Companion is the control plane between you and a fleet of coding agents. It syncs
your GitHub repositories, turns issues into reviewed work, runs agents on the
machines you choose, and keeps every action behind a permission you can audit.

One command starts the whole thing: an HTTP daemon, a single-page dashboard, and
a SQLite database, all under `~/.companion`. No container, no Postgres, no
account anywhere.

## Getting started

```sh
npx @moxxy/companion
```

First run selects the slim developer experience, detects installed runtimes and
opens <http://127.0.0.1:8901> as the local superadmin. There is no account form,
password, or onboarding wizard. If `gh` is signed in, its active `github.com`
identity is connected automatically; the token moves from the `gh` keyring to
the local API and is never printed or copied into setup data.

This convenience is deliberately narrow: trusted local mode refuses a bind
other than `127.0.0.1`, `::1`, or `localhost`. For Companion accounts, login and
a shared/networked deployment, use a fresh data directory with:

```sh
npx @moxxy/companion --with-auth
```

Docker and direct daemon deployments use password auth by default. Later runs
reuse the data directory and skip initialization entirely.

For a bounded first workflow, follow the
[ten-minute quickstart](https://github.com/moxxy-ai/companion/blob/main/docs/quickstart.md)
from a checked-out repository to an AI review that has not been posted to
GitHub.

### Without a terminal

`--background` starts the daemon as its own process, detached from the shell.
The small amount of local detection still happens before the CLI returns;
Companion then keeps running, so the terminal can be closed.

```sh
npx @moxxy/companion --background   # start, then hand the terminal back
npx @moxxy/companion stop           # stop it again
npx @moxxy/companion doctor         # diagnose this installation without exposing secrets
```

Output goes to `~/.companion/companiond.log` (rolled at 5 MB, one file kept)
instead of the screen. `stop` reads the pid from the data directory, so it stops
the instance for that `--home` however it was started. Running `npx
@moxxy/companion` again while one is up just opens the browser.

### Non-interactive

```sh
npx @moxxy/companion --yes --no-open
```

| Flag / variable | Effect |
|---|---|
| `--yes`, `-y` | Never prompt; use detected local defaults |
| `--no-open` | Do not open a browser |
| `--background` | Leave the daemon running after the CLI exits |
| `--with-auth` | Create an account-backed installation instead of trusted local mode |
| `--port <n>`, `--host <h>` | Bind somewhere other than `127.0.0.1:8901` |
| `--home <path>` | Use a different data directory |
| `COMPANION_ADMIN_USER` + `COMPANION_ADMIN_PASSWORD` | Seed the first admin for an authenticated installation |

`companion doctor` checks Node, Git, `gh`, the data directory, bind, daemon and
available agent runtimes. `companion doctor --json` prints the same report for a
bug report without credentials, repository contents, log contents, absolute
paths, or the active GitHub username.

Run `npx @moxxy/companion init` to prepare the data directory without starting
the server. The published package contains the `full` build; first run enables
the recommended slim module set, and every other bundled module remains
installable from the Modules page. Set `COMPANION_PROFILE=full` on a fresh
scripted install to enable the full first-run selection, including planning,
contribution-quality and Playground modules. Security-sensitive modules such as
OIDC and the built-in runtime remain explicit installs. Docker or a source build
is needed only when you want a different compiled build profile.

## Running agents

The dashboard works on its own. For agent work, install and sign in to a
supported runtime such as Codex, Claude Code, or Moxxy. Companion detects what
the machine can run, uses the runtime's own default model for Auto, and reads
provider capabilities without copying provider keys into the control plane.

## Managing an instance

Every screen has a CLI equivalent, authenticated by a token the daemon mints at
boot into `~/.companion/cli-token` (mode 0600):

```sh
companion module list                # what is installed, available, or off
companion module install board       # adopt a module (runs its migrations)
companion acl explain alice prs:act  # why a permission is granted or refused
companion role create release-manager --from maintainer
companion user role alice release-manager
companion mcp                        # safe stdio tools for an IDE agent
```

## What you get

- **Repositories.** GitHub as the source of truth, synced and cached, never
  duplicated. Multiple accounts, scoped per workspace, each owned by one profile.
- **Today and AI Help.** One decision queue plus a conversational operator that
  can read broadly and prepare, but never silently execute, platform changes.
- **Issues and pull requests.** Triage, AI review, CI analysis, and fixes that
  arrive as real pull requests.
- **Agent runs.** Every run visible, resumable and attributable, across as many
  machines as you connect.
- **Roles you define.** Three built-in roles, any number of your own, composed
  from the permission catalogue. An explicit revoke always beats a module grant.
- **An audit trail.** Every mutating request, refusals included, with retention
  and NDJSON export behind its own permission.
- **Modules.** Install, enable, disable and configure at runtime. What ships is
  a build profile; what runs is your choice.

## Requirements

- **Node.js 24 or newer** for the dashboard. Nothing is compiled at install time:
  the database is Node's built-in SQLite.
- **git** on `PATH` for repository work.
- **An execution runtime** for agent runs: one of the runtime CLIs
  ([moxxy](https://www.npmjs.com/package/@moxxy/cli), Codex, or Claude Code), a
  configured Companion built-in provider, or a remote runner.

## Data and privacy

Everything lives in `~/.companion`: the SQLite database, cloned repositories,
worktrees, and an isolated moxxy home. Use `companion backup [file]` for a
consistent database snapshot that is safe while the daemon is running; never
copy a live `companion.db` and its `-wal` as a backup. Protect the Companion
secret key and the runtime/provider credential home separately, because neither
is contained in the database snapshot. See the
[upgrade and recovery guide](https://github.com/moxxy-ai/companion/blob/main/docs/upgrades.md)
for the complete procedure. There is no telemetry, no update check and no CDN
fetch on any boot or request path, which is what makes an air-gapped install
possible when the configured Git and model infrastructure is reachable there.

Companion is a **single-node appliance** by design. Execution scales horizontally
through runners; the control plane does not. A second daemon pointed at the same
data directory refuses to start rather than corrupting it.

## Licence

MIT.
