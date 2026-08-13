<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/mark-readme-dark.svg">
    <img src="docs/brand/mark-readme.svg" width="72" height="72" alt="">
  </picture>
</p>

<h1 align="center">Companion</h1>

<p align="center">
  <strong>A local-first control plane for software teams and AI agents.</strong><br>
  Start on a laptop. Run the same stack in your private cloud. Keep every repository,
  agent run, review, and approval under your control.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@moxxy/companion"><img alt="npm" src="https://img.shields.io/npm/v/%40moxxy%2Fcompanion?color=0b7285&label=npm"></a>
  <a href="https://github.com/moxxy-ai/companion/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/moxxy-ai/companion?display_name=tag&sort=semver&label=release"></a>
  <a href="https://github.com/moxxy-ai/companion/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/moxxy-ai/companion/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://www.npmjs.com/package/@moxxy/companion-sdk"><img alt="module SDK" src="https://img.shields.io/npm/v/%40moxxy%2Fcompanion-sdk?color=5f3dc4&label=module%20sdk"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A524-3c9a5f">
  <a href="LICENSE"><img alt="licence" src="https://img.shields.io/badge/licence-MIT-495057"></a>
</p>

---

```sh
npx @moxxy/companion
```

Companion is currently an early-preview `0.x` release and requires Node.js 24
or newer. That command is the whole local install: Companion carries the daemon
and SPA, opens a trusted local superadmin session, adopts the active `gh`
account when one is available, and opens <http://127.0.0.1:8901>. There is no
login or setup wizard. Your SQLite database, cloned
repositories, worktrees, run history, and configuration stay in
`~/.companion`. There is no hosted account to create and no control plane you
must hand your code to.

Need a shared or networked instance? Start a fresh home with
`npx @moxxy/companion --with-auth`, or use Docker/Coolify. Password auth is the
daemon and container default; trusted local mode refuses every non-loopback
bind.

When the team grows, deploy the same application with Docker or Coolify, attach
remote runner machines, and add organisation controls without changing the way
developers work. See [install and deployment](docs/install.md).

Want one bounded path before exploring the platform? Follow the
[ten-minute quickstart](docs/quickstart.md) from a checked-out GitHub repository
to a private, not-yet-published AI review.

<p align="center">
  <img src="docs/media/cli.gif" alt="Companion starts locally, detects available agent runtimes, and opens the application." width="820">
</p>

## Why Companion

AI coding tools are good at doing work. The hard part is giving a team one
reliable place to decide **what should happen**, see **what actually happened**,
and control **what may happen next**.

**Companion is the self-hosted maintainer control plane for GitHub and AI
agents: decide what work should happen, run the right agent, gather the
evidence, enforce CI and policy, and keep a person in control of publication.**

| Start as a maintainer | Start as a developer | Grow into a company deployment |
| --- | --- | --- |
| Turn issues, pull requests, CI and agent work into one decision queue. | Let an agent build without bypassing verification, budgets, protected branches or review. | Add OIDC, custom RBAC, audit export, GHES and private runners to the same workflow. |

| Local-first | Human-controlled automation | Ready for a team |
| --- | --- | --- |
| Code, state, transcripts, and worktrees live on infrastructure you choose. GitHub remains the source of truth. | Agents may read, analyse, draft, review, and prepare typed actions. Sensitive mutations remain explicit and auditable. | Custom roles, scoped API tokens, OIDC, audit export, GitHub Enterprise, proxies, and remote runners are built into the same product. |

Companion connects the pieces that otherwise live in separate terminals,
browser tabs, and bot comments:

```text
GitHub + repository rules ──► Companion ──► local or remote agent runners
                                   ▲                    │
                            AI Help + MCP               │ live progress
                                   │                    ▼
                                   └──── Today + review + approval ──► GitHub
```

GitHub issues and pull requests are synchronized as a cache, never turned into
a competing source of truth. Agent execution can stay on the daemon machine or
move to runners close to the code, credentials, and compute it needs.

## One everyday loop

1. Open **Today**. It contains only work waiting for a human: agent changes,
   review findings, triage, failures, and merge gates.
2. Ask **AI Help** or an IDE agent connected through **MCP** to collect context,
   compare evidence, draft a requirement, or prepare the next action.
3. Let Companion place work on an eligible runner and follow the run live.
4. Review results as they arrive. Large AI reviews publish useful findings
   shard by shard instead of holding everything until the final batch.
5. Confirm the exact action. The owning issue, pull request, specification, or
   run stays authoritative and updates the rest of the platform live.

![The workspace overview shows open issues, pull requests, failing CI, live agents, velocity, and token spend.](docs/media/overview.png)

The interface follows the same model. **Home**, **Workspace**, **Plan & build**,
**Code & review**, and **Agents** are stable outcome-based homes. Business,
Developer, and Admin menu views select useful defaults; each person can then
customize visible pages without changing permissions. Search (`⌘K`) always
reaches every permitted destination.

## What ships today

| Outcome | What Companion provides |
| --- | --- |
| **Decide** | Today, workspace overview, daily digest, AI Help, notifications |
| **Plan** | Ideas, specifications, documentation, refinement, and a task board |
| **Build** | Repository context, issue triage and fixes, agent-created branches and pull requests |
| **Review** | CI-aware pull-request review, incremental AI findings, conflicts, decisions, and typed pipelines |
| **Automate** | Webhooks, schedules, CI gates, agent steps, labels, comments, and delivery integrations |
| **Operate** | Live run transcripts, model and runner placement, spend ceilings, roles, audit, and module lifecycle |

Every surface is actionable. A pull request carries its diff, CI, AI findings,
and pipeline state. A run carries its transcript and resulting change. A
specification can be drafted from repository evidence and saved only after you
review its complete content.

![A tour of issues, pull requests, AI review, pipelines, and live agent runs.](docs/media/tour.gif)

## Open integrations, not a vendor lock-in

Companion exposes a typed integration layer rather than hard-coding vendor
forms into the review or notification screens. An integration module can add a
provider, write-only connection fields, instance/workspace/repository scope,
health checks, capability routing, domain actions, and UI slots. Ordered review
routes support an explicit fallback, but only when the primary is unavailable;
a real provider failure is never hidden by silently trying something else.

The default build currently includes:

| Capability | Available integrations |
| --- | --- |
| **Code review** | Companion native review, [CodeRabbit CLI](https://docs.coderabbit.ai/cli/reference), and [Cursor Bugbot](https://docs.cursor.com/bugbot) |
| **Issue tracking** | Jira Cloud links on GitHub issues and pull requests, cached ticket context, comments, refresh, and workflow transitions such as close or reopen |
| **Team updates** | Slack incoming webhooks, Discord webhooks, Jira Automation, ntfy, and a generic HMAC-signed webhook |

Managed reviewers such as CodeRabbit return a draft to Companion for review.
Delegated tools such as Cursor Bugbot keep ownership of their GitHub result, so
Companion records the hand-off and never pretends that “request accepted” is a
synchronous quality verdict. Jira follows the same boundary: credentials and
connection policy live in the shared integration plane, while linked tickets
and their cached snapshots remain owned by the Jira module.

Additional integrations can ship as in-tree or external modules using
`@moxxy/companion-sdk`. Most need only a provider descriptor and server adapter;
richer modules can inject provider panels, connection actions, repository
sections, and work-item links without modifying the shell. The public SDK also
resolves scoped, write-only credentials for provider-owned actions, so external
modules never depend on Companion's private tables or secret store. See the
[integration architecture](modules/integrations/DESIGN.md) and
[module authoring guide](modules/README.md).

## MCP: Companion where your agent already works

Companion includes a stdio MCP server, so Codex, Claude, an IDE, or another MCP
client can use the platform without a second automation model:

```sh
companion mcp
```

For a local instance, the command automatically uses the owner-only credential
stored in `$COMPANION_HOME/cli-token`. For a shared or remote instance, create a
least-privilege credential in **Settings → API tokens**, choose its permissions
and expiry, then configure the MCP process through environment variables:

```json
{
  "mcpServers": {
    "companion": {
      "command": "companion",
      "args": ["mcp"],
      "env": {
        "COMPANION_URL": "https://companion.example.com",
        "COMPANION_TOKEN": "<scoped-token>"
      }
    }
  }
}
```

The MCP catalog follows the connected user's live role, token scope, workspace
access, and enabled modules. Its core tools can:

- read the Today queue and bounded Companion API state;
- find current issues, pull requests, runs, specifications, and documentation;
- inspect prepared-action status;
- prepare typed actions such as publishing a reviewed result, retrying failed
  work, or saving a complete specification.

There is deliberately no generic `execute` tool. MCP can prepare an exact,
single-use action; a normal Companion session owns the final confirmation. This
makes the same integration useful to a solo maintainer and safe to expose to a
team agent. See [Today, AI Help, and MCP](docs/ai-help-and-mcp.md) for the tool
catalog and safety boundary.

## Local by default. Cloud-ready when needed.

| Start here | Grow into this |
| --- | --- |
| `npx @moxxy/companion` on a developer machine | Docker or Coolify on your own server, VPC, or private cloud |
| Built-in local runner | Any number of remote runners with repository, role, task, and model placement policy |
| Local admin and role presets | Custom roles, explicit revokes, OIDC sign-in, scoped and expiring API tokens |
| Local audit trail | Retention, refusal logging, NDJSON export, and optional SIEM forwarding |
| github.com | GitHub Enterprise Server, configurable endpoints, and outbound proxy support |

Companion has no telemetry, update check, CDN, or licence-server dependency on
its boot and request paths. It can therefore run in private and air-gapped
environments when the Git and model infrastructure it uses is reachable there.

The control plane is intentionally a **single-node appliance**. One daemon and
one data directory keep installation, backup, and recovery understandable.
Execution scales horizontally through `companion-runner`, so additional agent
capacity does not require turning the control plane into a distributed system.
See [Companion for enterprise](ENTERPRISE.md) for the available controls,
deployment shape, and explicit limitations.

## Bring the agent runtime you already use, or bring only a key

Companion detects supported agent CLIs on each runner, and ships one runtime of
its own for machines that have none.

| Harness | Where models come from | Notes |
| --- | --- | --- |
| [moxxy](https://github.com/moxxy-ai/moxxy) | the machine's own providers | Interactive approvals and switching model, provider, or mode mid-session |
| [Claude Code](https://claude.com/claude-code) | its own sign-in | Policy-based approvals; models are reported by the CLI |
| [Codex](https://developers.openai.com/codex) | its own sign-in | Policy-based approvals; reports its model list per session |
| **Companion** (built-in) | **your key, your endpoint** | Nothing to install: a subprocess of the running bundle. Ships in the `full` and `cloud` builds, off by default |

A runner advertises only what is available on that machine, and the built-in
runtime is available wherever Companion is. Companion then chooses an eligible,
online, provider-capable runner and prepares the repository worktree there. See
[runners](docs/runners.md).

### Bring your own key

The built-in runtime calls a model you supply, through the Vercel AI SDK. There
is exactly one place in it that names a vendor, and it is a lookup:

```sh
companion module install runtime
companion provider add "Anthropic" --kind anthropic --key sk-… --model claude-sonnet-5
companion provider test <id> --model claude-sonnet-5   # does it answer, can it call a tool
```

The `runtime` module ships in the `full` and `cloud` profiles. The published
npx CLI and the published image (`docker pull ghcr.io/moxxy-ai/companion`) are
full builds, so the commands above work there as-is; an image built from
source defaults to `slim`, so build it with `--build-arg PROFILE=full` (or
`cloud`) to carry the module.

Four kinds cover the field: `anthropic`, `openai`, `azure` (deployment names and
api-version), and `openai-compatible` for any gateway, so LiteLLM, Portkey,
OpenRouter, Azure AI Foundry's inference endpoint, vLLM and Ollama are a record
rather than a release. Configure them in **Settings → Model providers**, with the
CLI above, or declare them in `companiond.json` with `apiKeyEnv` so a container
ships with its providers. Credentials go to the kernel's secret store, so an
instance pointed at Vault keeps them there and no key ever reaches a browser.

A hosted deployment is then the `cloud` profile with no external CLI at all:

```sh
docker build --build-arg PROFILE=cloud --build-arg INSTALL_MOXXY=false -t companion:cloud .
```

See [the built-in harness](docs/builtin-harness.md), [model providers](docs/model-providers.md)
and [the hosted runtime](docs/cloud-runtime.md).

### Distributed runners

Execution scales by adding machines, and the built-in runtime works on them the
same way it works on the daemon's own: `companion-runner` ships it inside its
own bundle, so a runner is a plain container with no CLI to install and nobody
to sign in.

```sh
npm i -g @moxxy/companion-runner

COMPANION_RUNNER_TOKEN=<shared-secret> \
COMPANION_RUNNER_PROVIDER_KIND=anthropic \
COMPANION_RUNNER_PROVIDER_KEY=sk-… \
COMPANION_RUNNER_MODEL=claude-sonnet-5 \
  companion-runner --background
```

Or as a container, built from this same tree:

```sh
docker build --target runner -t companion-runner .
```

Register the endpoint and token under **Runners** and the machine advertises
what it can actually run, exactly as a machine with moxxy or Claude Code
installed does. Placement, task policy, repository clearance, role fences and
the per-machine concurrency ceiling are the same for every runtime.

The model can come from either side, and only one rule separates them: **a key
crosses to a runner only over https.** The runner endpoint is plain http unless
you made it otherwise, so an http machine carries its own model (above) and one
reached over https can be sent Companion's instead. A machine with neither
reports the runtime as unavailable and names both fixes, rather than accepting
work it cannot finish.

## Modular without becoming fragmented

A small kernel hosts feature modules that can be installed, configured,
enabled, disabled, and uninstalled at runtime. Each module owns its API, data,
permissions, jobs, and UI, while the shell keeps navigation, search, Today, and
the **New** menu coherent.

Modules can also live outside this repository. The published
[`@moxxy/companion-sdk`](https://www.npmjs.com/package/@moxxy/companion-sdk)
provides the supported authoring surface, and `companion module add <spec>`
installs a module from a registry, tarball, or directory.

## Documentation

| | |
| --- | --- |
| [Ten-minute quickstart](docs/quickstart.md) | connect the current repository and inspect a private AI review |
| [Install and deploy](docs/install.md) | npx, Docker, Coolify, and source builds |
| [Today, AI Help, and MCP](docs/ai-help-and-mcp.md) | daily work, programmatic access, and approvals |
| [Runners](docs/runners.md) | multi-machine execution and placement policy |
| [The built-in harness](docs/builtin-harness.md) | the agent runtime Companion owns, its tools and its fences |
| [Model providers](docs/model-providers.md) | bring your own key, endpoint, and model catalogue |
| [The hosted runtime](docs/cloud-runtime.md) | running Companion as a service, module and profile |
| [Pipelines](docs/pipelines.md) | typed automation and review workflows |
| [Configuration](docs/configuration.md) | environment, GitHub Enterprise, and proxies |
| [Security policy](SECURITY.md) | vulnerability reporting, supported releases, and deployment trust boundaries |
| [Security operations](docs/security/README.md) | company-pilot gate, data lifecycle, incident response, restore drill, and current readiness evidence |
| [Releases](docs/releases.md) | immutable versions, generated notes, npm tarballs, checksums, and required repository SBOMs |
| [Upgrades](docs/upgrades.md) | order of operations, the downgrade guard, scheduled backups, and rollback |
| [Permissions and roles](docs/permissions.md) | custom RBAC, API access, and audit decisions |
| [Operating modules](docs/operating-modules.md) | lifecycle and out-of-tree modules |
| [External modules](docs/external-modules.md) | authoring, verifying, and publishing out-of-tree modules |
| [Companion for enterprise](ENTERPRISE.md) | deployment, governance, and honest limitations |
| [Development](docs/development.md) | local setup, profiles, and quality gates |
| [Contributing](CONTRIBUTING.md) | issues, local development, verification, and pull requests |
| [Support and discussions](SUPPORT.md) | help, bug reports, feature proposals, and private security reporting |
| [Writing a module](modules/README.md) | the complete module authoring guide |

## Development

Companion is a pnpm monorepo, strict TypeScript, all ESM:

```sh
pnpm install
pnpm build
pnpm dev
pnpm typecheck
```

- `apps/api` and `apps/web` are the daemon and SPA shell;
- `apps/companion-runner` is the remote execution agent;
- `packages/*` contain the framework, contracts, services, UI, and SDK;
- `modules/*` contain the product domains.

Feature modules follow one vertical contract → store → service → route → client
slice. GitHub remains authoritative, every mutation is permissioned and audited,
and live state travels over the shared WebSocket.

## Licence

MIT. See [`LICENSE`](LICENSE).
