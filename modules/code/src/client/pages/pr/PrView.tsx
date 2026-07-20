import { useCallback, useState } from 'react';
import { AgentActivity } from '@companion/module-operate/client';
import {
  ActionMenu,
  AiActionMenu,
  Breadcrumb,
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
  useConfirm,
  type MenuAction,
} from '@companion/ui';
import type { PrRecord } from '../../../contract/index.js';
import { codeApi as api } from '../../api.js';
import { CommentsSection } from '../../components/Comments.js';
import { ChecksBadge, GitHubUser, PrStateIcon } from '../../widgets.js';
import { usePr, type UsePr } from './usePr.js';
import { RailBlock, RailRow } from './rail.js';
import { PrChecks } from './PrChecks.js';
import { PrPipelines, RunPipelineModal } from './PrPipelines.js';
import { PrReview, ReviewingStage } from './PrReview.js';
import { PrChanges } from './PrChanges.js';

type Mode = 'detail' | 'review';

/**
 * The one pull-request view. `detail` is the full workspace on the PR — the
 * change, CI, our pipelines, the AI review and the conversation. `review`
 * reuses the same building blocks but leads with the AI review's reasoning and
 * folds the code away. Both are fed entirely by {@link usePr}.
 */
export function PrView({ repo, number, mode = 'detail' }: { repo: string; number: number; mode?: Mode }): JSX.Element {
  const pr = usePr(repo, number);
  const fetchFiles = useCallback(() => api.prFiles(repo, number), [repo, number]);

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
            <ReviewLead pr={pr} canAct={pr.canAct} onRun={() => void pr.analyze()} />
          ) : (
            <>
              <article className="card max-h-[360px] overflow-y-auto">
                {p.body ? <Markdown text={p.body} /> : <span className="dim text-sm">(no description)</span>}
              </article>
              {pr.analyzing && !pr.review ? (
                <div className="banner-info anim-in">
                  <Spinner /> Review agent is reading the diff and CI status…
                </div>
              ) : null}
              {pr.review ? (
                <PrReview
                  review={pr.review}
                  canAct={pr.canAct}
                  busy={pr.busy}
                  onApply={(acct) => void pr.applyReview(acct)}
                  onDismiss={() => void pr.dismissReview()}
                />
              ) : null}
            </>
          )}

          <PrChanges fetchFiles={fetchFiles} />

          <PrChecks
            repo={repo}
            number={number}
            canAct={pr.canAct}
            ciAnalysis={pr.ciAnalysis}
            onFixChecks={pr.canAct && p.state === 'open' ? () => void pr.fixChecks() : null}
          />

          {!review ? <PrPipelines runs={pr.pipelineRuns} /> : null}
          {!review ? <AgentActivity repo={repo} issueNumber={number} /> : null}

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

/** In review mode the AI verdict is the hero — reviewing / verdict / empty. */
function ReviewLead({ pr, canAct, onRun }: { pr: UsePr; canAct: boolean; onRun: () => void }): JSX.Element {
  if (pr.review) {
    return (
      <PrReview
        review={pr.review}
        canAct={canAct}
        busy={pr.busy}
        emphasis="hero"
        onApply={(acct) => void pr.applyReview(acct)}
        onDismiss={() => void pr.dismissReview()}
      />
    );
  }
  if (pr.analyzing) return <ReviewingStage />;
  return (
    <EmptyState
      title="No AI review yet"
      hint="Run an AI review — it reads the diff and CI status, then proposes a verdict you can post to GitHub."
      action={
        canAct ? (
          <button className="btn" onClick={onRun}>
            Run AI review
          </button>
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

  const aiActions: MenuAction[] = [];
  if (data.canAct) {
    aiActions.push({
      label: data.analyzing ? 'Reviewing…' : data.review ? 'Re-run AI review' : 'AI review',
      disabled: data.analyzing,
      onSelect: () => void data.analyze(),
    });
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
  if (!review && data.canAct && pr.state === 'open' && data.pipelines.length > 0) {
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
        <h1 className="min-w-0 flex-1 text-xl leading-snug font-semibold">
          <CopyText value={`#${pr.number}`} className="dim mr-1.5 align-baseline font-normal">
            #{pr.number}
          </CopyText>
          {pr.title}
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
          {pr.checks ? <ChecksBadge checks={pr.checks} /> : <span className="dim">—</span>}
        </RailRow>
        {pr.state === 'open' && pr.mergeable !== null ? (
          <RailRow label="Merge">
            {pr.mergeable ? (
              <span className="badge-ok">clean</span>
            ) : (
              <span className="badge-danger">conflicts</span>
            )}
          </RailRow>
        ) : null}
        {pr.reviewDecision ? (
          <RailRow label="Review">
            <span className={pr.reviewDecision === 'approved' ? 'badge-ok' : 'badge-warn'}>
              {pr.reviewDecision.replace('_', ' ')}
            </span>
          </RailRow>
        ) : null}
        {pr.reviewRisk ? (
          <RailRow label="AI risk">
            <span className={pr.reviewRisk === 'high' ? 'badge-danger' : pr.reviewRisk === 'medium' ? 'badge-warn' : 'badge-ok'}>
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
