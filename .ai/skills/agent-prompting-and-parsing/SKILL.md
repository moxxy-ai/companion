---
name: agent-prompting-and-parsing
description: >-
  How to design agent prompts and robustly turn free-form model output into
  typed, validated data in Companion — the strict-JSON prompt template, tolerant
  extraction (extractModelJson + jsonrepair) followed by zod validation, the
  read-only / review-then-apply safety pattern, context budgeting, and treating
  a missing/invalid result as failure. Use whenever you prompt a moxxy agent for
  a structured verdict or parse anything a model produced. Transferable AI-dev craft.
---

# Prompting agents & parsing model output

Companion drives agents for a *structured verdict* (triage, PR review, proposal
analysis, spec/doc generation). The reliable pattern is: **prompt for a precise
shape → extract tolerantly → validate strictly → treat any miss as failure.**
Study `triage/triage.ts` + `lib/model-json.ts` as the reference implementation.

## 1. Prompt for an exact shape

Prompts are plain template functions (`buildTriagePrompt(issue, others)`) that
produce a single string. The conventions that make output parseable:

- **State the role and the sandbox** up front: "You are triaging a GitHub issue
  for the repository checked out in the current directory."
- **Declare read-only rules explicitly** when the agent must not mutate — this
  is a *prompt-level* fence on top of the process fences:
  > READ-ONLY RULES (mandatory): you may read files and search the codebase, but
  > you must NOT modify/create/delete any file and must NOT run any write command
  > (no git commit/push, no installs). Your ONLY output is the final JSON verdict.
- **Give the exact JSON shape** with types/enums inline, and demand *only* that:
  > reply with ONLY a JSON object (no markdown fence, no prose before or after)
  > matching exactly this shape: { "severity": "critical"|"high"|…, … }
- **Budget the context.** Pass only what's needed and cap it — triage includes
  at most `openIssues.slice(0, 60)` for duplicate detection, titles only. Don't
  dump whole datasets into a prompt; it's slow, costly, and dilutes the task.

Keep the requested enums in lockstep with the zod schema and the contract union
(severity/kind/risk/recommendation) — the prompt, the validator, and the DTO
describe the same shape three times and must agree.

## 2. Extract tolerantly — `extractModelJson`

Models drift despite strict instructions: fenced blocks, prose around the
object, trailing commas, an unclosed array. `extractModelJson(text)`
(`lib/model-json.ts`) tries, in order: the whole trimmed message → an outer
```-fence body → the first **string-aware balanced** `{…}` → a naive first-`{`
to-last-`}` slice → finally `jsonrepair`. Use it; **never** hand-roll a fence
regex — a ``` inside a JSON string value (e.g. a review body suggesting a yaml
snippet) would split the object. Extraction is tolerant *so that* validation can
stay strict; it does not loosen validation.

## 3. Validate strictly — zod, at the boundary

Define a zod schema mirroring the contract DTO and `.parse()` the extracted
value. Bound arrays so a runaway model can't flood you (`labels: z.array(...).max(8)`).

```ts
const verdictSchema = z.object({
  summary: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'trivial']),
  kind: z.enum(['bug', 'feature', 'question', 'docs', 'chore', 'invalid']),
  labels: z.array(z.string()).max(8),
  duplicateOf: z.number().int().nullable(),
  needsInfo: z.boolean(),
  draftReply: z.string(),
});

export function parseVerdict(text: string): TriageVerdict {
  return verdictSchema.parse(extractModelJson(text)) as TriageVerdict;
}
```

## 4. A miss is a failure, never a guess

Wrap parsing in try/catch. On failure, store the result with
`status: 'failed'` and the error string, `log.warn` it, and broadcast — **do not
fabricate a default verdict** or silently proceed. `finalMessage` from
`runOneShot` may be `null` (dead gateway/timeout); that is also failure. Surface
it; a wrong verdict presented as real is worse than a visible failure.

```ts
let verdict: TriageVerdict | null = null, error: string | null = null;
try { verdict = parseVerdict(finalMessage ?? ''); }
catch (err) { error = `could not parse verdict: ${String(err)}`; log.warn('triage parse failed', { repo, issueNumber, err: String(err) }); }
this.store.triage.insert({ …, status: verdict ? 'pending' : 'failed', verdict, error });
```

## 5. Review-then-apply — the agent never touches the outside world

Structured verdicts are stored as **`pending`** and shown to a human; **nothing
mutates GitHub or the repo until an explicit Apply** (see `Triage.apply`,
`PrReviews`). This keeps agents advisory by default and every external write
attributable and reversible. When you add an agent feature, default to this: the
run produces a proposal; a separate, permissioned action commits it. Reserve
autonomous writing for `fix`/`implement` goal runs, which are already fenced to a
worktree + PR review.

## 6. Choosing one-shot vs goal mode

- **One-shot** (`runOneShot`) for a bounded read-only assessment → one JSON
  verdict. Deterministic, queued, timeout-bounded.
- **Goal / interactive** for multi-turn work that edits files toward an outcome
  (fix a bug, implement a proposal). Output is a branch + PR, not JSON.

Details of launching either: `companion-agent-runs`.
