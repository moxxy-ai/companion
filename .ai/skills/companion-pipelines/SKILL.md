---
name: companion-pipelines
description: >-
  The user-defined pipeline & step system in Companion — pipeline types
  (pr/issue/platform) and the step-kind discriminated union (checks-gate,
  ai-review, agent, label, comment), the "one union member + one handler" way to
  add a step kind, the step library (inline vs ref specs, run-time snapshotting),
  and step results/failure modes. Use when adding or changing a pipeline step
  kind or touching the pipeline engine.
---

# Pipelines & steps

A **pipeline** composes typed steps that run against a target. Its **type**
constrains which step kinds it may contain (`contract/src/pipelines.ts`):

- `pr` → a pull request: `checks-gate`, `ai-review`, `agent`, `label`, `comment`
- `issue` → an issue: `agent`, `label`, `comment`
- `platform` → the repo itself (no PR/issue payload): `agent` only

`PIPELINE_TYPE_STEPS` is the authoritative map; the UI and engine both read it,
so a step kind is only offered where its payload exists.

## The step model

`PipelineStep` is a **discriminated union on `kind`**, each variant carrying its
own `config` shape:

```ts
export interface AiReviewStep extends BaseStep {
  readonly kind: 'ai-review';
  readonly config: { readonly post: boolean; readonly failOn: 'request_changes' | 'high_risk' | 'never' };
}
// … ChecksGateStep | AgentStep | LabelStep | CommentStep
```

`BaseStep` gives every step a `name` and an `onFailure` mode (`halt | continue`).

## Adding a step kind = one union member + one handler

This is the extension pattern the whole engine is built around. To add a kind:

1. **Contract** (`pipelines.ts`): add the literal to `PipelineStepKind`, add its
   `XStep extends BaseStep` interface with a `config`, add it to the
   `PipelineStep` union, and list it under the allowed `PipelineType`s in
   `PIPELINE_TYPE_STEPS`.
2. **Engine** (`pipelines/pipelines.ts`): add the matching `case` handler that
   executes the step against the target and returns a `PipelineStepResult`
   (`status`, `summary`, `detail`, timings). The `PipelineStepKind` switch is
   exhaustive (`noFallthroughCasesInSwitch`) — the compiler forces you to handle
   the new kind.
3. **Web**: the step editor reads the kind list + config shape; add the config
   form for the new kind. (See `companion-add-web-area` for SPA conventions.)

`agent` steps run a bounded moxxy agent with your prompt against the target and
turn its output into a pass/fail verdict — reuse `agent-prompting-and-parsing`
and `companion-agent-runs`, don't invent a second agent path. `ai-review` reuses
the built-in `PrReviews`; `label`/`comment` reuse the `GitHubClient`
(`companion-github-integration`). Compose the existing machinery.

## Step library: definitions, inline vs ref, snapshotting

- A **`StepDefinitionRecord`** is a named, workspace-scoped step saved to the
  library. Editing it updates every pipeline that references it.
- A pipeline's `steps` are `PipelineStepSpec`s: either `{ type: 'inline', step }`
  or `{ type: 'ref', stepDefinitionId, overrides? }`.
- **A run snapshots the resolved step**, so history stays stable even if the
  definition is later edited or deleted (`PipelineRunRecord.steps` are resolved
  `PipelineStepResult`s, and `pipelineName`/`target` are denormalized onto the
  run so it survives pipeline deletion). Preserve this: never make a run's
  displayed result depend on re-resolving a definition that may have changed.

## Execution & results

- `PipelineRunStatus` = `running | passed | failed | error`; each step has a
  `StepResultStatus` (`pending | running | passed | failed | skipped | error`;
  `kind: 'unknown'` when a library ref couldn't resolve).
- **Failure mode** decides flow: `halt` stops the pipeline, `continue` records
  the failure and proceeds. Downstream steps after a `halt` are `skipped`.
- `comment`/`label` steps support template vars (`{{pr.number}}`, `{{pr.title}}`,
  `{{pr.author}}`) — expand them from the target payload.
- Broadcast `pipelineRuns.changed` (per repo) as the run progresses so the SPA
  reflects step-by-step status live.

## Triggers

Pipelines run `manual`ly, or auto on the type's opening event
(`autoRunOnPrOpen` for PR/issue, driven by webhooks — always false for
`platform`). Auto-run flows are unattended; the run's asks are auto-allowed and
fenced as in `companion-agent-runs`.
