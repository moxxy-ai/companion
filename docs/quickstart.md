# Your first useful result in ten minutes

This path starts Companion from a GitHub repository you already work on, lets
the CLI connect the active GitHub identity, and ends with review evidence that
has **not** been posted to GitHub. It uses trusted local mode: one OS user, one
loopback-only daemon, no account wizard.

## Before you start

You need Node.js 24 or newer, Git, and an authenticated GitHub CLI:

```sh
node --version
gh auth status
```

For the AI-review step, have one supported runtime signed in on this machine:
Codex, Claude Code or Moxxy. Alternatively, install the **Built-in Agent
Runtime** module after the dashboard opens and configure a model provider.
Companion itself starts and synchronizes GitHub without an agent runtime.

Use a repository you are allowed to connect. An open pull request makes the
first result visible immediately.

## 1. Start inside the repository

```sh
cd path/to/your-repository
npx @moxxy/companion
```

On a fresh home, Companion:

- opens a trusted local superadmin session at <http://127.0.0.1:8901>;
- enables the recommended slim module set from the published full build;
- detects the supported runtimes available on this machine;
- connects the active `gh` identity without printing its token;
- asks whether to add the current repository.

Accept **Add `owner/repository` to Companion?**. If the repository is not
detected from its Git remote, open **Repositories** in the dashboard and use
**Connect repository** instead.

## 2. Confirm the control plane has current evidence

Open **Code & review → Pull requests** and select an open pull request. Its page
brings the diff, checks, merge state and Companion activity together. GitHub is
still authoritative; these records are a synchronized working cache.

If the repository has no open pull request, stop here and inspect **Overview**,
**Issues** or **Today**. Do not manufacture a pull request just to complete a
tour.

## 3. Run a review without publishing it

On the pull-request page, choose **Run review**. Use the default in-depth,
balanced review for the first pass.

The run executes in its own worktree and streams progress back to the pull
request. Findings arrive in Companion as a pending review. Read the evidence,
include or reject individual findings, and open the run transcript when you
want to see how the result was produced.

Nothing is posted by **Run review** itself. Publishing the selected findings is
a separate, explicit action that names the GitHub identity it will use. For this
quickstart, leave the review pending or dismiss it after inspection.

You now have the first complete Companion loop:

```text
GitHub pull request → isolated agent run → CI-aware evidence → human decision
```

## 4. Make the second run safer and more useful

Choose only what matches this repository:

- set a repository verification command so implementation runs receive local
  test/build evidence before review;
- open **Automations** and apply **Watch only** before enabling a more active
  repository preset;
- connect `companion mcp` to Codex, Claude or an IDE when you want the same
  bounded context in your existing agent workflow;
- use **Today** as the return point for reviews, failures and approvals that
  need a person.

For a shared or networked instance, do not widen trusted local mode. Start a
fresh home with `npx @moxxy/companion --with-auth`, or follow the
[Docker/Coolify deployment guide](install.md), then complete the
[controlled company-pilot gate](security/company-pilot.md) before using company
repositories.

## If setup fails

```sh
npx @moxxy/companion doctor
npx @moxxy/companion doctor --json
```

The JSON form is designed for a public bug report and omits credentials,
repository and log contents, absolute paths, and the active GitHub username.
Review it before attaching it anyway.
