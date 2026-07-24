import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { useLive, type RouteProps } from '@companion/core/client';
import {
  CopyText,
  DetailGrid,
  DetailRow,
  Drawer,
  Dropdown,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  IconButton,
  Markdown,
  MetaSignal,
  Modal,
  PageHeader,
  PageLoading,
  SettingRow,
  StatusDot,
  StatusGlyph,
  Switch,
  Tooltip,
  timeAgo,
  useConfirm,
  type StatusTone,
} from '@companion/ui';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import {
  BranchPicker,
  CommentsSection,
  RepoAccountPicker,
  codeApi,
  useWorkspaceRepos,
} from '@companion/module-code/client';
import { REPO_PERMISSION_RANK, type ChecksSnapshot, type RepoRecord } from '@companion/module-code/contract';
import type {
  BoardConfig,
  SpecOption,
  TaskAttachmentInput,
  TaskEventRecord,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  WorkerRole,
  WorkerView,
} from '../../contract/index.js';
import { boardApi, type TaskDetail } from '../api.js';
import { useBoard } from '../hooks/useBoard.js';

/**
 * Board columns. All but "needs_decision" mirror a TaskStatus; needs_decision
 * is DERIVED — in_review cards whose merge waits on a human rather than on
 * machinery. Exits are the existing transitions: merge → done, reject → backlog
 * (PR kept), close the PR on GitHub → failed.
 */
type ColumnKey = TaskStatus | 'needs_decision';

const COLUMNS: ReadonlyArray<{ key: ColumnKey; label: string }> = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'ready', label: 'Ready' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'in_review', label: 'In review' },
  { key: 'needs_decision', label: 'Needs decision' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
];

/** Search results shown at once in the dependency picker — boards can hold thousands of tasks. */
const MAX_DEP_MATCHES = 30;

/** A card waiting on a human call (merge / reject) rather than on machinery. */
function needsDecision(task: TaskRecord, autoMerge: boolean): boolean {
  return (
    task.status === 'in_review' &&
    task.stage === 'awaiting_merge' &&
    !(autoMerge && task.reviewRecommendation === 'approve')
  );
}

/** Human drag targets, mirroring the server's moveTask validation. */
function canMove(task: TaskRecord, to: TaskStatus): boolean {
  if (to === task.status) return false;
  if (to === 'ready') return ['backlog', 'failed', 'in_review'].includes(task.status);
  if (to === 'backlog') return ['ready', 'failed', 'in_review', 'in_progress'].includes(task.status);
  if (to === 'done') return task.status === 'in_review';
  return false;
}

function stageLabel(task: TaskRecord): string | null {
  switch (task.stage) {
    case 'build':
      return task.status === 'ready' ? 'queued to build' : 'building';
    case 'address_review':
      return task.status === 'ready' ? 'waiting to address review' : 'addressing review';
    case 'fix_ci':
      return task.status === 'ready' ? 'waiting to repair CI' : 'repairing CI';
    case 'awaiting_review':
      return 'awaiting review';
    case 'reviewing':
      return 'under review';
    case 'awaiting_merge':
      // A 'comment' verdict neither approves nor blocks — the human decides.
      return task.reviewRecommendation === 'approve'
        ? 'ready to merge'
        : task.reviewRecommendation === 'comment'
          ? 'needs a merge decision'
          : 'awaiting merge';
    default:
      return null;
  }
}

/** The card's one status line: tone + label for where the task is right now. */
function cardSignal(
  task: TaskRecord,
  attention: boolean,
): { tone: StatusTone; label: string; pulse?: boolean } | null {
  if (task.status === 'failed') return { tone: 'red', label: 'failed' };
  const label = stageLabel(task);
  if (!label) return null;
  if (task.status === 'in_progress' || task.stage === 'reviewing') return { tone: 'blue', label, pulse: true };
  if (attention || (task.stage === 'awaiting_merge' && task.reviewRecommendation !== 'approve')) {
    return { tone: 'amber', label };
  }
  if (task.stage === 'awaiting_merge') return { tone: 'green', label };
  return { tone: 'zinc', label };
}

const PRIORITY_CLS: Record<TaskPriority, string> = {
  0: 'bg-red-500/10 text-red-600 dark:text-red-400',
  1: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  2: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  3: 'bg-zinc-500/10 text-zinc-400 dark:text-zinc-500',
};

const PRIORITY_OPTIONS = [
  { value: '0', label: 'P0 — urgent' },
  { value: '1', label: 'P1 — high' },
  { value: '2', label: 'P2 — normal' },
  { value: '3', label: 'P3 — someday' },
] as const;

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_CONTENT = 1_500_000;

/** Keep task payloads bounded while retaining enough detail for visual reference. */
async function fileToAttachment(file: File): Promise<TaskAttachmentInput> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Use a PNG, JPEG, or WebP image');
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`Could not read ${file.name}`));
      element.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    return { name: file.name, mediaType: 'image/jpeg', content: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function AttachmentEditor({
  attachments,
  onChange,
  onError,
}: {
  attachments: readonly TaskAttachmentInput[];
  onChange: (attachments: TaskAttachmentInput[]) => void;
  onError: (error: string) => void;
}): JSX.Element {
  const [reading, setReading] = useState(false);
  const addFiles = useCallback(async (files: FileList | readonly File[] | null): Promise<void> => {
    const selected = files ? [...files] : [];
    if (selected.length === 0) return;
    if (attachments.length + selected.length > MAX_ATTACHMENTS) {
      onError(`A task can have up to ${MAX_ATTACHMENTS} images`);
      return;
    }
    setReading(true);
    try {
      const added = await Promise.all(selected.map(fileToAttachment));
      const next = [...attachments, ...added];
      if (next.reduce((total, attachment) => total + attachment.content.length, 0) > MAX_ATTACHMENT_CONTENT) {
        throw new Error('Images are too large in total. Remove an image or use smaller screenshots.');
      }
      onChange(next);
    } catch (err) {
      onError(String(err));
    } finally {
      setReading(false);
    }
  }, [attachments, onChange, onError]);

  useEffect(() => {
    const paste = (event: ClipboardEvent): void => {
      if (reading) return;
      const images = [...(event.clipboardData?.items ?? [])]
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .flatMap((item) => {
          const file = item.getAsFile();
          return file ? [file] : [];
        });
      if (images.length === 0) return;
      event.preventDefault();
      void addFiles(images);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [addFiles, reading]);

  return (
    <Field label="Screens & references" hint="PNG, JPEG, or WebP. Attach a file or paste an image with Ctrl/Cmd+V.">
      <div className="flex flex-col gap-2">
        {attachments.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {attachments.map((attachment, index) => (
              <div key={`${attachment.name}-${index}`} className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
                <img src={`data:${attachment.mediaType};base64,${attachment.content}`} alt={attachment.name} className="size-full object-cover" />
                <button
                  type="button"
                  className="absolute top-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white opacity-80 hover:opacity-100"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => onChange(attachments.filter((_, itemIndex) => itemIndex !== index))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachments.length < MAX_ATTACHMENTS ? (
          <label className="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-zinc-300 px-3 py-3 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
            {reading ? 'Preparing images…' : 'Attach images'}
            <input
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={reading}
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
        ) : null}
      </div>
    </Field>
  );
}

function AttachmentGallery({ attachments }: { attachments: TaskRecord['attachments'] }): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide uppercase">Attachments</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {attachments.flatMap((attachment) =>
          attachment.content
            ? [
                <a key={attachment.id} href={`data:${attachment.mediaType};base64,${attachment.content}`} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <img src={`data:${attachment.mediaType};base64,${attachment.content}`} alt={attachment.name} className="aspect-video w-full object-cover transition-transform group-hover:scale-[1.02]" />
                  <span className="block truncate px-2 py-1.5 text-xs">{attachment.name}</span>
                </a>,
              ]
            : [],
        )}
      </div>
    </section>
  );
}

export default function Board({ query }: RouteProps): JSX.Element {
  const { current } = useWorkspace();
  const { tasks, workers, config, loaded, error, setError } = useBoard(current?.id);
  const repos = useWorkspaceRepos(current?.id);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [managingWorkers, setManagingWorkers] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [dragging, setDragging] = useState<TaskRecord | null>(null);
  const [dropTarget, setDropTarget] = useState<ColumnKey | null>(null);

  // Notification deep link (#/board?task=…) opens the task's detail view.
  useEffect(() => {
    const id = query.get('task');
    if (id) setDetailId(id);
  }, [query]);

  // Closing the detail drops the deep-link param, so a refresh (or HMR
  // remount) doesn't resurrect a modal the user already dismissed.
  const closeDetail = useCallback(() => {
    setDetailId(null);
    if (window.location.hash.includes('?task=')) window.location.hash = '/board';
  }, []);

  // The board is read one repository at a time: each repo has its own GitHub
  // access and its own acting account, so the scope selector is also where
  // those are stated. `null` means "not resolved yet" — the first render after
  // a workspace switch picks a repo rather than dumping every repo's cards.
  const [scope, setScope] = useState<string | null>(null);
  useEffect(() => {
    setScope(current?.id ? window.localStorage.getItem(scopeKey(current.id)) : null);
  }, [current?.id]);
  const repoOptions = useMemo(() => {
    const names = new Set<string>([...repos.map((r) => r.fullName), ...tasks.map((t) => t.repo)]);
    return [...names].sort();
  }, [repos, tasks]);
  useEffect(() => {
    if (scope !== null || repoOptions.length === 0) return;
    // Prefer a repo this profile can actually push to — that is where work lands.
    setScope(repos.find(canBoardPush)?.fullName ?? repoOptions[0]!);
  }, [scope, repoOptions, repos]);
  const chooseScope = useCallback(
    (value: string) => {
      setScope(value);
      if (current?.id) window.localStorage.setItem(scopeKey(current.id), value);
    },
    [current?.id],
  );

  const scopedRepo = scope && scope !== ALL_REPOS && repoOptions.includes(scope) ? scope : null;
  const visibleTasks = useMemo(
    () => (scopedRepo ? tasks.filter((t) => t.repo === scopedRepo) : tasks),
    [tasks, scopedRepo],
  );
  const scopedRecord = scopedRepo ? repos.find((r) => r.fullName === scopedRepo) : undefined;

  const autoMerge = config?.autoMerge ?? true;
  const byColumn = useMemo(() => {
    const map = new Map<ColumnKey, TaskRecord[]>(COLUMNS.map((c) => [c.key, []]));
    for (const t of visibleTasks) map.get(needsDecision(t, autoMerge) ? 'needs_decision' : t.status)?.push(t);
    return map;
  }, [visibleTasks, autoMerge]);

  const workerName = useCallback(
    (id: string | null) => (id ? (workers.find((w) => w.id === id)?.name ?? 'unknown') : null),
    [workers],
  );

  // Short repo names collide across owners (forks, same-named projects) — an
  // ambiguous short name renders as the full owner/name instead. Collisions are
  // detected across the workspace's repos AND the board's tasks, so a card
  // disambiguates even when only one of the twins has tasks here.
  const repoLabel = useMemo(() => {
    const fullsByShort = new Map<string, Set<string>>();
    const note = (full: string): void => {
      const short = full.split('/')[1] ?? full;
      const set = fullsByShort.get(short) ?? new Set<string>();
      set.add(full);
      fullsByShort.set(short, set);
    };
    for (const r of repos) note(r.fullName);
    for (const t of tasks) note(t.repo);
    return (full: string): string => {
      const short = full.split('/')[1] ?? full;
      return (fullsByShort.get(short)?.size ?? 0) > 1 ? full : short;
    };
  }, [repos, tasks]);

  // Unfinished prerequisites of a card, by title. Deps outside the caller's
  // repo access aren't in the snapshot and simply don't show.
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const waitingOn = useCallback(
    (task: TaskRecord): string[] =>
      task.status === 'done'
        ? []
        : task.dependsOn.flatMap((depId) => {
            const dep = taskById.get(depId);
            return dep && dep.status !== 'done' ? [dep.title] : [];
          }),
    [taskById],
  );

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    },
    [setError],
  );

  const onDrop = (col: ColumnKey): void => {
    const task = dragging;
    setDragging(null);
    setDropTarget(null);
    if (task && col !== 'needs_decision' && canMove(task, col)) void act(() => boardApi.moveTask(task.id, col));
  };

  if (!loaded) return <PageLoading label="Loading the board…" />;

  const busyCount = workers.filter((w) => w.busy).length;
  const inFlight = visibleTasks.filter((t) => t.status === 'in_progress' || t.status === 'in_review').length;
  const decisions = byColumn.get('needs_decision')?.length ?? 0;

  return (
    <div className="w-full px-6 py-6">
      <PageHeader
        title="Task Board"
        subtitle={
          `${inFlight} in flight · ${busyCount}/${workers.filter((w) => w.enabled).length || 0} workers busy` +
          (decisions > 0 ? ` · ${decisions} need${decisions === 1 ? 's' : ''} your decision` : '')
        }
        actions={
          <>
            {repoOptions.length > 1 ? (
              <div className="w-56">
                <Dropdown
                  ariaLabel="Repository scope"
                  value={scopedRepo ?? ALL_REPOS}
                  onChange={chooseScope}
                  options={[
                    ...repoOptions.map((fullName) => {
                      const record = repos.find((r) => r.fullName === fullName);
                      return {
                        value: fullName,
                        label: repoLabel(fullName),
                        hint: record && !canBoardPush(record) ? accessHint(record) : undefined,
                      };
                    }),
                    { value: ALL_REPOS, label: 'All repositories' },
                  ]}
                  searchable={repoOptions.length > 6}
                />
              </div>
            ) : null}
            {/* Which of my credentials acts on the scoped repo. Hidden unless
                several of my accounts are eligible — nothing to decide then. */}
            {scopedRepo ? <RepoAccountPicker repo={scopedRepo} className="w-44" /> : null}
            <button className="btn-ghost" onClick={() => setManagingWorkers(true)}>
              Workers
            </button>
            <button className="btn-ghost" onClick={() => setConfiguring(true)}>
              Flow
            </button>
            <button className="btn" onClick={() => setCreating(true)}>
              New task
            </button>
          </>
        }
      />
      <ErrorBar error={error} className="mb-3" />
      {scopedRecord && !canBoardPush(scopedRecord) ? (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {scopedRecord.githubPermission === null
            ? `None of your connected GitHub accounts can see ${scopedRepo}. Connect one with access to work on it here.`
            : `Your GitHub access to ${scopedRepo} is read-only, so the board cannot push a branch or open a pull request. ` +
              `Existing cards stay put; grant write access and they start on their own.`}
        </div>
      ) : null}
      {workers.filter((w) => w.enabled && w.role === 'developer').length === 0 ? (
        <div className="mb-4">
          <EmptyState
            title="No developer workers yet"
            hint="Tasks queue up but nothing builds until you add a worker."
            action={
              <button className="btn" onClick={() => setManagingWorkers(true)}>
                Add a worker
              </button>
            }
          />
        </div>
      ) : null}

      {/* Horizontal kanban rail: columns keep a readable width and the board
          scrolls sideways instead of squeezing seven columns into the viewport. */}
      <div className="-mx-6 overflow-x-auto px-6">
        <div className="flex items-stretch gap-3 pb-4">
        {COLUMNS.map((col) => {
          const cards = byColumn.get(col.key) ?? [];
          const droppable = dragging && col.key !== 'needs_decision' ? canMove(dragging, col.key) : false;
          const countClass =
            cards.length > 0 && col.key === 'needs_decision'
              ? 'font-semibold text-amber-600 dark:text-amber-400'
              : cards.length > 0 && col.key === 'failed'
                ? 'font-semibold text-red-600 dark:text-red-400'
                : 'dim';
          return (
            <section
              key={col.key}
              aria-label={col.label}
              className={`flex min-h-[62vh] max-w-[400px] flex-[1_0_280px] flex-col rounded-xl border p-2 transition-colors ${
                dropTarget === col.key && droppable
                  ? 'border-zinc-400 bg-zinc-100/80 dark:border-zinc-500 dark:bg-zinc-800/60'
                  : droppable
                    ? 'border-dashed border-zinc-300 dark:border-zinc-600'
                    : 'border-zinc-200 dark:border-zinc-800'
              }`}
              onDragOver={(e: DragEvent) => {
                if (!droppable) return;
                e.preventDefault();
                setDropTarget(col.key);
              }}
              onDragLeave={() => setDropTarget((prev) => (prev === col.key ? null : prev))}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                onDrop(col.key);
              }}
            >
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-xs font-semibold tracking-wide uppercase">{col.label}</h2>
                <span className={`text-xs tabular-nums ${countClass}`}>{cards.length}</span>
              </header>
              <div className="flex flex-1 flex-col gap-2">
                {cards.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    repoLabel={repoLabel(task.repo)}
                    workerName={workerName(task.assignedWorkerId)}
                    waitingOn={waitingOn(task)}
                    attention={col.key === 'needs_decision'}
                    onOpen={() => setDetailId(task.id)}
                    onDragStart={() => setDragging(task)}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                  />
                ))}
                {col.key === 'needs_decision' && cards.length === 0 ? (
                  <p className="dim px-1 text-[11px]">Cards land here when a merge needs your call.</p>
                ) : null}
              </div>
            </section>
          );
        })}
        </div>
      </div>

      {creating && current ? (
        <NewTaskModal
          workspaceId={current.id}
          repos={repos}
          defaultRepo={scopedRepo}
          onClose={() => setCreating(false)}
          onError={setError}
        />
      ) : null}
      {detailId ? (
        <TaskDetailDrawer id={detailId} allTasks={tasks} workerName={workerName} onClose={closeDetail} onError={setError} />
      ) : null}
      {managingWorkers && current ? (
        <WorkersModal
          workspaceId={current.id}
          workers={workers}
          repoLabel={repoLabel}
          onClose={() => setManagingWorkers(false)}
          onError={setError}
        />
      ) : null}
      {configuring && config && current ? (
        <ConfigModal
          workspaceId={current.id}
          config={config}
          workers={workers}
          onClose={() => setConfiguring(false)}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function TaskCard({
  task,
  repoLabel,
  workerName,
  waitingOn,
  attention,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  task: TaskRecord;
  /** Repo display name — short, or owner/name when the short name is ambiguous. */
  repoLabel: string;
  workerName: string | null;
  /** Titles of unfinished prerequisites — the card won't dispatch until they're done. */
  waitingOn: string[];
  /** The card sits in the needs-decision column — waiting on the human. */
  attention?: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}): JSX.Element {
  const signal = cardSignal(task, attention ?? false);
  const hasChips =
    task.prUrl != null ||
    task.reviewRecommendation != null ||
    task.attempts > 0 ||
    task.attachments.length > 0 ||
    task.specId != null ||
    waitingOn.length > 0;
  const borderClass = attention
    ? 'border-amber-400/60 dark:border-amber-500/40'
    : task.status === 'failed'
      ? 'border-red-400/50 dark:border-red-500/30'
      : 'border-zinc-200 dark:border-zinc-700';
  return (
    <article
      draggable
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={task.title}
      className={`cursor-pointer rounded-lg border bg-white p-3 text-left shadow-sm transition-shadow hover:shadow dark:bg-zinc-900 ${borderClass}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 min-w-0 text-[13px] leading-snug font-medium" title={task.title}>
          {task.title}
        </h3>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${PRIORITY_CLS[task.priority]}`}>
          P{task.priority}
        </span>
      </div>
      <p className="dim mt-1 flex min-w-0 items-baseline gap-1.5 text-[11px]">
        <span className="truncate font-mono" title={task.repo}>
          {repoLabel}
        </span>
        {workerName ? (
          <>
            <span className="shrink-0" aria-hidden>
              ·
            </span>
            <span className="truncate">{workerName}</span>
          </>
        ) : null}
      </p>
      {signal ? (
        <div className="mt-2">
          <MetaSignal tone={signal.tone} label={signal.label} pulse={signal.pulse} />
        </div>
      ) : null}
      {hasChips ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800/60">
          {task.prUrl ? (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              PR #{task.prNumber}
            </a>
          ) : null}
          {task.reviewRecommendation ? (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                task.reviewRecommendation === 'approve'
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : task.reviewRecommendation === 'request_changes'
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : 'bg-zinc-500/10 text-zinc-500'
              }`}
            >
              {task.reviewRecommendation === 'request_changes' ? 'changes requested' : task.reviewRecommendation}
            </span>
          ) : null}
          {task.attempts > 0 ? (
            <Tooltip content={`${task.attempts} remediation cycle(s) used`}>
              <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[10px] tabular-nums">↻ {task.attempts}</span>
            </Tooltip>
          ) : null}
          {task.attachments.length > 0 ? (
            <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400">
              {task.attachments.length} image{task.attachments.length === 1 ? '' : 's'}
            </span>
          ) : null}
          {task.specId ? (
            <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-500">spec</span>
          ) : null}
          {waitingOn.length > 0 ? (
            <Tooltip content={`waits for: ${waitingOn.join(' · ')}`}>
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                ⛓ waits for {waitingOn.length}
              </span>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {task.lastError ? <p className="mt-2 line-clamp-2 text-[11px] text-red-600 dark:text-red-400">{task.lastError}</p> : null}
    </article>
  );
}

/** Sentinel for the unscoped board — repo full names always contain a slash. */
const ALL_REPOS = '*';

/** The scope choice is per workspace and survives reloads. */
function scopeKey(workspaceId: string): string {
  return `companion.board.repo:${workspaceId}`;
}

/** Board work needs write: it pushes the branch and opens the PR for you. */
function canBoardPush(repo: RepoRecord): boolean {
  return repo.githubPermission !== null && REPO_PERMISSION_RANK[repo.githubPermission] >= REPO_PERMISSION_RANK.push;
}

function accessHint(repo: RepoRecord): string {
  return repo.githubPermission === null
    ? 'no connected account can see this repo'
    : 'read-only access — the board cannot push here';
}

function NewTaskModal({
  workspaceId,
  repos,
  defaultRepo,
  onClose,
  onError,
}: {
  workspaceId: string;
  repos: readonly RepoRecord[];
  /** The board's current repo scope — the task almost always belongs to it. */
  defaultRepo: string | null;
  onClose: () => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const [repo, setRepo] = useState<string | null>(null);
  const [targetBranch, setTargetBranch] = useState('main');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [attachments, setAttachments] = useState<TaskAttachmentInput[]>([]);
  const [specs, setSpecs] = useState<SpecOption[]>([]);
  const [specId, setSpecId] = useState<string | null>(null);
  const [queue, setQueue] = useState(true);
  const [busy, setBusy] = useState(false);

  // The board itself pushes the branch and opens the PR, so a repo the profile
  // can only read cannot host a task — offering one would queue work that dies
  // at the push. Fall back to the first writable repo when the scope is unusable.
  const scoped = defaultRepo ? repos.find((r) => r.fullName === defaultRepo) : undefined;
  const effectiveRepo = repo ?? (scoped && canBoardPush(scoped) ? scoped.fullName : null) ?? repos.find(canBoardPush)?.fullName ?? null;

  useEffect(() => {
    setTargetBranch(repos.find((candidate) => candidate.fullName === effectiveRepo)?.defaultBranch || 'main');
  }, [effectiveRepo, repos]);

  useEffect(() => {
    setSpecs([]);
    setSpecId(null);
    if (!effectiveRepo) return;
    let cancelled = false;
    void boardApi
      .specs(effectiveRepo, workspaceId)
      .then((r) => {
        if (!cancelled) setSpecs(r.specs);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [effectiveRepo, workspaceId]);

  const submit = async (): Promise<void> => {
    if (!effectiveRepo || !title.trim()) return;
    setBusy(true);
    try {
      await boardApi.createTask({
        workspaceId,
        repo: effectiveRepo,
        targetBranch: targetBranch.trim() || 'main',
        title: title.trim(),
        description,
        acceptance,
        specId,
        attachments,
        priority,
        queue,
      });
      onError(null);
      onClose();
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New task" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Repository">
          <Dropdown
            ariaLabel="Repository"
            value={effectiveRepo}
            onChange={(v) => setRepo(v)}
            options={repos.map((r) => ({
              value: r.fullName,
              label: r.fullName,
              disabled: !canBoardPush(r),
              hint: canBoardPush(r) ? undefined : accessHint(r),
            }))}
            searchable
          />
        </Field>
        <Field label="Target branch" hint="The worker starts here and opens the pull request back to this branch.">
          <BranchPicker
            repo={effectiveRepo}
            workspaceId={workspaceId}
            value={targetBranch}
            onChange={setTargetBranch}
            defaultBranch={repos.find((candidate) => candidate.fullName === effectiveRepo)?.defaultBranch}
            ariaLabel="Target branch"
          />
        </Field>
        <Field label="Title">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ship the CSV export"
            maxLength={200}
          />
        </Field>
        <Field label="Description" hint="Definition of ready — scope, context and constraints the worker needs.">
          <textarea
            className="input min-h-28"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={20_000}
          />
        </Field>
        <Field label="Acceptance criteria" hint="Definition of done — the worker builds against it, the reviewer checks against it.">
          <textarea
            className="input min-h-20"
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            maxLength={10_000}
          />
        </Field>
        <AttachmentEditor attachments={attachments} onChange={setAttachments} onError={onError} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Dropdown
              ariaLabel="Priority"
              value={String(priority) as '0' | '1' | '2' | '3'}
              onChange={(v) => setPriority(Number(v) as TaskPriority)}
              options={PRIORITY_OPTIONS}
            />
          </Field>
          {specs.length > 0 ? (
            <Field label="Spec" hint="Handed to the worker as context.">
              <Dropdown
                ariaLabel="Spec"
                value={specId}
                onChange={(v) => setSpecId(v)}
                options={[{ value: '', label: 'None' }, ...specs.map((s) => ({ value: s.id, label: s.title }))]}
                placeholder="None"
              />
            </Field>
          ) : null}
        </div>
        <SettingRow title="Queue immediately" description="Straight to Ready — the next free worker picks it up.">
          <Switch checked={queue} onChange={setQueue} label="Queue immediately" />
        </SettingRow>
        <FormActions>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !title.trim() || !effectiveRepo} onClick={() => void submit()}>
            Create
          </button>
        </FormActions>
      </div>
    </Modal>
  );
}

/** Recommendation pill shared by the card footer and the review history. */
function VerdictChip({ recommendation }: { recommendation: 'approve' | 'request_changes' | 'comment' }): JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
        recommendation === 'approve'
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : recommendation === 'request_changes'
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'bg-zinc-500/10 text-zinc-500'
      }`}
    >
      {recommendation === 'request_changes' ? 'changes requested' : recommendation}
    </span>
  );
}

const RISK_CLS = {
  low: 'bg-zinc-500/10 text-zinc-500',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  high: 'bg-red-500/10 text-red-600 dark:text-red-400',
} as const;

/** Mini section header inside the task detail's left column. */
function DetailHeading({ children }: { children: ReactNode }): JSX.Element {
  return <h4 className="mb-1.5 text-xs font-semibold tracking-wide uppercase">{children}</h4>;
}

function ChecksLine({ checks }: { checks: ChecksSnapshot | null }): JSX.Element {
  if (!checks || checks.state === 'none') {
    return (
      <span className="flex items-center gap-1.5">
        <StatusGlyph tone="muted" label="No pipelines" /> <span className="dim">no pipelines reported</span>
      </span>
    );
  }
  if (checks.state === 'unknown') {
    return (
      <span className="flex items-center gap-1.5">
        <StatusGlyph tone="warn" label="Checks unavailable" />{' '}
        <span className="dim">checks unavailable — GitHub token can&apos;t read CI</span>
      </span>
    );
  }
  const tone = checks.state === 'passing' ? 'ok' : checks.state === 'failing' ? 'danger' : 'warn';
  const parts = [
    `${checks.passed} passed`,
    ...(checks.failed > 0 ? [`${checks.failed} failed`] : []),
    ...(checks.pending > 0 ? [`${checks.pending} running`] : []),
  ];
  return (
    <span className="flex items-center gap-1.5">
      <StatusGlyph tone={tone} label={`Checks ${checks.state}`} />
      {checks.state} — {parts.join(' · ')}
    </span>
  );
}

function TaskDetailDrawer({
  id,
  allTasks,
  workerName,
  onClose,
  onError,
}: {
  id: string;
  /** The board snapshot — candidates for the dependency picker. */
  allTasks: TaskRecord[];
  workerName: (id: string | null) => string | null;
  onClose: () => void;
  onError: (e: string | null) => void;
}): JSX.Element | null {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [attachments, setAttachments] = useState<TaskAttachmentInput[]>([]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  // dependsOn is also machine-written (refinement late-linking) — an untouched
  // picker must not overwrite edges that arrived while the form was open.
  const [depsTouched, setDepsTouched] = useState(false);
  const [depQuery, setDepQuery] = useState('');
  const [depFocused, setDepFocused] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();
  const { can } = useAuth();

  // Tasks that (transitively) depend on this one — offering them as a
  // prerequisite would close a cycle. The server enforces this too.
  const depCandidates = useMemo(() => {
    const forbidden = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of allTasks) {
        if (!forbidden.has(t.id) && t.dependsOn.some((d) => forbidden.has(d))) {
          forbidden.add(t.id);
          grew = true;
        }
      }
    }
    return allTasks.filter((t) => !forbidden.has(t.id));
  }, [allTasks, id]);

  // Boards can hold thousands of tasks — candidates surface through search
  // only, already-picked ones excluded (they show as chips instead).
  const depMatches = useMemo(() => {
    const query = depQuery.trim().toLowerCase();
    if (!query) return [];
    return depCandidates.filter((t) => !dependsOn.includes(t.id) && t.title.toLowerCase().includes(query));
  }, [depQuery, depCandidates, dependsOn]);

  const refresh = useCallback(async () => {
    try {
      setDetail(await boardApi.task(id));
    } catch {
      onClose(); // deleted under us
    }
  }, [id, onClose]);

  useLive(refresh, (msg) => msg.t === 'board.changed');

  if (!detail) return null;
  const { task, events, pr, reviews, dependencies } = detail;

  // Chip titles: the snapshot first, then the server-resolved detail (covers
  // deps whose repo the snapshot filter dropped).
  const depTitle = (depId: string): string =>
    allTasks.find((t) => t.id === depId)?.title ??
    dependencies.find((dep) => dep.id === depId)?.title ??
    'a task outside your access';

  const act = (fn: () => Promise<unknown>) => (): void => {
    void fn()
      .then(() => {
        onError(null);
        return refresh();
      })
      .catch((err) => onError(String(err)));
  };

  const saveEdit = act(async () => {
    await boardApi.updateTask(id, {
      title: title.trim() || task.title,
      description,
      acceptance,
      priority,
      attachments,
      ...(depsTouched ? { dependsOn } : {}),
    });
    setEditing(false);
  });

  const active = task.status === 'in_progress' || task.stage === 'reviewing';
  const signal = cardSignal(task, false);
  const currentWorker = workerName(task.assignedWorkerId);
  const verdicts = reviews.filter((r) => r.verdict != null);

  return (
    <Drawer title={task.title} onClose={onClose} storageKey="companion.board.task-drawer" defaultWidth={350} minWidth={320}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {signal ? <MetaSignal tone={signal.tone} label={signal.label} pulse={signal.pulse} /> : null}
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${PRIORITY_CLS[task.priority]}`}>
            P{task.priority}
          </span>
          {task.runId ? (
            <a className="text-xs font-medium hover:underline" href={`#/runs/${task.runId}`} onClick={onClose}>
              watch the live run →
            </a>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-3.5 dark:border-zinc-800">
          {task.status === 'in_review' && task.prNumber != null && task.stage !== 'reviewing' ? (
            <button className="btn" onClick={act(() => boardApi.mergeTask(id))}>
              Merge PR
            </button>
          ) : null}
          {canMove(task, 'ready') ? (
            <button className={task.status === 'in_review' ? 'btn-ghost' : 'btn'} onClick={act(() => boardApi.moveTask(id, 'ready'))}>
              {task.status === 'failed' ? 'Retry' : task.status === 'in_review' ? 'Re-review' : 'Queue'}
            </button>
          ) : null}
          {canMove(task, 'backlog') ? (
            <button className="btn-ghost" onClick={act(() => boardApi.moveTask(id, 'backlog'))}>
              {task.status === 'in_progress' ? 'Cancel & park' : task.status === 'in_review' ? 'Reject' : 'Park'}
            </button>
          ) : null}
          {canMove(task, 'done') ? (
            <button className="btn-ghost" onClick={act(() => boardApi.moveTask(id, 'done'))}>
              Mark done
            </button>
          ) : null}
          {!editing ? (
            <button
              className="btn-ghost"
              onClick={() => {
                setTitle(task.title);
                setDescription(task.description);
                setAcceptance(task.acceptance);
                setPriority(task.priority);
                setAttachments(
                  task.attachments.flatMap(({ name, mediaType, content }) =>
                    content ? [{ name, mediaType, content }] : [],
                  ),
                );
                setDependsOn([...task.dependsOn]);
                setDepsTouched(false);
                setDepQuery('');
                setEditing(true);
              }}
            >
              Edit
            </button>
          ) : null}
          <span className="flex-1" />
          <IconButton
            label="Delete task"
            danger
            onClick={() => {
              void confirmDanger({
                title: 'Delete task',
                message: `Delete "${task.title}"? An active run is stopped and its worktree discarded.`,
                confirmLabel: 'Delete',
              }).then((ok) => {
                if (!ok) return;
                void boardApi
                  .deleteTask(id)
                  .then(onClose)
                  .catch((err) => onError(String(err)));
              });
            }}
          >
            {/* trash */}
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              <path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3M4.7 4.5l.5 8.3a1 1 0 0 0 1 .95h3.6a1 1 0 0 0 1-.95l.5-8.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>
        </div>

        <DetailGrid>
          <DetailRow label="Repository">
            <span className="font-mono">{task.repo}</span>
          </DetailRow>
          <DetailRow label="Target branch">
            <CopyText value={task.targetBranch}>
              <span className="font-mono">{task.targetBranch}</span>
            </CopyText>
          </DetailRow>
          {task.branch ? (
            <DetailRow label="Working branch">
              <CopyText value={task.branch}>
                <span className="font-mono">{task.branch}</span>
              </CopyText>
            </DetailRow>
          ) : null}
          {task.prUrl ? (
            <DetailRow label="Pull request">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <a className="font-medium hover:underline" href={task.prUrl} target="_blank" rel="noreferrer">
                  PR #{task.prNumber} ↗
                </a>
                <a
                  className="font-medium hover:underline"
                  href={`#/repos/${task.repo}/prs/${task.prNumber}/review`}
                  onClick={onClose}
                >
                  review page
                </a>
                {pr && pr.state !== 'open' ? <span className="dim">{pr.state}</span> : null}
                {pr?.reviewDecision ? (
                  <span className="dim">GitHub: {pr.reviewDecision.replace('_', ' ')}</span>
                ) : null}
              </span>
            </DetailRow>
          ) : null}
          {task.prNumber != null ? (
            <DetailRow label="Checks">
              <ChecksLine checks={pr?.checks ?? null} />
            </DetailRow>
          ) : null}
          {dependencies.length > 0 ? (
            <DetailRow label="Depends on">
              <span className="flex min-w-0 flex-col gap-0.5">
                {dependencies.map((dep) => (
                  <span key={dep.id} className={`truncate ${dep.status === 'done' ? 'dim' : ''}`}>
                    <span aria-hidden>{dep.status === 'done' ? '✓' : '⛓'}</span> {dep.title ?? 'a task outside your access'}
                    {dep.status !== 'done' ? <span className="dim"> · {dep.status.replace('_', ' ')}</span> : null}
                  </span>
                ))}
              </span>
            </DetailRow>
          ) : null}
          <DetailRow label="Author">{task.createdBy ?? '—'}</DetailRow>
          <DetailRow label="Worker">
            {task.firstWorker ?? currentWorker ?? 'not picked up yet'}
            {currentWorker && task.firstWorker && currentWorker !== task.firstWorker ? (
              <span className="dim"> · now {currentWorker}</span>
            ) : null}
            {task.attempts > 0 ? <span className="dim"> · {task.attempts} remediation cycle(s)</span> : null}
          </DetailRow>
          <DetailRow label="Timeline">
            created {timeAgo(task.createdAt)}
            {task.startedAt ? ` · started ${timeAgo(task.startedAt)}` : ''}
            {task.finishedAt ? ` · finished ${timeAgo(task.finishedAt)}` : ''}
          </DetailRow>
        </DetailGrid>

        {task.lastError ? <ErrorBar error={task.lastError} /> : null}

        {editing ? (
          <div className="flex flex-col gap-3">
            <Field label="Title">
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Description">
              <textarea
                className="input min-h-32"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={20_000}
              />
            </Field>
            <Field label="Acceptance criteria" hint="Definition of done — what must be true for this task to count as complete.">
              <textarea
                className="input min-h-20"
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
                maxLength={10_000}
              />
            </Field>
            <Field label="Priority">
              <Dropdown
                ariaLabel="Priority"
                value={String(priority) as '0' | '1' | '2' | '3'}
                onChange={(value) => setPriority(Number(value) as TaskPriority)}
                options={PRIORITY_OPTIONS}
              />
            </Field>
            {depCandidates.length > 0 || dependsOn.length > 0 ? (
              <Field
                label={`Depends on${dependsOn.length > 0 ? ` (${dependsOn.length})` : ''}`}
                hint="This task is not dispatched until every selected task is done."
              >
                <div className="flex flex-col gap-2">
                  {dependsOn.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {dependsOn.map((depId) => (
                        <span
                          key={depId}
                          className="flex max-w-full items-center gap-1 rounded-full bg-zinc-500/10 py-0.5 pr-1 pl-2 text-[11px]"
                        >
                          <span className="min-w-0 truncate">{depTitle(depId)}</span>
                          <button
                            type="button"
                            aria-label={`Remove dependency: ${depTitle(depId)}`}
                            className="dim shrink-0 rounded-full px-1 hover:bg-zinc-500/20 hover:text-red-500"
                            onClick={() => {
                              setDepsTouched(true);
                              setDependsOn((prev) => prev.filter((x) => x !== depId));
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="relative">
                    <input
                      className="input w-full"
                      value={depQuery}
                      onChange={(e) => setDepQuery(e.target.value)}
                      onFocus={() => setDepFocused(true)}
                      onBlur={() => setDepFocused(false)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setDepQuery('');
                      }}
                      placeholder="Search tasks to add…"
                      aria-label="Search tasks to add as dependencies"
                    />
                    {depFocused && depQuery.trim() ? (
                      // Floating like the ui-kit Dropdown menu — it must not
                      // stretch the form. mousedown is swallowed so picking a
                      // result doesn't blur the input and close the panel.
                      <div
                        className="absolute top-full right-0 left-0 z-40 mt-1 flex max-h-44 flex-col overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        {depMatches.slice(0, MAX_DEP_MATCHES).map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-left text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            onClick={() => {
                              setDepsTouched(true);
                              setDependsOn((prev) => [...prev, candidate.id]);
                            }}
                          >
                            <span className={`min-w-0 flex-1 truncate ${candidate.status === 'done' ? 'dim' : ''}`}>
                              {candidate.title}
                            </span>
                            <span className="dim shrink-0 text-[11px]">{candidate.status.replace('_', ' ')}</span>
                          </button>
                        ))}
                        {depMatches.length === 0 ? <p className="dim px-2 py-1.5 text-[13px]">No matching tasks.</p> : null}
                        {depMatches.length > MAX_DEP_MATCHES ? (
                          <p className="dim border-t border-zinc-100 px-2 py-1.5 text-[11px] dark:border-zinc-800/60">
                            …and {depMatches.length - MAX_DEP_MATCHES} more — keep typing to narrow it down.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </Field>
            ) : null}
            <AttachmentEditor attachments={attachments} onChange={setAttachments} onError={(error) => onError(error)} />
            <FormActions>
              <button className="btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="btn" onClick={saveEdit}>
                Save
              </button>
            </FormActions>
          </div>
        ) : (
          <>
            {/* The 16rem gallery column only exists when there is a gallery —
                otherwise the description spans the drawer like its siblings. */}
            <div className={`grid gap-4 ${task.attachments.length > 0 ? 'md:grid-cols-[minmax(0,1fr)_16rem]' : ''}`}>
              <section aria-label="Description">
                <DetailHeading>Description</DetailHeading>
                <div className="max-h-56 overflow-y-auto rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                  {task.description ? <Markdown text={task.description} /> : <p className="dim">No description.</p>}
                </div>
              </section>
              <AttachmentGallery attachments={task.attachments} />
            </div>
            {task.acceptance.trim() ? (
              <section aria-label="Acceptance criteria">
                <DetailHeading>
                  Acceptance criteria <span className="dim font-normal normal-case">· definition of done</span>
                </DetailHeading>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                  <Markdown text={task.acceptance} />
                </div>
              </section>
            ) : null}
          </>
        )}

        {verdicts.length > 0 ? (
          <section aria-label="Reviews">
            <DetailHeading>
              Reviews <span className="dim font-normal normal-case">· {verdicts.length}</span>
            </DetailHeading>
            <div className="flex flex-col gap-2.5">
              {verdicts.map((r) => (
                <article key={r.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <VerdictChip recommendation={r.verdict!.recommendation} />
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${RISK_CLS[r.verdict!.risk]}`}>
                      risk {r.verdict!.risk}
                    </span>
                    {r.status !== 'applied' ? <span className="dim">{r.status}</span> : null}
                    <span className="dim ml-auto tabular-nums">{timeAgo(r.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-[13px]">{r.verdict!.summary}</p>
                  {r.verdict!.findings.length > 0 ? (
                    <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[13px]">
                      {r.verdict!.findings.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  ) : null}
                  <details className="mt-2">
                    <summary className="dim cursor-pointer text-xs hover:underline">Full review as posted</summary>
                    <div className="mt-2 border-t border-zinc-100 pt-2 text-sm dark:border-zinc-800/60">
                      <Markdown text={r.verdict!.reviewBody} />
                    </div>
                  </details>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-label="Activity">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
            Activity
            {active ? <StatusDot tone="blue" pulse size="sm" label="live" /> : null}
          </h4>
          <ol className="flex max-h-80 flex-col gap-2.5 overflow-y-auto rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
            {events.map((ev) => (
              <li key={ev.id} className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{ev.kind.replace(/_/g, ' ')}</span>
                  <span className="dim shrink-0 tabular-nums">{timeAgo(ev.at)}</span>
                </div>
                {ev.detail ? <p className="dim break-words">{ev.detail}</p> : null}
              </li>
            ))}
            {events.length === 0 ? <li className="dim">Nothing yet.</li> : null}
          </ol>
        </section>

        {task.prNumber != null && can('prs:read') ? (
          <CommentsSection
            load={() => codeApi.prComments(task.repo, task.prNumber!)}
            post={can('prs:act') ? (body: string) => codeApi.commentPr(task.repo, task.prNumber!, body) : undefined}
            canComment={can('prs:act')}
          />
        ) : null}

      </div>
      {confirmElement}
    </Drawer>
  );
}

function WorkersModal({
  workspaceId,
  workers,
  repoLabel,
  onClose,
  onError,
}: {
  workspaceId: string;
  workers: WorkerView[];
  repoLabel: (full: string) => string;
  onClose: () => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [role, setRole] = useState<WorkerRole>('developer');
  const { confirmDanger, confirmElement } = useConfirm();

  const act = (fn: () => Promise<unknown>) => (): void => {
    void fn()
      .then(() => onError(null))
      .catch((err) => onError(String(err)));
  };

  return (
    <Modal title="Workers" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="dim text-[13px]">
          A developer builds one task at a time; the reviewer reviews the board's PRs. Disable a worker to stop handing
          it new work.
        </p>
        <ul className="flex flex-col gap-2">
          {workers.map((w) => (
            <li key={w.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <span
                className={`inline-block size-2 shrink-0 rounded-full ${
                  !w.enabled ? 'bg-zinc-300 dark:bg-zinc-600' : w.busy ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{w.name}</div>
                <div className="dim truncate text-xs" title={w.busyTaskRepo ?? undefined}>
                  {w.role}
                  {w.busy
                    ? ` · ${w.busyTaskTitle ?? 'busy'}${w.busyTaskRepo ? ` — ${repoLabel(w.busyTaskRepo)}` : ''}`
                    : w.enabled
                      ? ' · idle'
                      : ' · disabled'}
                </div>
              </div>
              <Switch checked={w.enabled} onChange={(v) => act(() => boardApi.updateWorker(w.id, { enabled: v }))()} label={`Enable ${w.name}`} />
              <IconButton
                label={`Delete ${w.name}`}
                danger
                disabled={w.busy}
                onClick={() => {
                  void confirmDanger({
                    title: 'Delete worker',
                    message: `Delete ${w.name}? Tasks bound to it fail over to other workers.`,
                    confirmLabel: 'Delete',
                  }).then((ok) => {
                    if (ok) act(() => boardApi.deleteWorker(w.id))();
                  });
                }}
              >
                <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="m5.5 5.5 5 5M10.5 5.5l-5 5" strokeLinecap="round" />
                </svg>
              </IconButton>
            </li>
          ))}
          {workers.length === 0 ? <li className="dim text-sm">No workers yet.</li> : null}
        </ul>
        <div className="flex items-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <Field label="Name" className="flex-1">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="dev-1" maxLength={60} />
          </Field>
          <Field label="Role">
            <Dropdown
              ariaLabel="Role"
              value={role}
              onChange={(v) => setRole(v)}
              options={[
                { value: 'developer', label: 'Developer' },
                { value: 'reviewer', label: 'Reviewer' },
              ]}
            />
          </Field>
          <button
            className="btn mb-px"
            disabled={!name.trim()}
            onClick={() => {
              act(() => boardApi.createWorker(workspaceId, name.trim(), role))();
              setName('');
            }}
          >
            Add
          </button>
        </div>
      </div>
      {confirmElement}
    </Modal>
  );
}

/** Draft locally, persist on blur/Enter — typing "10" must not transiently save "1". */
function MaxAttemptsInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const n = Math.min(10, Math.max(1, Math.floor(Number(draft) || value)));
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number"
      className="input w-20"
      min={1}
      max={10}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

function ConfigModal({
  workspaceId,
  config,
  workers,
  onClose,
  onError,
}: {
  workspaceId: string;
  config: BoardConfig;
  workers: WorkerView[];
  onClose: () => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const reviewers = workers.filter((w) => w.role === 'reviewer');
  const save = (fields: Partial<BoardConfig>): void => {
    void boardApi
      .saveConfig(workspaceId, fields)
      .then(() => onError(null))
      .catch((err) => onError(String(err)));
  };

  return (
    <Modal title="Flow" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <SettingRow title="Auto-review" description="The reviewer worker reviews every PR that reaches In review.">
          <Switch checked={config.autoReview} onChange={(v) => save({ autoReview: v })} label="Auto-review" />
        </SettingRow>
        <SettingRow
          title="Reviewer"
          description={reviewers.length === 0 ? 'Add a reviewer-role worker first.' : 'One PR at a time.'}
        >
          <Dropdown
            ariaLabel="Reviewer"
            value={config.reviewerWorkerId}
            onChange={(v) => save({ reviewerWorkerId: v || null })}
            options={[{ value: '', label: 'None' }, ...reviewers.map((w) => ({ value: w.id, label: w.name }))]}
            placeholder="None"
            className="w-44"
          />
        </SettingRow>
        <SettingRow title="Auto-merge" description="Merge once the review approves and checks are green.">
          <Switch checked={config.autoMerge} onChange={(v) => save({ autoMerge: v })} label="Auto-merge" />
        </SettingRow>
        <SettingRow title="Merge method">
          <Dropdown
            ariaLabel="Merge method"
            value={config.mergeMethod}
            onChange={(v) => save({ mergeMethod: v })}
            options={[
              { value: 'squash', label: 'Squash' },
              { value: 'merge', label: 'Merge commit' },
              { value: 'rebase', label: 'Rebase' },
            ]}
            className="w-44"
          />
        </SettingRow>
        <SettingRow title="Auto-fix CI" description="Failing checks send the task back to its worker.">
          <Switch checked={config.autoFixCi} onChange={(v) => save({ autoFixCi: v })} label="Auto-fix CI" />
        </SettingRow>
        <SettingRow title="Attempt ceiling" description="Remediation cycles before a task lands in Failed.">
          <MaxAttemptsInput value={config.maxAttempts} onCommit={(n) => save({ maxAttempts: n })} />
        </SettingRow>
      </div>
    </Modal>
  );
}
