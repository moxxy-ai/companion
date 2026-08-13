# Product readiness and adoption matrix

Last verified: 2026-08-13 against Companion `0.16.0` and the open GitHub
backlog. This is the operating record for launch readiness and adoption work;
dated audits remain evidence, while this document says what the team should do
next. Update it when a listed issue closes, a release changes the boundary, or
pilot evidence disproves an assumption.

## Product promise

**Companion is the self-hosted maintainer control plane for GitHub and AI
agents: decide what work should happen, run the right agent, gather the
evidence, enforce CI and policy, and keep a person in control of publication.**

That promise has three entry paths rather than three different products:

| Audience | First outcome | Why Companion, not another agent UI |
| --- | --- | --- |
| Maintainer | Turn issues, pull requests, CI and agent work into one decision queue | GitHub remains authoritative; review, evidence and approval stay connected |
| Developer / vibe coder | Let an agent build without bypassing verification, budgets, protected branches or review | The productive default is an isolated worktree and review-before-apply, not silent mutation |
| Company | Run the same workflow with OIDC, RBAC, audit, GHES, private runners and controlled egress | The control plane and execution placement stay on infrastructure the organisation chooses |

## Current launch boundary

| Audience or deployment | Decision | Required boundary |
| --- | --- | --- |
| Local testers | **Go** | Trusted OS user, loopback-only local mode, approved repositories |
| Solo developers | **Go: early preview** | State `0.x` and Node 24 requirements plainly; do not imply production support |
| OSS maintainers | **Go: governed beta** | Begin read/review-first; stage repository and GitHub write authority |
| Vibe coders | **Conditional go** | Use a guided preset, visible cost/policy defaults and a recoverable first flow |
| External-module authors | **Beta** | Treat every installed module as trusted host code; pin and review its source |
| Named company team | **Conditional pilot** | Complete every row in `docs/security/company-pilot.md` with evidence |
| Public internet / general beta | **No-go** | Independent DAST/pentest plus production proxy, monitoring and runner review |
| Regulated production or compliance claim | **No-go** | Independent control assessment and closure or formal treatment of the remaining security and privacy gaps |

The single-node control plane is a product boundary, not a launch defect.
Execution scales through runners. Do not turn active/active or a database rewrite
into readiness work unless a validated customer requirement changes that
decision.

## Open-issue reconciliation

The backlog is the first source for missing work, but several issue bodies lag
the released product. Reconcile checkboxes only with linked release evidence;
do not treat a branch as shipped.

| Issue | Current disposition |
| --- | --- |
| [#127 — post-launch tracking](https://github.com/moxxy-ai/companion/issues/127) | Keep as the umbrella; this matrix is the prioritised operating view beneath it |
| [#129 — identity lifecycle](https://github.com/moxxy-ai/companion/issues/129) | P1 company blocker: SCIM, IdP group mapping and OIDC logout remain open |
| [#130 — Jira Server / Data Center](https://github.com/moxxy-ai/companion/issues/130) | P2 integration; build after a validated self-managed Jira cohort asks for it |
| [#131 — Linear](https://github.com/moxxy-ai/companion/issues/131) | P2 growth integration for startup/developer workflows |
| [#132 — messaging integrations](https://github.com/moxxy-ai/companion/issues/132) | P2: Slack App OAuth/DM/actions and real Teams verification remain open |
| [#133 — security hardening](https://github.com/moxxy-ai/companion/issues/133) | P0: three items shipped in `0.16.0`; audit chaining is on the current branch; secret-key rotation, default-deny WS declarations and general API rate limiting remain |
| [#134 — enterprise entitlement](https://github.com/moxxy-ai/companion/issues/134) | P1: the gate exists, but no real entitled module proves the commercial lifecycle |
| [#135 — deployability](https://github.com/moxxy-ai/companion/issues/135) | GHES CLI and moxxy-home backup shipped; anonymous GHCR pull was verified on 2026-08-12; the npm publisher one-timer remains and the issue body needs reconciliation |
| [#137 — browser E2E](https://github.com/moxxy-ai/companion/issues/137) | The no-percentage-coverage decision is recorded; the named browser flows remain P0 |
| [#138 — independent assessment](https://github.com/moxxy-ai/companion/issues/138) | External P0 gate for public-internet or regulated-production positioning |

## P0 execution board

Statuses are `done`, `in progress`, `ready`, `external`, or `blocked`. A P0 is
complete only when its exit evidence exists; landing code alone is not evidence
that deployment security works.

| ID | Work | Status | Exit evidence | Source |
| --- | --- | --- | --- | --- |
| P0-01 | Synchronise the product promise, landing page, published CLI README, install/profile documentation and issue state | **In progress** | No known contradiction across those surfaces; npm README prescribes a consistent backup; `slim`/`full` language distinguishes build contents from installed modules | Launch audit |
| P0-02 | Publish a ten-minute first-win path from a checked-out GitHub repository to a connected repo and the first private, unposted review | **In progress** | A new user can follow one path without understanding modules; the path is exercised in a clean home and records time-to-result | Adoption audit |
| P0-03 | Finish the security hardening long tail | **In progress** | Tamper-evident audit chain, secret-key rotation, default-deny WS message policy and general API rate limiting all have red-first tests | [#133](https://github.com/moxxy-ai/companion/issues/133) |
| P0-04 | Deepen browser E2E around silent-regression flows | **Ready** | Password + MFA, provider create/edit/rotate, workspace membership, contribution aliases, theme and module lifecycle fail CI when broken | [#137](https://github.com/moxxy-ai/companion/issues/137) |
| P0-05 | Run an independent authenticated DAST and penetration test | **External** | Agreed scope, production-like proxy and runner boundary, report, triage and retest evidence | [#138](https://github.com/moxxy-ai/companion/issues/138) |
| P0-06 | Recruit a named early-access cohort and operate an evidence loop | **Ready** | At least five approved repositories across maintainer, developer and company-pilot paths; weekly findings have an owner and disposition | Adoption audit |

### P0-03 reconciliation

GitHub issue #133 predates release `0.16.0`. Three findings are already shipped
and should be checked off in the issue after their release evidence is linked:

- seed passwords are removed from the daemon/CLI environment after use;
- a trusted proxy may establish the `Secure` cookie from
  `X-Forwarded-Proto`;
- `/api/status` withholds the GitHub posting identity from callers without
  `github:connect`.

The tamper-evident audit chain is present on the current working branch, but is
not counted as shipped until it merges and release evidence exists. The
remaining implementation work is secret-key rotation, default-deny WS
declarations and general API rate limiting.

### P0-05 rule

Internal tests, CodeQL, dependency review, SBOMs and a clean release are inputs
to the assessment, not a replacement for it. Until #138 has external evidence,
the supported company shape remains the controlled pilot in
`docs/security/company-pilot.md`.

## Hardening and adoption matrix

Priority reflects the next product decision, not only engineering severity.
`Reach` names the audience unlocked; `risk reduced` names the failure or sales
objection removed.

| Priority | Initiative | Reach | Risk reduced / attraction gained | Effort | Tracking |
| --- | --- | --- | --- | --- | --- |
| P0 | Truth synchronisation and one product promise | Everyone | Removes misleading setup, privacy and backup claims; builds trust before first run | Small | P0-01 |
| P0 | Ten-minute first win and persona quickstarts | Developers, maintainers, vibe coders | Reduces time-to-value and hides module vocabulary until it is useful | Small | P0-02 |
| P0 | Security long tail | Companies | Closes audit integrity, key lifecycle, WS exposure and abuse-control objections | Medium | #133 |
| P0 | Browser E2E expansion | Testers, companies | Prevents auth, secret-editor and membership regressions that unit tests miss | Medium | #137 |
| P0 | Independent DAST/pentest | Companies | Converts internal confidence into evidence a buyer can accept | External | #138 |
| P0 | Named beta cohort | Everyone | Replaces assumed demand with observed workflows and referenceable outcomes | Small, ongoing | P0-06 |
| P1 | SCIM, IdP groups and OIDC logout | Companies | Makes account lifecycle operable at team scale | Large | [#129](https://github.com/moxxy-ai/companion/issues/129) |
| P1 | Signed external modules, publisher pinning and install trust ceremony | Module authors, companies | Makes extension provenance understandable before trusted code enters the host | Medium/large | New issue after P0 |
| P1 | Fault injection, runner lease/version negotiation and merge-queue staging | Maintainers, companies | Produces evidence for crash, duplicate work, reconnect and GitHub partial-failure behavior | Large | New issue after P0 |
| P1 | Real entitled module and enterprise profile lifecycle | Companies | Proves the commercial seam with install, expiry, degradation and renewal E2E | Medium | [#134](https://github.com/moxxy-ai/companion/issues/134) |
| P1 | Vault or KMS secret provider | Companies | Integrates with an existing enterprise secret authority | Medium | New module / `open-items.md` §4 |
| P1 | Tenant-wide export, erasure and legal-hold workflow | Companies | Closes a material privacy and procurement gap | Large | New issue after pilot validation |
| P2 | Linear integration | Startups, developers | Meets a common non-Jira planning workflow | Medium | [#131](https://github.com/moxxy-ai/companion/issues/131) |
| P2 | Slack App OAuth/DM/actions and verified Teams delivery | Teams, companies | Moves notifications from passive webhooks into the team's operating loop | Medium | [#132](https://github.com/moxxy-ai/companion/issues/132) |
| P2 | Jira Server / Data Center | Enterprise maintainers | Reaches self-managed Jira estates | Large | [#130](https://github.com/moxxy-ai/companion/issues/130) |
| P2 | Durable notification delivery with retry, dead letters and SLOs | Teams | Makes external delivery observable and recoverable | Medium | `open-items.md` §8 |
| P2 | GitHub rate-limit/backpressure dashboard and circuit breakers | Maintainers, companies | Makes organisation-scale degradation predictable instead of surprising | Medium | New issue after load evidence |
| P2 | Cross-platform install support matrix | Developers | Turns incidental compatibility into an explicit support promise | Medium | New issue after P0 |
| P3 | Module catalogue and publisher reputation | Ecosystem | Creates discovery and distribution after the trust layer and real module supply exist | Large | Deliberately later |
| P3 | Labeled outcome corpus and enforced prompt/model promotion gates | Maintainers, companies | Makes AI quality measurable against real work rather than demos | Large, ongoing | Playground follow-up |
| P3 | Case studies, benchmark flows and reusable policy packs | Everyone | Provides social proof and lets successful configurations travel | Medium | After beta evidence |

## Sequence

1. Finish P0-01 and P0-02 before sending new traffic to the project.
2. Develop P0-03 and P0-04 in parallel; neither replaces P0-05.
3. Start P0-06 with read-only/review-first authority and record setup friction,
   time-to-first-result, false positives, failed runs and recovery paths.
4. Choose P1 work from observed pilot blockers. Identity lifecycle is the
   default enterprise priority; module trust is the default ecosystem priority.
5. Add integrations only when a cohort names the missing system. Do not market
   all modules equally or build a catalogue before there is trusted supply.

## Evidence and learning without telemetry

Companion has no product telemetry by design. Early access therefore uses
explicit evidence rather than hidden phone-home:

- `companion doctor --json` attached voluntarily to setup failures;
- a short opt-in pilot worksheet recording install path, OS, runtime, repository
  type, time-to-first-repo and time-to-first-reviewed-action;
- a weekly review of issues, failed/recovered runs and workflows users returned
  to;
- sanitized screenshots or transcripts only with the operator's approval;
- no production credentials, private source or customer data in public issues.

The adoption signal is not registration count. It is a repository connected,
a useful decision reviewed, and the user returning to Today for another one.

## Maintenance rule

When a row changes state, update this document and its GitHub issue in the same
change window. Link release, test, audit or pilot evidence; do not close a row
because implementation merely exists on a branch. New ideas enter the lower
matrix first and become P0 only when they block the stated launch boundary.
