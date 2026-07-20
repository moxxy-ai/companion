import { useEffect, useMemo, useState } from 'react';
import {
  Breadcrumb,
  Dropdown,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  IconButton,
  Markdown,
  Modal,
  Page,
  PageLoading,
  timeAgo,
  useConfirm,
} from '@companion/ui';
import { useAuth } from '@companion/module-core/client';
import type { TaskPriority } from '@companion/module-board/contract';
import type { RefineItemRecord, RefineMethodRecord, RefinementRecord } from '../../contract/index.js';
import { useRefinement } from '../hooks/useRefinement.js';
import { StatusBadge } from './Refinements.js';

const PRIORITY_CLS: Record<TaskPriority, string> = {
  0: 'bg-red-500/10 text-red-600 dark:text-red-400',
  1: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  2: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  3: 'bg-zinc-500/10 text-zinc-400 dark:text-zinc-500',
};

const MAX_CONTEXT_PICKS = 5;

/**
 * One refinement: the epic (editable), the decompose panel (method + attached
 * specs/docs + the agent trigger), the agent's enriched summary, and the
 * proposed tasks the user imports into the board — one by one or all at once.
 */
export default function RefinementView({ id }: { id: string }): JSX.Element {
  const { detail, methods, context, missing, error, setError, actions } = useRefinement(id);
  const { can } = useAuth();
  const { confirmDanger, confirmElement } = useConfirm();

  if (missing) {
    return (
      <Page>
        <EmptyState
          title="Refinement not found"
          hint="It may have been deleted."
          action={
            <a className="btn-ghost" href="#/refinement">
              Back to refinements
            </a>
          }
        />
      </Page>
    );
  }
  if (!detail) return <PageLoading label="Loading the refinement…" />;

  const { refinement, items } = detail;
  const canManage = can('refine:manage');
  const decomposing = refinement.status === 'decomposing';
  const proposed = items.filter((i) => i.status === 'proposed');

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Refinement', href: '#/refinement' }, { label: refinement.title }]} className="mb-3" />
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold">{refinement.title}</h1>
        <StatusBadge status={refinement.status} />
        <span className="dim text-xs tabular-nums">updated {timeAgo(refinement.updatedAt)}</span>
        {canManage ? (
          <IconButton
            label="Delete refinement"
            danger
            onClick={() => {
              void confirmDanger({
                title: 'Delete refinement',
                message: `Delete "${refinement.title}"? Already-imported board tasks stay on the board.`,
                confirmLabel: 'Delete',
              }).then((ok) => {
                if (!ok) return;
                void actions.remove().then((deleted) => {
                  if (deleted) window.location.hash = '/refinement';
                });
              });
            }}
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              <path
                d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3M4.7 4.5l.5 8.3a1 1 0 0 0 1 .95h3.6a1 1 0 0 0 1-.95l.5-8.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </IconButton>
        ) : null}
      </header>

      <ErrorBar error={error} className="mb-3" />

      <div className="flex flex-col gap-4">
        <StoryCard refinement={refinement} disabled={!canManage || decomposing} onSave={actions.update} />

        {canManage ? (
          <DecomposePanel
            refinement={refinement}
            methods={methods}
            specs={context?.specs ?? []}
            docs={context?.docs ?? []}
            decomposing={decomposing}
            onDecompose={actions.decompose}
            onSaveMethod={actions.saveMethod}
            onUpdateMethod={actions.updateMethod}
            onDeleteMethod={actions.deleteMethod}
          />
        ) : null}

        {refinement.status === 'failed' && refinement.error ? <ErrorBar error={refinement.error} /> : null}

        {refinement.summary ? (
          <section aria-label="Summary" className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="mb-2 text-xs font-semibold tracking-wide uppercase">Summary</h2>
            <div className="text-sm">
              <Markdown text={refinement.summary} />
            </div>
          </section>
        ) : null}

        {items.length > 0 ? (
          <ItemsSection
            items={items}
            proposedCount={proposed.length}
            canManage={canManage}
            onImport={actions.importItem}
            onImportAll={actions.importAll}
            onDismiss={actions.dismissItem}
          />
        ) : refinement.status === 'ready' ? (
          <EmptyState title="The agent proposed no tasks" hint="Refine the story or pick another method, then decompose again." />
        ) : null}
      </div>
      {confirmElement}
    </Page>
  );
}

/** The epic itself — title/branch/story, editable while no agent is running. */
function StoryCard({
  refinement,
  disabled,
  onSave,
}: {
  refinement: RefinementRecord;
  disabled: boolean;
  onSave: (fields: { title?: string; story?: string; branch?: string }) => Promise<void>;
}): JSX.Element {
  const [title, setTitle] = useState(refinement.title);
  const [branch, setBranch] = useState(refinement.branch);
  const [story, setStory] = useState(refinement.story);
  const [saving, setSaving] = useState(false);

  // A live update (e.g. another tab) re-syncs untouched fields.
  useEffect(() => {
    setTitle(refinement.title);
    setBranch(refinement.branch);
    setStory(refinement.story);
  }, [refinement.title, refinement.branch, refinement.story]);

  const dirty = title !== refinement.title || branch !== refinement.branch || story !== refinement.story;

  const save = async (): Promise<void> => {
    setSaving(true);
    await onSave({ title: title.trim(), branch: branch.trim(), story });
    setSaving(false);
  };

  return (
    <section aria-label="Story" className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_minmax(10rem,14rem)]">
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} disabled={disabled} />
        </Field>
        <Field label="Branch" hint={`on ${refinement.repo}`}>
          <input
            className="input font-mono"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            maxLength={200}
            disabled={disabled}
          />
        </Field>
      </div>
      <Field label="Epic" hint="Markdown. The agent enriches this against the actual codebase.">
        <textarea
          className="input min-h-40"
          value={story}
          onChange={(e) => setStory(e.target.value)}
          maxLength={32_000}
          disabled={disabled}
        />
      </Field>
      {!disabled && dirty ? (
        <FormActions>
          <button className="btn" disabled={saving || title.trim().length < 3 || story.trim().length < 8} onClick={() => void save()}>
            Save
          </button>
        </FormActions>
      ) : null}
    </section>
  );
}

function DecomposePanel({
  refinement,
  methods,
  specs,
  docs,
  decomposing,
  onDecompose,
  onSaveMethod,
  onUpdateMethod,
  onDeleteMethod,
}: {
  refinement: RefinementRecord;
  methods: RefineMethodRecord[];
  specs: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  docs: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  decomposing: boolean;
  onDecompose: (methodId: string, specIds: string[], docIds: string[]) => Promise<void>;
  onSaveMethod: (fields: { name: string; description: string; instructions: string }) => Promise<void>;
  onUpdateMethod: (id: string, fields: { name?: string; description?: string; instructions?: string }) => Promise<void>;
  onDeleteMethod: (id: string) => Promise<void>;
}): JSX.Element {
  const [methodId, setMethodId] = useState<string | null>(refinement.methodId);
  const [specIds, setSpecIds] = useState<string[]>([...refinement.specIds]);
  const [docIds, setDocIds] = useState<string[]>([...refinement.docIds]);
  const [managing, setManaging] = useState(false);

  const effectiveMethodId = methodId ?? methods[0]?.id ?? null;
  const selected = useMemo(() => methods.find((m) => m.id === effectiveMethodId), [methods, effectiveMethodId]);

  const toggle = (list: string[], set: (v: string[]) => void, id: string): void => {
    set(list.includes(id) ? list.filter((x) => x !== id) : list.length < MAX_CONTEXT_PICKS ? [...list, id] : list);
  };

  return (
    <section aria-label="Decompose" className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase">Decompose</h2>
      <div className="flex flex-col gap-3">
        <Field label="Method">
          <Dropdown
            ariaLabel="Decomposition method"
            value={effectiveMethodId}
            onChange={(v) => setMethodId(v)}
            options={methods.map((m) => ({ value: m.id, label: m.builtin ? m.name : `${m.name} (custom)` }))}
          />
        </Field>
        {selected?.description ? <p className="dim -mt-1 text-[13px]">{selected.description}</p> : null}

        {specs.length > 0 ? (
          <ContextPicker
            label={`Specifications (${specIds.length}/${MAX_CONTEXT_PICKS})`}
            options={specs}
            selected={specIds}
            onToggle={(id) => toggle(specIds, setSpecIds, id)}
            disabled={decomposing}
          />
        ) : null}
        {docs.length > 0 ? (
          <ContextPicker
            label={`Documentation (${docIds.length}/${MAX_CONTEXT_PICKS})`}
            options={docs}
            selected={docIds}
            onToggle={(id) => toggle(docIds, setDocIds, id)}
            disabled={decomposing}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn"
            disabled={decomposing || !effectiveMethodId}
            onClick={() => {
              if (effectiveMethodId) void onDecompose(effectiveMethodId, specIds, docIds);
            }}
          >
            {decomposing ? 'Decomposing… (agent is reading the codebase)' : '✦ Decompose'}
          </button>
          <button className="btn-ghost" onClick={() => setManaging(true)}>
            Manage methods…
          </button>
        </div>
      </div>
      {managing ? (
        <MethodsModal
          methods={methods}
          onClose={() => setManaging(false)}
          onSave={onSaveMethod}
          onUpdate={onUpdateMethod}
          onDelete={onDeleteMethod}
        />
      ) : null}
    </section>
  );
}

/** Compact checkbox list for attaching specs/docs as agent context. */
function ContextPicker({
  label,
  options,
  selected,
  onToggle,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  disabled: boolean;
}): JSX.Element {
  const full = selected.length >= MAX_CONTEXT_PICKS;
  return (
    <Field label={label}>
      <div className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
        {options.map((o) => {
          const checked = selected.includes(o.id);
          return (
            <label key={o.id} className={`flex items-center gap-2 text-[13px] ${!checked && full ? 'opacity-50' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || (!checked && full)}
                onChange={() => onToggle(o.id)}
              />
              <span className="min-w-0 truncate">{o.title}</span>
            </label>
          );
        })}
      </div>
    </Field>
  );
}

function ItemsSection({
  items,
  proposedCount,
  canManage,
  onImport,
  onImportAll,
  onDismiss,
}: {
  items: RefineItemRecord[];
  proposedCount: number;
  canManage: boolean;
  onImport: (itemId: string, queue: boolean) => Promise<void>;
  onImportAll: (queue: boolean) => Promise<void>;
  onDismiss: (itemId: string) => Promise<void>;
}): JSX.Element {
  const [queue, setQueue] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  return (
    <section aria-label="Proposed tasks">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-xs font-semibold tracking-wide uppercase">
          Proposed tasks <span className="dim font-normal normal-case">· {items.length}</span>
        </h2>
        <span className="flex-1" />
        {canManage ? (
          <>
            <label className="dim flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} />
              queue immediately
            </label>
            <button
              className="btn"
              disabled={busy || proposedCount === 0}
              onClick={() => void run(() => onImportAll(queue))}
            >
              Import all ({proposedCount})
            </button>
            <a className="dim text-xs font-medium hover:underline" href="#/board">
              open board →
            </a>
          </>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            canManage={canManage}
            busy={busy}
            onImport={() => void run(() => onImport(item.id, queue))}
            onDismiss={() => void run(() => onDismiss(item.id))}
          />
        ))}
      </div>
    </section>
  );
}

function ItemCard({
  item,
  canManage,
  busy,
  onImport,
  onDismiss,
}: {
  item: RefineItemRecord;
  canManage: boolean;
  busy: boolean;
  onImport: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const dimmed = item.status === 'dismissed';
  return (
    <article
      className={`rounded-lg border bg-white p-3 dark:bg-zinc-900 ${
        dimmed ? 'border-zinc-100 opacity-60 dark:border-zinc-800/60' : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="dim text-xs tabular-nums">{item.ord + 1}.</span>
        <h3 className="min-w-0 flex-1 text-[13px] leading-snug font-medium">{item.title}</h3>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${PRIORITY_CLS[item.priority]}`}>
          P{item.priority}
        </span>
        {item.status === 'proposed' && canManage ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <button className="btn" disabled={busy} onClick={onImport}>
              Import
            </button>
            <button className="btn-ghost" disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          </span>
        ) : item.status === 'imported' ? (
          <span className="badge-ok normal-case">
            imported{item.taskId ? <span className="font-mono"> · {item.taskId}</span> : null}
          </span>
        ) : item.status === 'dismissed' ? (
          <span className="dim text-xs">dismissed</span>
        ) : null}
      </div>
      {item.description || item.acceptance ? (
        <details className="mt-1.5">
          <summary className="dim cursor-pointer text-xs hover:underline">Details</summary>
          <div className="mt-2 flex flex-col gap-3 border-t border-zinc-100 pt-2 text-sm dark:border-zinc-800/60">
            {item.description ? <Markdown text={item.description} /> : null}
            {item.acceptance ? (
              <div>
                <h4 className="mb-1 text-xs font-semibold tracking-wide uppercase">Acceptance criteria</h4>
                <Markdown text={item.acceptance} />
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </article>
  );
}

/** CRUD over the workspace's custom methods; built-ins are listed read-only. */
function MethodsModal({
  methods,
  onClose,
  onSave,
  onUpdate,
  onDelete,
}: {
  methods: RefineMethodRecord[];
  onClose: () => void;
  onSave: (fields: { name: string; description: string; instructions: string }) => Promise<void>;
  onUpdate: (id: string, fields: { name?: string; description?: string; instructions?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  const custom = methods.filter((m) => !m.builtin);
  const builtins = methods.filter((m) => m.builtin);
  const [editing, setEditing] = useState<RefineMethodRecord | 'new' | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();

  const startEdit = (method: RefineMethodRecord | 'new'): void => {
    setEditing(method);
    setName(method === 'new' ? '' : method.name);
    setDescription(method === 'new' ? '' : method.description);
    setInstructions(method === 'new' ? '' : method.instructions);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    const fields = { name: name.trim(), description: description.trim(), instructions: instructions.trim() };
    if (editing === 'new') await onSave(fields);
    else if (editing) await onUpdate(editing.id, fields);
    setBusy(false);
    setEditing(null);
  };

  return (
    <Modal title="Decomposition methods" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        {editing ? (
          <div className="flex flex-col gap-3">
            <Field label="Name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
            <Field label="Description" hint="One line shown in the picker.">
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
            </Field>
            <Field label="Instructions" hint="Fed verbatim to the agent — how to split, order and prioritize.">
              <textarea
                className="input min-h-36"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                maxLength={8_000}
              />
            </Field>
            <FormActions>
              <button className="btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn"
                disabled={busy || name.trim().length < 2 || instructions.trim().length < 8}
                onClick={() => void save()}
              >
                {editing === 'new' ? 'Add method' : 'Save'}
              </button>
            </FormActions>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {custom.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.name}</div>
                    {m.description ? <div className="dim truncate text-xs">{m.description}</div> : null}
                  </div>
                  <button className="btn-ghost" onClick={() => startEdit(m)}>
                    Edit
                  </button>
                  <IconButton
                    label={`Delete ${m.name}`}
                    danger
                    onClick={() => {
                      void confirmDanger({
                        title: 'Delete method',
                        message: `Delete "${m.name}"? Refinements that used it keep their results.`,
                        confirmLabel: 'Delete',
                      }).then((ok) => {
                        if (ok) void onDelete(m.id);
                      });
                    }}
                  >
                    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                      <path d="m5.5 5.5 5 5M10.5 5.5l-5 5" strokeLinecap="round" />
                    </svg>
                  </IconButton>
                </div>
              ))}
              {custom.length === 0 ? <p className="dim text-sm">No custom methods yet.</p> : null}
            </div>
            <FormActions>
              <button className="btn" onClick={() => startEdit('new')}>
                New method
              </button>
            </FormActions>
            <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
              <h3 className="dim mb-2 text-xs font-semibold tracking-wide uppercase">Built-in</h3>
              <ul className="flex flex-col gap-1.5">
                {builtins.map((m) => (
                  <li key={m.id} className="dim text-[13px]">
                    <span className="font-medium">{m.name}</span> — {m.description}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
      {confirmElement}
    </Modal>
  );
}
