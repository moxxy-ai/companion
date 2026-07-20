import { useEffect, useState } from 'react';
import {
  Dropdown,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  Spinner,
  timeAgo,
} from '@companion/ui';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { RefinementListEntry } from '../../contract/index.js';
import { refinementApi } from '../api.js';
import { useRefinements } from '../hooks/useRefinements.js';

/**
 * The active workspace's refinements: epics on their way from a big story to
 * board-ready tasks. Click-through to the detail (`#/refinement/<id>`) to run
 * the decomposition and import the results.
 */
export default function Refinements(): JSX.Element {
  const { current, refinements, error } = useRefinements();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  if (!current) return <EmptyState title="No workspace selected" />;
  const canManage = can('refine:manage');

  return (
    <Page>
      <PageHeader
        title="Product Refinement"
        subtitle={current.name}
        actions={
          canManage ? (
            <button className="btn" onClick={() => setCreating(true)}>
              New refinement
            </button>
          ) : undefined
        }
      />
      <ErrorBar error={error ?? createError} className="mb-3" />

      {refinements === null ? (
        <PageLoading label="Loading refinements…" />
      ) : refinements.length === 0 ? (
        <EmptyState
          title="No refinements yet"
          hint="Write an epic, pick a decomposition method, and let an agent read the codebase and split it into concrete, board-ready tasks. You review — nothing lands on the board until you import it."
          action={
            canManage ? (
              <button className="btn" onClick={() => setCreating(true)}>
                New refinement
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {refinements.map((r) => (
            <RefinementCard key={r.id} refinement={r} />
          ))}
        </div>
      )}

      {creating ? (
        <NewRefinementModal
          onClose={() => setCreating(false)}
          onError={setCreateError}
          onCreated={(id) => {
            setCreating(false);
            window.location.hash = `/refinement/${id}`;
          }}
        />
      ) : null}
    </Page>
  );
}

export function StatusBadge({ status }: { status: RefinementListEntry['status'] }): JSX.Element {
  switch (status) {
    case 'draft':
      return <span className="badge opacity-70">draft</span>;
    case 'decomposing':
      return (
        <span className="badge-accent inline-flex items-center gap-1.5">
          <Spinner /> decomposing
        </span>
      );
    case 'ready':
      return <span className="badge-ok">ready</span>;
    case 'failed':
      return <span className="badge-danger">failed</span>;
  }
}

function RefinementCard({ refinement }: { refinement: RefinementListEntry }): JSX.Element {
  const counts = [
    ...(refinement.proposedCount > 0 ? [`${refinement.proposedCount} proposed`] : []),
    ...(refinement.importedCount > 0 ? [`${refinement.importedCount} imported`] : []),
  ];
  return (
    <a
      href={`#/refinement/${refinement.id}`}
      className="block rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition-shadow hover:shadow dark:border-zinc-800 dark:bg-zinc-900"
      aria-label={refinement.title}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 truncate text-sm font-medium">{refinement.title}</h2>
        <StatusBadge status={refinement.status} />
        <span className="flex-1" />
        <span className="dim text-xs tabular-nums">{timeAgo(refinement.updatedAt)}</span>
      </div>
      <p className="dim mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="truncate font-mono">{refinement.repo}</span>
        <span className="badge font-mono normal-case">{refinement.branch}</span>
        {counts.length > 0 ? <span>{counts.join(' · ')}</span> : null}
      </p>
    </a>
  );
}

function NewRefinementModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const { current } = useWorkspace();
  const repos = useWorkspaceRepos(current?.id);
  const [repo, setRepo] = useState<string | null>(null);
  const [branch, setBranch] = useState('');
  const [title, setTitle] = useState('');
  const [story, setStory] = useState('');
  const [busy, setBusy] = useState(false);

  const effectiveRepo = repo ?? repos[0]?.fullName ?? null;

  // Picking a repo pre-fills the branch the agent will read (editable).
  useEffect(() => {
    const row = repos.find((r) => r.fullName === effectiveRepo);
    if (row) setBranch(row.defaultBranch);
  }, [effectiveRepo, repos]);

  const submit = async (): Promise<void> => {
    if (!effectiveRepo || title.trim().length < 3 || story.trim().length < 8) return;
    setBusy(true);
    try {
      const { refinement } = await refinementApi.create({
        repo: effectiveRepo,
        branch: branch.trim() || undefined,
        title: title.trim(),
        story: story.trim(),
      });
      onError(null);
      onCreated(refinement.id);
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New refinement" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repository">
            <Dropdown
              ariaLabel="Repository"
              value={effectiveRepo}
              onChange={(v) => setRepo(v)}
              options={repos.map((r) => ({ value: r.fullName, label: r.fullName }))}
              searchable
            />
          </Field>
          <Field label="Branch" hint="The decomposition agent reads the code as of this branch.">
            <input
              className="input font-mono"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              maxLength={200}
            />
          </Field>
        </div>
        <Field label="Title">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Self-serve workspace billing"
            maxLength={200}
          />
        </Field>
        <Field label="Epic" hint="The big story, in markdown — what should exist, for whom, and why.">
          <textarea
            className="input min-h-40"
            value={story}
            onChange={(e) => setStory(e.target.value)}
            maxLength={32_000}
          />
        </Field>
        <FormActions>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy || !effectiveRepo || title.trim().length < 3 || story.trim().length < 8}
            onClick={() => void submit()}
          >
            Create
          </button>
        </FormActions>
      </div>
    </Modal>
  );
}
