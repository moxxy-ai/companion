import { useCallback, useState } from 'react';
import { useAuth } from '@companion/module-core/client';
import { AgentActivity, LaneNote } from '@companion/module-operate/client';
import { ProviderIcon, ReviewProviderSelect, useReviewTargets } from '@companion/module-integrations/client';
import type { IntegrationTargetRef } from '@companion/module-integrations/contract';
import { Slot } from '@moxxy/companion-sdk/client';
import {
  ActionMenu,
  AiActionMenu,
  Breadcrumb,
  CheckIcon,
  CloseIcon,
  CopyText,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  Markdown,
  Modal,
  Page,
  PageLoading,
  Spinner,
  timeAgo,
  Tooltip,
  useConfirm,
  type MenuAction,
} from '@moxxy/companion-sdk/ui';
import type { PrRecord, ReviewDepth, ReviewOptions, ReviewStrictness } from '../../../contract/index.js';
import { codeApi as api } from '../../api.js';
import { CommentsSection } from '../../components/Comments.js';
import { ChecksIcon, GitHubUser, PrStateIcon } from '../../widgets.js';
import { usePr, type UsePr } from './usePr.js';
import { RailBlock, RailRow } from './rail.js';
import { PrChecks } from './PrChecks.js';
import { PrPipelines, RunPipelineModal } from './PrPipelines.js';
import { PrReview, ReviewingStage } from './PrReview.js';
import { useFindingAnnotations } from './ReviewFindings.js';
import { LineComposer, type DraftComment } from './LineComposer.js';
import { PrChanges } from './PrChanges.js';

type Mode = 'detail' | 'review';

/**
 * The one pull-request view. `detail` is the full workspace on the PR — the
 * change, CI, our pipelines, the AI review and the conversation. `review`
 * reuses the same building blocks but leads with the AI review's reasoning and
 * folds the code away. Both are fed entirely by {@link usePr}.
 */
export function PrView({ repo, number, mode = 'detail' }: { repo: string; number: number; mode?: Mode }): JSX.Element {
  const { can } = useAuth();
  const pr = usePr(repo, number);
  const fetchFiles = useCallback((page: number) => api.prFiles(repo, number, page), [repo, number]);
  const expandContext = useCallback(
    (path: string, from: number, to: number) =>
      api.prFileLines(repo, number, path, from, to).then((r) => r.lines),
    [repo, number],
  );
  // One focused finding, shared by the list and the diff: that shared value IS
  // the two-way link between them.
  const [focusedFinding, setFocusedFinding] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftComment | null>(null);
  const findingAnnotations = useFindingAnnotations(pr.review?.findings ?? []);
  // A comment being written is just another annotation, so it appears exactly
  // where it will be posted instead of in a panel somewhere else.
  const annotations = draft
    ? [
        ...findingAnnotations,
        {
          id: 'draft',
          path: draft.path,
          side: draft.side,
          line: draft.line,
          marker: <span className="text-accent-500">✎</span>,
          body: (
            <LineComposer
              draft={draft}
              busy={pr.busy}
              onCancel={() => setDraft(null)}
              onSubmit={async (body, severity) => {
                await pr.addFinding({ file: draft.path, side: draft.side, line: draft.line, body, severity });
                setDraft(null);
              }}
            />
          ),
        },
      ]
    : findingAnnotations;

  if (!pr.pr) return pr.error ? <Page><ErrorBar error={pr.error} /></Page> : <PageLoading />;

  const p = pr.pr;
  const review = mode === 'review';

  return (
    <Page className="anim-in">
      <PrHeader pr={p} data={pr} mode={mode} />
      <ErrorBar error={pr.error} />

      <div className="mt-4 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {review ? (
            <ReviewLead
              pr={pr}
              onRun={(opts) => void pr.analyze(opts)}
              focusedFinding={focusedFinding}
              onFocusFinding={setFocusedFinding}
            />
          ) : (
            <>
              <article className="card max-h-[360px] overflow-y-auto">
                {p.body ? <Markdown text={p.body} /> : <span className="dim text-sm">(no description)</span>}
              </article>
              <Slot name="work-item.links" can={can} props={{ kind: 'pull-request', repo, number }} />
              {pr.analyzing && !pr.review ? (
                <div className="banner-info anim-in">
                  <Spinner /> Review agent is reading the diff and CI status…
                </div>
              ) : null}
              {pr.review ? (
                <PrReview
                  review={pr.review}
                  canAct={pr.canAct}
                  canReadRuns={pr.canReadRuns}
                  canUseAgents={pr.canUseAgents}
                  busy={pr.busy}
                  onApply={(acct, postMode) => void pr.applyReview(acct, postMode)}
                  onCancel={() => void pr.cancelReview()}
                  onDismiss={() => void pr.dismissReview()}
                  onUpdateFinding={(id, patch) => void pr.updateFinding(id, patch)}
                  focusedFinding={focusedFinding}
                  onFocusFinding={setFocusedFinding}
                />
              ) : null}
            </>
          )}

          <PrChanges
            key={`${repo}:${number}`}
            fetchFiles={fetchFiles}
            annotations={annotations}
            focusedAnnotationId={focusedFinding}
            onFocusAnnotation={setFocusedFinding}
            onExpandContext={expandContext}
            {...(pr.canAct && p.state === 'open'
              ? {
                  onAddComment: (path: string, side: 'LEFT' | 'RIGHT', line: number) =>
                    setDraft({ path, side, line }),
                }
              : {})}
          />

          <PrChecks
            repo={repo}
            number={number}
            canAct={pr.canAct}
            ciAnalysis={pr.ciAnalysis}
            onFixChecks={pr.canUseAgents && p.state === 'open' ? () => void pr.fixChecks() : null}
          />

          {!review ? <PrPipelines runs={pr.pipelineRuns} /> : null}
          {!review && pr.canReadRuns ? <AgentActivity repo={repo} issueNumber={number} /> : null}

          <CommentsSection
            load={() => api.prComments(repo, number)}
            post={pr.canAct ? (body) => api.commentPr(repo, number, body) : undefined}
            canComment={pr.canAct}
          />
        </div>

        <PrSidebar pr={p} />
      </div>
    </Page>
  );
}

/**
 * Depth changes how the agent works (and how long it runs); strictness only
 * decides how much of what it found starts selected. They are offered together
 * because the pair is the whole configuration of a review.
 */
function ReviewLauncher({
  repo,
  workspaceId,
  onRun,
  busy = false,
}: {
  repo: string;
  workspaceId: string | null;
  onRun: (opts: ReviewOptions) => void;
  busy?: boolean;
}): JSX.Element {
  const [depth, setDepth] = useState<ReviewDepth>('in-depth');
  const [strictness, setStrictness] = useState<ReviewStrictness>('balanced');
  const [providerValue, setProviderValue] = useState('');
  const [provider, setProvider] = useState<IntegrationTargetRef | undefined>();
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {workspaceId ? (
        <ReviewProviderSelect
          scope={{ kind: 'repository', workspaceId, repo }}
          value={providerValue}
          onChange={(value, target) => {
            setProviderValue(value);
            setProvider(target);
          }}
        />
      ) : null}
      <select className="input w-auto text-xs" value={depth} onChange={(e) => setDepth(e.target.value as ReviewDepth)} aria-label="Review depth">
        <option value="in-depth">In depth (line by line)</option>
        <option value="high-level">High level (architecture)</option>
      </select>
      <select
        className="input w-auto text-xs"
        value={strictness}
        onChange={(e) => setStrictness(e.target.value as ReviewStrictness)}
        aria-label="Review strictness"
      >
        <option value="blockers-only">Blockers only</option>
        <option value="balanced">Balanced</option>
        <option value="pedantic">Pedantic</option>
      </select>
      <button
        className="btn"
        disabled={busy}
        onClick={() => onRun({ depth, strictness, ...(provider ? { provider } : {}) })}
      >
        {busy ? 'Reviewing…' : 'Run review'}
      </button>
      <LaneNote className="basis-full text-center" />
    </div>
  );
}

/** In review mode the AI verdict is the hero — reviewing / verdict / empty. */
function ReviewLead({
  pr,
  onRun,
  focusedFinding,
  onFocusFinding,
}: {
  pr: UsePr;
  onRun: (opts?: ReviewOptions) => void;
  focusedFinding: string | null;
  onFocusFinding: (id: string | null) => void;
}): JSX.Element {
  if (pr.review) {
    // A manual draft is not an answer to "has this been reviewed" — the button
    // to actually run one stays offered underneath it.
    const card = (
      <PrReview
        review={pr.review}
        canAct={pr.canAct}
        canReadRuns={pr.canReadRuns}
        canUseAgents={pr.canUseAgents}
        busy={pr.busy}
        emphasis="hero"
        onApply={(acct, postMode) => void pr.applyReview(acct, postMode)}
        onCancel={() => void pr.cancelReview()}
        onDismiss={() => void pr.dismissReview()}
        onUpdateFinding={(id, patch) => void pr.updateFinding(id, patch)}
        focusedFinding={focusedFinding}
        onFocusFinding={onFocusFinding}
      />
    );
    if (pr.review.source === 'agent') {
      return pr.review.status === 'failed' || pr.review.status === 'cancelled' ? (
        <div className="flex flex-col gap-4">
          {card}
          {pr.canReview ? (
            <ReviewLauncher repo={pr.pr!.repo} workspaceId={pr.workspaceId} onRun={onRun} />
          ) : null}
        </div>
      ) : (
        card
      );
    }
    // A manual draft must not hide that an agent review is running: this branch
    // returns before the `analyzing` check below, so without this the reviewer
    // clicks Run, the page does not change at all, and they click again.
    return (
      <div className="flex flex-col gap-4">
        {card}
        {pr.analyzing ? (
          <ReviewingStage />
        ) : pr.canReview ? (
          <ReviewLauncher
            repo={pr.pr!.repo}
            workspaceId={pr.workspaceId}
            onRun={onRun}
            busy={pr.analyzing}
          />
        ) : null}
      </div>
    );
  }
  if (pr.analyzing) return <ReviewingStage />;
  return (
    <EmptyState
      title="No review yet"
      hint="Use Companion's native reviewer, a connected review CLI, or delegate to a GitHub review app. Managed findings return here before anything is posted."
      action={
        pr.canReview ? (
          <ReviewLauncher repo={pr.pr!.repo} workspaceId={pr.workspaceId} onRun={onRun} />
        ) : undefined
      }
    />
  );
}

function PrHeader({ pr, data, mode }: { pr: PrRecord; data: UsePr; mode: Mode }): JSX.Element {
  const { confirmDanger, confirmElement } = useConfirm();
  const [runningPipeline, setRunningPipeline] = useState(false);
  const [runningAgent, setRunningAgent] = useState(false);
  const review = mode === 'review';
  const reviewers = useReviewTargets(
    data.workspaceId
      ? { kind: 'repository', workspaceId: data.workspaceId, repo: pr.repo }
      : { kind: 'instance' },
  );

  const aiActions: MenuAction[] = [];
  if (data.canReview) {
    const routed = reviewers.route?.targets[0];
    const routedLabel = routed
      ? reviewers.options.find((option) => option.target.providerId === routed.providerId)?.label
      : null;
    aiActions.push({
      label:
        (data.analyzing ? 'Reviewing…' : data.review ? 'Re-run review' : 'Run review') +
        (routedLabel && reviewers.options.length > 1 ? ` · ${routedLabel}` : ''),
      icon: routed ? <ProviderIcon providerId={routed.providerId} /> : undefined,
      disabled: data.analyzing,
      onSelect: () => void data.analyze({ depth: 'in-depth' }),
    });
    aiActions.push({
      label: 'Quick review (high level)',
      disabled: data.analyzing,
      onSelect: () => void data.analyze({ depth: 'high-level' }),
    });
    // Every reviewer this repository can reach, by name: which one the route
    // picks is a setting elsewhere, and asking a second one for a second
    // opinion should not mean going and changing that setting first.
    if (reviewers.options.length > 1) {
      for (const option of reviewers.options) {
        aiActions.push({
          label: `${option.label}: run review`,
          icon: <ProviderIcon providerId={option.target.providerId} />,
          disabled: data.analyzing,
          onSelect: () => void data.analyze({ depth: 'in-depth', provider: option.target }),
        });
      }
    }
  }
  if (data.canUseAgents) {
    if (pr.state === 'open' && pr.checks?.state === 'failing') {
      aiActions.push({ label: 'Fix failing checks', disabled: data.agentBusy !== null, onSelect: () => void data.fixChecks() });
    }
    if (pr.state === 'open' && pr.reviewDecision === 'changes_requested') {
      aiActions.push({
        label: 'Address review feedback',
        disabled: data.agentBusy !== null,
        onSelect: () => void data.addressReviews(),
      });
    }
    if (pr.state === 'open' && pr.mergeable === false) {
      aiActions.push({
        label: 'Resolve conflicts',
        disabled: data.agentBusy !== null,
        onSelect: () => void data.resolveConflicts(),
      });
    }
    if (pr.state === 'open') {
      aiActions.push({ label: 'Run agent on branch…', disabled: data.agentBusy !== null, onSelect: () => setRunningAgent(true) });
    }
  }
  if (!review && data.canRunPipelines && pr.state === 'open' && data.pipelines.length > 0) {
    aiActions.push({ label: 'Run pipeline…', onSelect: () => setRunningPipeline(true) });
  }

  // A conflicted PR cannot merge — the menu offers Close only; the AI menu's
  // "Resolve conflicts" is the way forward.
  const prActions: MenuAction[] = [];
  if (data.canAct && pr.state === 'open') {
    if (pr.mergeable !== false) {
      prActions.push({
        label: 'Squash-merge…',
        disabled: data.busy,
        onSelect: () =>
          void (async () => {
            const ok = await confirmDanger({
              title: `Merge PR #${pr.number}`,
              message: `"${pr.title}" is squash-merged into ${pr.baseRef}. Merging cannot be undone from Companion.`,
              confirmLabel: 'Squash-merge',
            });
            if (ok) await data.merge('squash');
          })(),
      });
    }
    prActions.push({
      label: 'Close PR…',
      danger: true,
      disabled: data.busy,
      onSelect: () =>
        void (async () => {
          const ok = await confirmDanger({
            title: `Close PR #${pr.number}`,
            message: 'The pull request is closed on GitHub without merging.',
            confirmLabel: 'Close PR',
          });
          if (ok) await data.close();
        })(),
    });
  }

  return (
    <header>
      {review ? (
        <Breadcrumb
          className="mb-1"
          items={[{ label: 'Pull Requests', href: '#/prs' }, { label: pr.repo }, { label: `#${pr.number}` }]}
        />
      ) : null}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {/* One line: a wrapped title pushes the whole page down and the toolbar
            beside it out of reach. The full text is in the tooltip. */}
        <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xl leading-snug font-semibold">
          <CopyText value={`#${pr.number}`} className="dim shrink-0 align-baseline font-normal">
            #{pr.number}
          </CopyText>
          <span className="min-w-0 truncate" title={pr.title}>
            {pr.title}
          </span>
        </h1>
        <div className="flex shrink-0 items-center gap-2" role="toolbar" aria-label="Pull request actions">
          {aiActions.length > 0 ? (
            <AiActionMenu label="AI actions" busy={data.analyzing || data.agentBusy !== null} actions={aiActions} />
          ) : null}
          {review ? (
            <a className="btn-ghost" href={`#/repos/${pr.repo}/prs/${pr.number}`}>
              Full PR
            </a>
          ) : null}
          {prActions.length > 0 ? <ActionMenu label="More pull request actions" actions={prActions} /> : null}
          <a className="btn-ghost" href={pr.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </div>
      {confirmElement}
      {runningPipeline ? (
        <RunPipelineModal
          pipelines={data.pipelines}
          onRun={(id) => data.runPipeline(id)}
          onClose={() => setRunningPipeline(false)}
        />
      ) : null}
      {runningAgent ? <RunAgentModal onRun={(text) => data.runAgent(text)} onClose={() => setRunningAgent(false)} /> : null}
    </header>
  );
}

/** Free-form agent objective against this PR's branch (reached from the AI menu). */
function RunAgentModal({
  onRun,
  onClose,
}: {
  onRun: (instructions: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Success navigates to the run's building preview, unmounting the page.
      await onRun(instructions.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="✦ Run agent on this branch" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="What should the agent do?">
          <textarea
            className="input min-h-28 resize-y"
            required
            minLength={8}
            placeholder="e.g. tighten the error copy, add tests for the new endpoint, split the migration into two steps"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            autoFocus
          />
          <LaneNote className="mt-1 block" />
        </Field>
        <p className="dim text-[13px]">
          The agent works in a worktree on the PR&apos;s branch; you review the diff and approve before anything is
          pushed.
        </p>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || instructions.trim().length < 8}>
            {busy ? (
              <>
                <Spinner /> Starting…
              </>
            ) : (
              'Run agent'
            )}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

/** Right-hand metadata rail: status, branch, people and labels. */
function PrSidebar({ pr }: { pr: PrRecord }): JSX.Element {
  return (
    <aside className="flex flex-col gap-4 text-[13px] lg:sticky lg:top-4" aria-label="Pull request details">
      {/* Short scalar facts read best as an aligned label/value grid. */}
      <div className="card flex flex-col gap-3">
        <RailRow label="Status">
          <PrStateIcon state={pr.state} draft={pr.draft} decision={pr.reviewDecision} />
        </RailRow>
        <RailRow label="Checks">
          {pr.checks ? <ChecksIcon checks={pr.checks} /> : <span className="dim">—</span>}
        </RailRow>
        {pr.state === 'open' && pr.mergeable !== null ? (
          <RailRow label="Merge">
            {pr.mergeable ? (
              <span className="font-medium tracking-wide text-emerald-600 uppercase dark:text-emerald-400">clean</span>
            ) : (
              <span className="font-medium tracking-wide text-red-600 uppercase dark:text-red-400">conflicts</span>
            )}
          </RailRow>
        ) : null}
        {pr.reviewDecision ? (
          <RailRow label="Review">
            <Tooltip content={pr.reviewDecision === 'approved' ? 'Review approved' : 'Review changes requested'}>
              <span
                className={`inline-flex size-4 items-center justify-center ${
                  pr.reviewDecision === 'approved'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
                role="img"
                aria-label={pr.reviewDecision === 'approved' ? 'Review approved' : 'Review changes requested'}
              >
                {pr.reviewDecision === 'approved' ? <CheckIcon /> : <CloseIcon />}
              </span>
            </Tooltip>
          </RailRow>
        ) : null}
        {pr.reviewRisk ? (
          <RailRow label="AI risk">
            <span
              className={`font-medium tracking-wide uppercase ${
                pr.reviewRisk === 'high'
                  ? 'text-red-600 dark:text-red-400'
                  : pr.reviewRisk === 'medium'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {pr.reviewRisk}
            </span>
          </RailRow>
        ) : null}
      </div>

      {/* Branch and target on their own lines — each truncates with the full ref on hover. */}
      <div className="card flex flex-col gap-3">
        <RailBlock label="Branch">
          <CopyText value={pr.headRef} title={`Copy "${pr.headRef}"`} className="max-w-full">
            <code className="block min-w-0 truncate font-mono text-xs" title={pr.headRef}>
              {pr.headRef}
            </code>
          </CopyText>
        </RailBlock>
        <RailBlock label="Target">
          <code className="block truncate font-mono text-xs" title={pr.baseRef}>
            {pr.baseRef}
          </code>
        </RailBlock>
      </div>

      <div className="card flex flex-col gap-3">
        <RailBlock label="Author">
          <GitHubUser login={pr.author} className="text-zinc-700 dark:text-zinc-300" />
        </RailBlock>
        {pr.assignees.length > 0 ? (
          <RailBlock label="Assignees">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {pr.assignees.map((a) => (
                <GitHubUser key={a} login={a} className="text-zinc-700 dark:text-zinc-300" />
              ))}
            </div>
          </RailBlock>
        ) : null}
        {pr.labels.length > 0 ? (
          <RailBlock label="Labels">
            <div className="flex flex-wrap gap-1.5">
              {pr.labels.map((l) => (
                <span key={l} className="chip" title={l}>
                  {l}
                </span>
              ))}
            </div>
          </RailBlock>
        ) : null}
      </div>

      <div className="card flex flex-col gap-3">
        <RailRow label="Opened">{timeAgo(pr.createdAt)}</RailRow>
        <RailRow label="Updated">{timeAgo(pr.updatedAt)}</RailRow>
        {pr.closedAt ? (
          <RailRow label={pr.state === 'merged' ? 'Merged' : 'Closed'}>{timeAgo(pr.closedAt)}</RailRow>
        ) : null}
      </div>
    </aside>
  );
}
