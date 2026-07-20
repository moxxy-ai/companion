import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { useLive } from '@companion/core/client';
import {
  Dropdown,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  IconButton,
  Markdown,
  Modal,
  PageHeader,
  PageLoading,
  SettingRow,
  Switch,
  Tooltip,
  timeAgo,
  useConfirm,
} from '@companion/ui';
import { useWorkspace } from '@companion/module-workspace/client';
import { useWorkspaceRepos } from '@companion/module-code/client';
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
import { boardApi } from '../api.js';
import { useBoard } from '../hooks/useBoard.js';

const COLUMNS: ReadonlyArray<{ key: TaskStatus; label: string }> = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'ready', label: 'Ready' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'in_review', label: 'In review' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
];

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
      return 'awaiting merge';
    default:
      return null;
  }
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
  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    if (attachments.length + files.length > MAX_ATTACHMENTS) {
      onError(`A task can have up to ${MAX_ATTACHMENTS} images`);
      return;
    }
    setReading(true);
    try {
      const added = await Promise.all([...files].map(fileToAttachment));
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
  };
  return (
    <Field label="Screens & references" hint="PNG, JPEG, or WebP. Images are resized before upload and sent to the worker.">
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

export default function Board(): JSX.Element {
  const { tasks, workers, config, loaded, error, setError } = useBoard();
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [managingWorkers, setManagingWorkers] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [dragging, setDragging] = useState<TaskRecord | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);

  const byColumn = useMemo(() => {
    const map = new Map<TaskStatus, TaskRecord[]>(COLUMNS.map((c) => [c.key, []]));
    for (const t of tasks) map.get(t.status)?.push(t);
    return map;
  }, [tasks]);

  const workerName = useCallback(
    (id: string | null) => (id ? (workers.find((w) => w.id === id)?.name ?? 'unknown') : null),
    [workers],
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

  const onDrop = (col: TaskStatus): void => {
    const task = dragging;
    setDragging(null);
    setDropTarget(null);
    if (task && canMove(task, col)) void act(() => boardApi.moveTask(task.id, col));
  };

  if (!loaded) return <PageLoading label="Loading the board…" />;

  const busyCount = workers.filter((w) => w.busy).length;
  const inFlight = tasks.filter((t) => t.status === 'in_progress' || t.status === 'in_review').length;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 py-6">
      <PageHeader
        title="Task Board"
        subtitle={`${inFlight} in flight · ${busyCount}/${workers.filter((w) => w.enabled).length || 0} workers busy`}
        actions={
          <>
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {COLUMNS.map((col) => {
          const cards = byColumn.get(col.key) ?? [];
          const droppable = dragging ? canMove(dragging, col.key) : false;
          return (
            <section
              key={col.key}
              aria-label={col.label}
              className={`flex min-h-[50vh] flex-col rounded-xl border p-2 transition-colors ${
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
                <span className="dim text-xs tabular-nums">{cards.length}</span>
              </header>
              <div className="flex flex-1 flex-col gap-2">
                {cards.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    workerName={workerName(task.assignedWorkerId)}
                    onOpen={() => setDetailId(task.id)}
                    onDragStart={() => setDragging(task)}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {creating ? <NewTaskModal onClose={() => setCreating(false)} onError={setError} /> : null}
      {detailId ? (
        <TaskDetailModal
          id={detailId}
          workerName={workerName}
          onClose={() => setDetailId(null)}
          onError={setError}
        />
      ) : null}
      {managingWorkers ? (
        <WorkersModal workers={workers} onClose={() => setManagingWorkers(false)} onError={setError} />
      ) : null}
      {configuring && config ? (
        <ConfigModal config={config} workers={workers} onClose={() => setConfiguring(false)} onError={setError} />
      ) : null}
    </div>
  );
}

function TaskCard({
  task,
  workerName,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  task: TaskRecord;
  workerName: string | null;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}): JSX.Element {
  const stage = stageLabel(task);
  const active = task.status === 'in_progress' || task.stage === 'reviewing';
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
      className="cursor-pointer rounded-lg border border-zinc-200 bg-white p-2.5 text-left shadow-sm transition-shadow hover:shadow dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-[13px] leading-snug font-medium">{task.title}</h3>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${PRIORITY_CLS[task.priority]}`}>
          P{task.priority}
        </span>
      </div>
      <p className="dim mt-1 truncate font-mono text-[11px]">{task.repo.split('/')[1] ?? task.repo}</p>
      {stage || workerName ? (
        <p className="dim mt-1.5 flex items-center gap-1.5 text-[11px]">
          {active ? <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden /> : null}
          {stage}
          {workerName ? <span className="truncate">· {workerName}</span> : null}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
          <Tooltip content={`${task.attempts} attempt(s) consumed`}>
            <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[10px] tabular-nums">↻ {task.attempts}</span>
          </Tooltip>
        ) : null}
        {task.attachments.length > 0 ? <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400">{task.attachments.length} image{task.attachments.length === 1 ? '' : 's'}</span> : null}
        {task.specId ? <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-500">spec</span> : null}
      </div>
      {task.lastError ? <p className="mt-1.5 line-clamp-2 text-[11px] text-red-600 dark:text-red-400">{task.lastError}</p> : null}
    </article>
  );
}

function NewTaskModal({ onClose, onError }: { onClose: () => void; onError: (e: string | null) => void }): JSX.Element {
  const { current } = useWorkspace();
  const repos = useWorkspaceRepos(current?.id);
  const [repo, setRepo] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [attachments, setAttachments] = useState<TaskAttachmentInput[]>([]);
  const [specs, setSpecs] = useState<SpecOption[]>([]);
  const [specId, setSpecId] = useState<string | null>(null);
  const [queue, setQueue] = useState(true);
  const [busy, setBusy] = useState(false);

  const effectiveRepo = repo ?? repos[0]?.fullName ?? null;

  useEffect(() => {
    setSpecs([]);
    setSpecId(null);
    if (!effectiveRepo) return;
    let cancelled = false;
    void boardApi
      .specs(effectiveRepo)
      .then((r) => {
        if (!cancelled) setSpecs(r.specs);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [effectiveRepo]);

  const submit = async (): Promise<void> => {
    if (!effectiveRepo || !title.trim()) return;
    setBusy(true);
    try {
      await boardApi.createTask({ repo: effectiveRepo, title: title.trim(), description, specId, attachments, priority, queue });
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
            options={repos.map((r) => ({ value: r.fullName, label: r.fullName }))}
            searchable
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
        <Field label="Description" hint="What the worker needs to know: scope, constraints, acceptance criteria.">
          <textarea
            className="input min-h-28"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={20_000}
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

function TaskDetailModal({
  id,
  workerName,
  onClose,
  onError,
}: {
  id: string;
  workerName: (id: string | null) => string | null;
  onClose: () => void;
  onError: (e: string | null) => void;
}): JSX.Element | null {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [events, setEvents] = useState<TaskEventRecord[]>([]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [attachments, setAttachments] = useState<TaskAttachmentInput[]>([]);
  const { confirmDanger, confirmElement } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const detail = await boardApi.task(id);
      setTask(detail.task);
      setEvents(detail.events);
    } catch {
      onClose(); // deleted under us
    }
  }, [id, onClose]);

  useLive(refresh, (msg) => msg.t === 'board.changed');

  if (!task) return null;

  const act = (fn: () => Promise<unknown>) => (): void => {
    void fn()
      .then(() => {
        onError(null);
        return refresh();
      })
      .catch((err) => onError(String(err)));
  };

  const saveEdit = act(async () => {
    await boardApi.updateTask(id, { title: title.trim() || task.title, description, priority, attachments });
    setEditing(false);
  });

  return (
    <Modal title={task.title} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="dim flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-mono">{task.repo}</span>
          <span>
            {task.status.replace('_', ' ')}
            {stageLabel(task) ? ` · ${stageLabel(task)}` : ''}
          </span>
          <span className={`rounded-full px-1.5 py-0.5 font-semibold ${PRIORITY_CLS[task.priority]}`}>P{task.priority}</span>
          {workerName(task.assignedWorkerId) ? <span>worker: {workerName(task.assignedWorkerId)}</span> : null}
          {task.attempts > 0 ? <span>attempts: {task.attempts}</span> : null}
          {task.branch ? <span className="font-mono">{task.branch}</span> : null}
          {task.prUrl ? (
            <a className="font-medium hover:underline" href={task.prUrl} target="_blank" rel="noreferrer">
              PR #{task.prNumber}
            </a>
          ) : null}
          {task.runId ? (
            <a className="font-medium hover:underline" href={`#/runs/${task.runId}`} onClick={onClose}>
              live run
            </a>
          ) : null}
        </div>

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
            <Field label="Priority">
              <Dropdown
                ariaLabel="Priority"
                value={String(priority) as '0' | '1' | '2' | '3'}
                onChange={(value) => setPriority(Number(value) as TaskPriority)}
                options={PRIORITY_OPTIONS}
              />
            </Field>
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
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              {task.description ? <Markdown text={task.description} /> : <p className="dim">No description.</p>}
            </div>
            <AttachmentGallery attachments={task.attachments} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {canMove(task, 'ready') ? (
            <button className="btn" onClick={act(() => boardApi.moveTask(id, 'ready'))}>
              {task.status === 'failed' ? 'Retry' : 'Queue'}
            </button>
          ) : null}
          {canMove(task, 'backlog') ? (
            <button className="btn-ghost" onClick={act(() => boardApi.moveTask(id, 'backlog'))}>
              {task.status === 'in_progress' ? 'Cancel & park' : 'Park'}
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
                setPriority(task.priority);
                setAttachments(task.attachments.flatMap(({ name, mediaType, content }) => content ? [{ name, mediaType, content }] : []));
                setEditing(true);
              }}
            >
              Edit
            </button>
          ) : null}
          <span className="flex-1" />
          <button
            className="btn-danger-ghost"
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
            Delete
          </button>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide uppercase">Timeline</h3>
          <ol className="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs">
            {events.map((ev) => (
              <li key={ev.id} className="flex gap-2">
                <span className="dim w-20 shrink-0 tabular-nums">{timeAgo(ev.at)}</span>
                <span className="shrink-0 font-medium">{ev.kind.replace(/_/g, ' ')}</span>
                <span className="dim min-w-0 break-words">{ev.detail}</span>
              </li>
            ))}
            {events.length === 0 ? <li className="dim">Nothing yet.</li> : null}
          </ol>
        </div>
      </div>
      {confirmElement}
    </Modal>
  );
}

function WorkersModal({
  workers,
  onClose,
  onError,
}: {
  workers: WorkerView[];
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
                <div className="dim truncate text-xs">
                  {w.role}
                  {w.busy ? ` · ${w.busyTaskTitle ?? 'busy'}` : w.enabled ? ' · idle' : ' · disabled'}
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
              act(() => boardApi.createWorker(name.trim(), role))();
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
  config,
  workers,
  onClose,
  onError,
}: {
  config: BoardConfig;
  workers: WorkerView[];
  onClose: () => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const reviewers = workers.filter((w) => w.role === 'reviewer');
  const save = (fields: Partial<BoardConfig>): void => {
    void boardApi
      .saveConfig(fields)
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
