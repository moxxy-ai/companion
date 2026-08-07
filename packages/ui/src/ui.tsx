import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, CloseIcon, SparkleIcon } from './icons.js';

/** Small shared primitives so every page speaks the same visual language. */

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading glyph (e.g. a lock for private workspaces). */
  icon?: ReactNode;
  /** Dim secondary text, right-aligned in the menu (e.g. a count). */
  hint?: string;
  /** Visible but not selectable — use the hint to say why. */
  disabled?: boolean;
}

/**
 * Custom single-select listbox: a trigger button + popover menu, replacing
 * native `<select>` where we want full control over the menu's look.
 * The menu is portaled and viewport-clamped (like AnchoredMenu) so an
 * overflow ancestor — a Modal, especially — never clips it; it flips above
 * the trigger when there's no room below, and is never narrower than the
 * trigger (but may grow, so short triggers don't truncate their options).
 * Keyboard: arrows move, Enter/Space select, Escape closes and refocuses.
 */
export function Dropdown<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = 'Select…',
  className = '',
  triggerClassName,
  renderTrigger,
  searchable,
  action,
  disabled = false,
  maxVisible,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: ReadonlyArray<DropdownOption<T>>;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  /** Replaces the default input-like trigger styling. */
  triggerClassName?: string;
  /** Replaces the default trigger content (label + chevron). */
  renderTrigger?: (selected: DropdownOption<T> | null, open: boolean) => ReactNode;
  /** Adds a filter input at the top of the menu. */
  searchable?: boolean;
  /** Pinned action row at the bottom of the menu (e.g. "New workspace"). */
  action?: { label: string; onSelect: () => void; icon?: ReactNode };
  disabled?: boolean;
  /** Cap rendered options; searchable lists disclose how many remain. */
  maxVisible?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;

  const q = query.trim().toLowerCase();
  const matching = q ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q)) : options;
  const visible = maxVisible ? matching.slice(0, maxVisible) : matching;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Place the portaled menu against the trigger; re-measured when filtering
  // changes its height. Layout effect so the first paint is already placed.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = (): void => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const r = trigger.getBoundingClientRect();
      // Width before measuring — it decides the wrapped height.
      menu.style.minWidth = `${r.width}px`;
      menu.style.maxWidth = `${Math.min(Math.max(r.width, 320), window.innerWidth - 16)}px`;
      const mh = menu.offsetHeight;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
      const flipUp = r.bottom + 6 + mh > window.innerHeight - 8 && r.top - mh - 6 >= 8;
      setPos({ top: flipUp ? r.top - mh - 6 : r.bottom + 6, left });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, visible.length]);

  // Dismiss on an outside press or outside scroll (the list scrolls internally).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent): void => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onScroll, true);
    // Defer so the opening click doesn't immediately close it.
    const id = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // Focus the search field (if any) or the selected option when the menu opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    if (searchable) {
      searchRef.current?.focus();
      return;
    }
    const list = listRef.current;
    const target =
      list?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      list?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)');
    target?.focus();
  }, [open, searchable]);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  };

  return (
    <div
      className={`relative ${className}`}
      onBlur={(e) => {
        // The menu lives in a portal, so DOM containment must check both trees.
        // A null relatedTarget means focus went nowhere — Safari does that on
        // every press inside the menu, and closing there eats the option click.
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next) && !menuRef.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={
          triggerClassName ??
          // h-9 is the platform's control height — .btn, .btn-ghost and .input
          // all sit on it, so a dropdown never breaks the line it shares.
          'flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-white px-3.5 text-left text-[13px] font-medium transition-colors hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-500'
        }
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {renderTrigger ? (
          renderTrigger(selected, open)
        ) : (
          <>
            {selected ? (
              <span className="truncate">{selected.label}</span>
            ) : (
              <span className="truncate font-normal text-zinc-400 dark:text-zinc-500">{placeholder}</span>
            )}
            <ChevronDown open={open} />
          </>
        )}
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              data-dropdown-menu
              style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? undefined : 'hidden' }}
              className="z-[60] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
            >
              {searchable ? (
                <input
                  ref={searchRef}
                  type="search"
                  className="w-full border-b border-zinc-200 bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-zinc-400 dark:border-zinc-800"
                  placeholder="Search…"
                  aria-label={`Filter ${ariaLabel}`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      listRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      const first = visible.find((o) => !o.disabled);
                      if (first) {
                        onChange(first.value);
                        close(true);
                      }
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      close(true);
                    }
                  }}
                />
              ) : null}
              <ul
                ref={listRef}
                role="listbox"
                aria-label={ariaLabel}
                className="max-h-72 overflow-y-auto p-1"
                onKeyDown={onListKeyDown}
              >
              {visible.map((o) => {
                const isSelected = o.value === value;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={o.disabled}
                      className="flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-zinc-100 focus:bg-zinc-100 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-zinc-800 dark:focus:bg-zinc-800 dark:disabled:hover:bg-transparent"
                      onClick={() => {
                        onChange(o.value);
                        close(true);
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {o.icon ? <span className="dim shrink-0">{o.icon}</span> : null}
                        <span className="min-w-0">
                          <span className={`block truncate ${isSelected ? 'font-medium' : ''}`}>{o.label}</span>
                          {o.hint ? <span className="dim block truncate text-[11px]">{o.hint}</span> : null}
                        </span>
                      </span>
                      {isSelected ? (
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden
                          className="size-4 shrink-0 text-accent-600 dark:text-accent-400"
                        >
                          <path
                            d="M3.5 8.5l3 3 6-7"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </button>
                  </li>
                );
              })}
                {visible.length === 0 ? <li className="dim px-2.5 py-2">{q ? 'No matches' : 'No options'}</li> : null}
                {matching.length > visible.length ? (
                  <li className="dim px-2.5 py-2 text-[11px]">
                    {matching.length - visible.length} more — keep typing to narrow the list
                  </li>
                ) : null}
              </ul>
              {action ? (
                <div className="border-t border-zinc-200 p-1 dark:border-zinc-800">
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium outline-none hover:bg-zinc-100 focus:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
                    onClick={() => {
                      close(false);
                      action.onSelect();
                    }}
                  >
                    {action.icon ?? <span aria-hidden>＋</span>} {action.label}
                  </button>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Standard page container — every page shares the same content width. */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`mx-auto w-full max-w-5xl px-6 py-6 ${className}`}>{children}</div>;
}

/** Titled page section (heading + optional description above the content). */
export function Section({
  title,
  description,
  children,
  className = '',
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={`mt-8 ${className}`} aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {description ? <p className="dim mb-3 text-[13px]">{description}</p> : null}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle ? <div className="dim mt-0.5">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Signed change vs a named period; color = direction × whether up is good. */
export interface StatDelta {
  readonly current: number;
  readonly previous: number;
  /** Named comparison period, e.g. "vs last week". */
  readonly period: string;
  /** Colors the marker: green when upward movement is desirable. Default true. */
  readonly upIsGood?: boolean;
}

/** Compact pill: direction + amount; the named period lives in the tooltip. */
function DeltaChip({ delta }: { delta: StatDelta }): JSX.Element {
  const diff = delta.current - delta.previous;
  // Percent only against a real base; from zero the absolute count is honest.
  const pct = delta.previous > 0 ? Math.round((diff / delta.previous) * 100) : null;
  const amount = diff === 0 ? '±0' : `${diff > 0 ? '+' : ''}${pct !== null ? `${pct}%` : diff}`;
  const cls =
    diff === 0
      ? 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400'
      : (delta.upIsGood ?? true) === diff > 0
        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        : 'bg-red-500/10 text-red-600 dark:text-red-400';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${cls}`}
      title={`${amount} ${delta.period}`}
    >
      <span aria-hidden>{diff > 0 ? '▲' : diff < 0 ? '▼' : '→'}</span>
      {amount}
      <span className="sr-only"> {delta.period}</span>
    </span>
  );
}

/**
 * The tile's foot: a full-bleed trend strip below the content — the line and
 * fill never sit behind text. Decorative; the delta pill carries the reading.
 */
function TrendStrip({ points }: { points: ReadonlyArray<number> }): JSX.Element | null {
  if (points.length < 2) return null;
  const w = 100;
  const h = 28;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const flat = max === min;
  const x = (i: number): number => (i / (points.length - 1)) * w;
  const y = (v: number): number => (flat ? h * 0.6 : 4 + (1 - (v - min) / (max - min)) * (h - 8));
  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="pointer-events-none block h-7 w-full" aria-hidden>
      <path d={area} className="fill-zinc-200/25 dark:fill-zinc-700/20" />
      <path
        d={line}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-zinc-300 dark:stroke-zinc-600"
      />
    </svg>
  );
}

export function StatTile({
  label,
  value,
  hint,
  href,
  tone = 'default',
  delta,
  trend,
  loading = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
  delta?: StatDelta;
  trend?: ReadonlyArray<number>;
  /** The tile's own feed hasn't landed yet: label renders, value is a skeleton. */
  loading?: boolean;
}): JSX.Element {
  const toneClass =
    tone === 'danger'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'ok'
          ? 'text-emerald-600 dark:text-emerald-400'
          : '';
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="dim min-w-0 truncate text-xs" title={label}>
          {label}
        </div>
        {!loading && delta ? <DeltaChip delta={delta} /> : null}
      </div>
      {loading ? (
        <Skeleton className="mt-1.5 h-[30px] w-12" />
      ) : (
        <div className={`mt-1.5 text-3xl leading-none font-semibold ${toneClass}`}>{value}</div>
      )}
      {hint ? (
        // Secondary detail stays off the tile face; it fades in on hover/focus.
        <div
          className="dim mt-1.5 truncate opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 group-focus-within/tile:opacity-100"
          title={hint}
        >
          {hint}
        </div>
      ) : null}
      {/* mt-auto pins the strip to the tile's foot so a row of tiles aligns. */}
      {trend ? (
        <div className="-mx-4 -mb-4 mt-auto pt-3">
          <TrendStrip points={trend} />
        </div>
      ) : null}
    </>
  );
  return href ? (
    <a
      href={href}
      className="group/tile card flex flex-col overflow-hidden transition-colors hover:border-accent-400 dark:hover:border-accent-500"
    >
      {body}
    </a>
  ) : (
    <div className="group/tile card flex flex-col overflow-hidden">{body}</div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="card my-4 flex flex-col items-center gap-1.5 py-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint ? <div className="dim max-w-md">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  xl,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Detail-heavy dialogs (side rails, review histories); supersedes `wide`. */
  xl?: boolean;
}): JSX.Element {
  // Portaled to <body>: a transformed ancestor (e.g. the animated sidebar)
  // would otherwise become the containing block and trap the overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className={`anim-in my-6 w-full ${xl ? 'max-w-5xl' : wide ? 'max-w-3xl' : 'max-w-lg'} overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          <IconButton label={`Close ${title}`} onClick={onClose} className="-mr-1.5">
            <CloseIcon />
          </IconButton>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Right-side detail drawer: portaled, full-height, resizable by dragging its
 * left edge (or arrow keys on the handle); the chosen width persists under
 * `storageKey`. Non-modal by design — the page behind stays interactive so a
 * list can swap the drawer's subject; Escape (when no modal is stacked above,
 * e.g. a confirm dialog) or the ✕ closes. The body is a container-query
 * context (`@container`), so children adapt to the drawer's width, not the
 * viewport's.
 */
export function Drawer({
  title,
  onClose,
  children,
  storageKey = 'companion.drawer.width',
  defaultWidth = 720,
  minWidth = 480,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** localStorage key the resized width persists under. */
  storageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
}): JSX.Element {
  const [width, setWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored >= minWidth ? stored : defaultWidth;
  });
  const widthRef = useRef(width);
  widthRef.current = width;

  // Cap so the app shell (sidebar + a sliver of page) always stays visible.
  const clampWidth = (w: number): number => Math.min(Math.max(w, minWidth), Math.max(minWidth, window.innerWidth - 300));
  const persist = (w: number): void => window.localStorage.setItem(storageKey, String(Math.round(w)));

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startDrag = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent): void => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      persist(widthRef.current);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  };

  return createPortal(
    <aside
      role="dialog"
      aria-label={title}
      className="fixed inset-y-0 right-0 z-30 flex"
      style={{ width: `min(${width}px, 100vw)` }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title}`}
        tabIndex={0}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize outline-none transition-colors hover:bg-accent-500/50 focus-visible:bg-accent-500/50"
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const next = clampWidth(widthRef.current + (e.key === 'ArrowLeft' ? 32 : -32));
            setWidth(next);
            persist(next);
          }
        }}
      />
      <div className="anim-in flex min-w-0 flex-1 flex-col border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          <IconButton label={`Close ${title}`} onClick={onClose} className="-mr-1.5">
            <CloseIcon />
          </IconButton>
        </div>
        <div className="@container min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </aside>,
    document.body,
  );
}

interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly resolve: (confirmed: boolean) => void;
}

/**
 * Promise-based destructive-action confirmation: `await confirmDanger({...})`
 * opens a danger-styled modal and resolves with the user's choice. Render
 * `confirmElement` once in the component.
 */
export function useConfirm(): {
  confirmDanger: (opts: { title: string; message: string; confirmLabel?: string }) => Promise<boolean>;
  confirmElement: ReactNode;
} {
  const [pending, setPending] = useState<ConfirmRequest | null>(null);

  const confirmDanger = useCallback(
    (opts: { title: string; message: string; confirmLabel?: string }) =>
      new Promise<boolean>((resolve) => {
        setPending({ title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel ?? 'Delete', resolve });
      }),
    [],
  );

  const close = (confirmed: boolean): void => {
    pending?.resolve(confirmed);
    setPending(null);
  };

  const confirmElement = pending ? (
    <Modal title={pending.title} onClose={() => close(false)}>
      <div className="flex items-start gap-2.5 rounded-lg border border-red-500/50 bg-red-500/5 px-3.5 py-2.5 text-[13px]">
        <span className="text-red-600 dark:text-red-400" aria-hidden>
          ⚠
        </span>
        <span>This action is destructive and cannot be undone.</span>
      </div>
      <p className="mt-3 text-sm">{pending.message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={() => close(false)} autoFocus>
          Cancel
        </button>
        <button className="btn-danger" onClick={() => close(true)}>
          {pending.confirmLabel}
        </button>
      </div>
    </Modal>
  ) : null;

  return { confirmDanger, confirmElement };
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
}): JSX.Element {
  return (
    <div role="tablist" className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
      {options.map((o) => (
        <button
          key={o.value}
          // Tabs render inside forms (skills editor) — a bare button would
          // default to type="submit" and save/close on tab switch.
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={`rounded-md px-3 py-1 text-[13px] transition-colors ${
            value === o.value
              ? 'bg-white font-medium shadow-sm dark:bg-zinc-700'
              : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
          }`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined ? <span className="dim ml-1.5 tabular-nums">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Spinner(): JSX.Element {
  return (
    <span
      className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-middle opacity-70 motion-reduce:animate-none"
      role="status"
      aria-label="Loading"
    />
  );
}

/** Shimmering placeholder line for content that is still loading. */
export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <span className={`skeleton ${className}`} aria-hidden />;
}

/** N placeholder rows for a list still waiting on its feed (drop inside ListCard). */
export function RowsSkeleton({ rows = 4 }: { rows?: number }): JSX.Element {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-4 py-3">
          <Skeleton className="size-2 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-2/5" />
          </span>
          <Skeleton className="h-3 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * A row's place in the entrance cascade, as the custom property `.row-in` reads.
 *
 * Capped, because the stagger exists to make arrival legible, not to make the
 * hundredth row wait two seconds for its turn.
 */
export function rowDelay(index: number, cap = 12): Record<string, string> {
  return { '--row-index': String(Math.min(index, cap)) };
}

// A pleasant deterministic bar series for chart placeholders.
const CHART_SKELETON_BARS = [35, 60, 45, 80, 55, 70, 40, 65, 50, 75, 45, 60];

/** Placeholder for a chart card still waiting on its feed. */
export function ChartSkeleton({ title }: { title: string }): JSX.Element {
  return (
    <figure className="card" aria-hidden>
      <figcaption className="dim text-[13px] font-medium">{title}</figcaption>
      <div className="mt-3 flex h-28 items-end gap-1.5">
        {CHART_SKELETON_BARS.map((h, i) => (
          <span key={i} className="skeleton flex-1 rounded-sm" style={{ height: `${h}%` }} />
        ))}
      </div>
    </figure>
  );
}

/** Spinner + label for inline loading moments (list refresh, side panels). */
export function InlineLoading({ label = 'Loading…', className = '' }: { label?: string; className?: string }): JSX.Element {
  return (
    <div className={`dim flex items-center gap-2.5 text-sm ${className}`}>
      <Spinner /> {label}
    </div>
  );
}

/**
 * How long a page may take before it is worth SAYING it is loading.
 *
 * The daemon is local, so most navigations answer well inside this and the
 * skeleton would appear and vanish in the same breath — a flash that reads as a
 * glitch rather than as progress. Waiting costs nothing on a fast load and
 * shows the same thing as before on a slow one.
 */
const LOADING_GRACE_MS = 250;

/**
 * `flag`, but only once it has been true for long enough to be worth showing.
 * Falls back to false the moment it clears, so a fast answer never flashes.
 */
export function useSettledFlag(flag: boolean, delayMs = LOADING_GRACE_MS): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!flag) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), delayMs);
    return () => clearTimeout(timer);
  }, [flag, delayMs]);
  return settled;
}

export function PageLoading({ label = 'Loading…' }: { label?: string }): JSX.Element | null {
  const show = useSettledFlag(true);
  if (!show) return null;
  return (
    <div className="anim-in mx-auto w-full max-w-5xl px-6 py-6">
      <InlineLoading label={label} />
      <div className="mt-5 flex flex-col gap-3">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

/** Accessible toggle switch (monochrome: filled track when on). */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  reason,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  /** Why it cannot be toggled. Shown on hover and to a screen reader, because a
   *  control that is off with no explanation reads as a bug. */
  reason?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={reason ? `${label} (${reason})` : label}
      title={reason}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-50 ${
        checked ? 'bg-zinc-900 dark:bg-zinc-100' : 'bg-zinc-300 dark:bg-zinc-700'
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`inline-block size-4 transform rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
          checked ? 'translate-x-[18px] dark:bg-zinc-900' : 'translate-x-0.5'
        }`}
        aria-hidden
      />
    </button>
  );
}

/** Click-to-copy inline text: copies `value` (or the visible text) and flashes confirmation. */
export function CopyText({
  value,
  children,
  className = '',
  title,
  ariaLabel,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-left font-[inherit] text-inherit hover:opacity-80 ${className}`}
      title={copied ? 'Copied!' : (title ?? `Copy "${value}"`)}
      aria-label={ariaLabel ?? `Copy ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {children}
      <span
        className={`text-[10px] transition-opacity ${copied ? 'text-emerald-600 opacity-100 dark:text-emerald-400' : 'dim opacity-0'}`}
        aria-hidden
      >
        {copied ? '✓ copied' : ''}
      </span>
    </button>
  );
}

/**
 * Styled hover tooltip (replaces native `title` on custom hover elements).
 * Shows above the anchor on hover/focus; content can be any node.
 */
export function Tooltip({
  content,
  children,
  className = '',
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  side?: 'top' | 'bottom';
}): JSX.Element {
  const position = side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5';
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none invisible absolute left-1/2 z-40 w-max max-w-72 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs leading-snug text-zinc-700 opacity-0 shadow-md transition-opacity delay-150 group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 ${position}`}
      >
        {content}
      </span>
    </span>
  );
}

/**
 * "Filters" popover for list pages: sits right of the tabs, shows how many
 * filters are active, and hosts custom Dropdowns for each dimension.
 */
export function FiltersPopover({
  active,
  onClear,
  children,
}: {
  active: number;
  onClear: () => void;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The panel hosts Dropdowns that portal their menu to <body>, so picking an
  // option is a press *outside* this subtree. Dismiss on an outside press
  // instead of on blur: blur fires with a null relatedTarget on every press
  // inside such a menu, and unmounting there would eat the option's click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent): void => {
      const t = e.target as Element | null;
      if (rootRef.current?.contains(t) || t?.closest('[data-dropdown-menu]')) return;
      setOpen(false);
    };
    const id = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        const next = e.relatedTarget as Element | null;
        if (next && !e.currentTarget.contains(next) && !next.closest('[data-dropdown-menu]')) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <Tooltip content={active > 0 ? `Filters — ${active} active` : 'Filters'}>
        <button
          type="button"
          className="btn-ghost relative justify-center gap-1.5 px-2.5"
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={active > 0 ? `Filters (${active} active)` : 'Filters'}
          onClick={() => setOpen((o) => !o)}
        >
          {/* funnel */}
          <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
            <path
              d="M2.5 3h11l-4.2 5v4.2l-2.6 1.3V8L2.5 3z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          <span className="hidden sm:inline">Filters</span>
          <CountBadge count={active} />
        </button>
      </Tooltip>
      {open ? (
        <div className="absolute top-full right-0 z-30 mt-1.5 w-72 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex flex-col gap-2.5">{children}</div>
          <div className="mt-3 flex justify-end border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
            <button className="linkish text-xs" disabled={active === 0} onClick={onClear}>
              Clear filters
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Labeled row inside a FiltersPopover. */
export function FilterField({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="dim">{label}</span>
      {children}
    </label>
  );
}

export interface MenuAction {
  label: string;
  onSelect?: () => void;
  /** Drawn before the label at menu-icon size; for marks that identify a target. */
  icon?: ReactNode;
  /** Renders as a link (external ones get ↗ and a new tab). */
  href?: string;
  external?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

const MENU_ITEM_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-zinc-100 focus:bg-zinc-100 disabled:cursor-default disabled:opacity-50 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800';

/**
 * Sizes whatever a caller hands over, so a mark drawn for a 40px tile fits a
 * menu row. Rendered for every item once ANY item has one: a gutter on some
 * rows and not others reads as one label being wrong, not as a missing icon.
 */
function MenuItemIcon({ icon }: { icon?: ReactNode }): JSX.Element {
  return <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">{icon}</span>;
}

/** Shared item list for ActionMenu and ContextMenu. */
function MenuItems({ actions, onClose }: { actions: MenuAction[]; onClose: () => void }): JSX.Element {
  const marks = actions.some((a) => a.icon);
  return (
    <>
      {actions.map((a) =>
        a.href ? (
          <a
            key={a.label}
            role="menuitem"
            className={MENU_ITEM_CLASS}
            href={a.href}
            target={a.external ? '_blank' : undefined}
            rel={a.external ? 'noreferrer' : undefined}
            onClick={onClose}
          >
            {marks ? <MenuItemIcon icon={a.icon} /> : null}
            {a.label}
            {a.external ? <span aria-hidden>↗</span> : null}
          </a>
        ) : (
          <button
            key={a.label}
            type="button"
            role="menuitem"
            disabled={a.disabled}
            className={`${MENU_ITEM_CLASS} ${a.danger ? 'text-red-600 dark:text-red-400' : ''}`}
            onClick={() => {
              onClose();
              a.onSelect?.();
            }}
          >
            {marks ? <MenuItemIcon icon={a.icon} /> : null}
            {a.label}
          </button>
        ),
      )}
    </>
  );
}

/** State for a cursor-positioned ContextMenu; owners keep it in useState. */
export interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly actions: MenuAction[];
}

/**
 * Cursor-positioned menu for list-row right-clicks (a hover ⋯ trigger can
 * open it too, anchored to the button). Controlled: the owner holds
 * {x, y, actions} and clears it on close.
 */
export function ContextMenu({ menu, onClose }: { menu: ContextMenuState | null; onClose: () => void }): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (): void => onClose();
    // Clicks and scrolls INSIDE the menu are the user working it: picking an
    // item already closes on its own, and filtering a long list must survive
    // both. Anything outside still dismisses.
    const outside = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    // ui.tsx imports React's KeyboardEvent type; this is the DOM one.
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', outside);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', outside);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', close);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  const width = 224; // matches w-56
  const EDGE = 8;
  const estH = menu.actions.length * 34 + 10;
  // A menu that fits still shifts up to stay on screen, as it always did. One
  // that cannot fit at all (an action per pipeline) takes the viewport and
  // scrolls, instead of running off the bottom with its tail unreachable.
  const maxHeight = window.innerHeight - EDGE * 2;
  const height = Math.min(estH, maxHeight);
  const left = Math.max(EDGE, Math.min(menu.x, window.innerWidth - width - EDGE));
  const top = Math.max(EDGE, Math.min(menu.y, window.innerHeight - height - EDGE));
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 w-56 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      style={{ left, top, maxHeight }}
    >
      <MenuItems actions={menu.actions} onClose={onClose} />
    </div>,
    document.body,
  );
}

/**
 * A dropdown anchored to a trigger element, rendered in a portal and clamped to
 * the viewport — so it never clips under an overflow ancestor or sits behind the
 * sidebar (unlike an absolutely-positioned menu). Flips above the trigger when
 * there's no room below.
 */
function AnchoredMenu({
  anchorRef,
  open,
  onClose,
  actions,
  width = 208,
  label,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  actions: MenuAction[];
  width?: number;
  label?: string;
}): JSX.Element | null {
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = (): void => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const GAP = 6;
      const EDGE = 8;
      const estH = actions.length * 36 + 12;
      // A menu is only as long as the caller's list, and some of those lists are
      // user-defined (one item per pipeline). Cap it to the space on whichever
      // side has more and let it scroll, or the tail of a long menu renders past
      // the viewport with no way to reach it.
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const up = estH > below && above > below;
      const maxHeight = Math.max(120, up ? above : below);
      const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE));
      const top = up ? Math.max(EDGE, r.top - GAP - Math.min(estH, maxHeight)) : r.bottom + GAP;
      setPos({ top, left, maxHeight });
    };
    place();
    const onDown = (e: globalThis.MouseEvent): void => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    // The page scrolling out from under the menu closes it; the menu scrolling
    // its own overflow must not, and capture-phase listeners see both.
    const onScroll = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    // Defer so the opening click doesn't immediately close it.
    const id = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, actions.length, width, onClose, anchorRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width, maxHeight: pos.maxHeight }}
      className="z-[60] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
    >
      <MenuItems actions={actions} onClose={onClose} />
    </div>,
    document.body,
  );
}

/** Labeled "Actions" overflow menu for secondary actions. */
export function ActionMenu({
  actions,
  label = 'Actions',
  trigger = 'Actions',
}: {
  actions: MenuAction[];
  /** Accessible name. Callers pass a descriptive phrase, so it is NOT the visible text. */
  label?: string;
  /** Visible button text. Separate from `label` precisely because the two differ. */
  trigger?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn-ghost gap-1.5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
        <ChevronDown open={open} className="size-3.5" />
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} actions={actions} label={label} />
    </>
  );
}

/**
 * ✦ AI menu: every agent action in a toolbar behind one sparkle trigger —
 * the emerald accent marks it as AI, same as the AI Help header button.
 */
export function AiActionMenu({
  actions,
  busy = false,
  label = 'AI actions',
}: {
  actions: MenuAction[];
  /** An action is in flight — the sparkle becomes a spinner. */
  busy?: boolean;
  label?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors ${aiAccentClass(open)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? <Spinner /> : <SparkleIcon />}
        AI
        <ChevronDown open={open} className="size-3.5" />
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} actions={actions} width={224} label={label} />
    </>
  );
}

/**
 * A subtle inline marker (colored dot + label) for a row's meta line, e.g. an
 * in-progress agent action or a review/risk signal. Sits in the dim metadata
 * strip rather than crowding the title.
 */
/** The status vocabulary: one tone → color map shared by every dot, signal, and glyph. */
export type StatusTone = 'blue' | 'amber' | 'red' | 'green' | 'zinc';

const TONE_TEXT: Record<StatusTone, string> = {
  blue: 'text-[#2a78d6] dark:text-[#5aa2f0]',
  amber: 'text-amber-600 dark:text-amber-400',
  red: 'text-red-600 dark:text-red-400',
  green: 'text-emerald-600 dark:text-emerald-400',
  zinc: 'text-zinc-500 dark:text-zinc-400',
};

const TONE_DOT: Record<StatusTone, string> = {
  blue: 'bg-[#2a78d6] dark:bg-[#5aa2f0]',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  green: 'bg-emerald-500',
  zinc: 'bg-zinc-400 dark:bg-zinc-500',
};

/** Colored status dot; `pulse` marks live activity. */
export function StatusDot({
  tone,
  pulse,
  size = 'md',
  title,
  label,
  className = '',
}: {
  tone: StatusTone;
  pulse?: boolean;
  /** sm = meta-line marker, md = list row, lg = prominent health dot. */
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  /** Screen-reader text without a native tooltip — for dots already wrapped in Tooltip. */
  label?: string;
  className?: string;
}): JSX.Element {
  const sizeClass = size === 'sm' ? 'size-1.5' : size === 'lg' ? 'size-2.5' : 'size-2';
  const name = title ?? label;
  return (
    <span
      className={`${sizeClass} shrink-0 rounded-full ${TONE_DOT[tone]} ${
        pulse ? 'animate-pulse motion-reduce:animate-none' : ''
      } ${className}`}
      title={title}
      aria-hidden={name === undefined}
      role={name === undefined ? undefined : 'img'}
      aria-label={name}
    />
  );
}

export function MetaSignal({
  tone,
  label,
  pulse,
  title,
}: {
  tone: StatusTone;
  label: string;
  pulse?: boolean;
  title?: string;
}): JSX.Element {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${TONE_TEXT[tone]}`} title={title}>
      <StatusDot tone={tone} pulse={pulse} size="sm" />
      {label}
    </span>
  );
}

/** In-progress / queued agent action marker for a row's meta line. */
export function AiActivityChip({ activity }: { activity: 'running' | 'queued' }): JSX.Element {
  return activity === 'running' ? (
    <MetaSignal tone="blue" label="AI running" pulse title="An agent is working on this" />
  ) : (
    <MetaSignal tone="zinc" label="AI queued" title="Waiting for a runner slot" />
  );
}

/** One `label: value` cell in a detail view's metadata strip. */
export function MetaItem({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5 text-[13px]">
      <span className="dim">{label}</span>
      <span>{children}</span>
    </span>
  );
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString();
}

/** Abbreviated token counts for run lists and detail headers (1.2M / 34.5k). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Emerald AI-accent surface (border/bg/text states) — the single visual token
 * marking an AI trigger. Callers add their own shape (size, radius, padding).
 */
export function aiAccentClass(open: boolean): string {
  return open
    ? 'border-emerald-500/70 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
    : 'border-emerald-500/40 text-emerald-600 hover:border-emerald-500/70 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/10';
}

/**
 * Quiet square icon-only button: transparent until hovered. The one shape for
 * modal closes, row kebabs, toolbar glyphs. `title` mirrors the aria-label so
 * every icon button self-documents on hover.
 */
export function IconButton({
  label,
  onClick,
  danger,
  disabled,
  className = '',
  children,
}: {
  label: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`dim shrink-0 cursor-pointer rounded-md p-1.5 transition-colors disabled:cursor-default disabled:opacity-50 ${
        danger
          ? 'hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400'
          : 'hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
      } ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Glyphs for StatusGlyph: outcome shapes shared by every domain state icon. */
export type GlyphTone = 'ok' | 'warn' | 'danger' | 'muted';

const GLYPH: Record<GlyphTone, { cls: string; path: string }> = {
  ok: { cls: 'text-emerald-600 dark:text-emerald-400', path: 'M4.6 8.4l2 2 4-4.4' },
  warn: { cls: 'text-amber-600 dark:text-amber-400', path: 'M8 4.6v4M8 11h.01' },
  danger: { cls: 'text-red-600 dark:text-red-400', path: 'm5.5 5.5 5 5M10.5 5.5l-5 5' },
  muted: { cls: 'text-zinc-400 dark:text-zinc-500', path: 'M5 8h6' },
};

/**
 * Stroked circle + outcome glyph (✓ ! ✕ –) with a tooltip — the leading state
 * icon on cards and rows. Domain code maps its states to a tone + label; the
 * drawing lives here.
 */
export function StatusGlyph({ tone, label, className = '' }: { tone: GlyphTone; label: string; className?: string }): JSX.Element {
  const spec = GLYPH[tone];
  return (
    <Tooltip content={label}>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-4 shrink-0 ${spec.cls} ${className}`}
        role="img"
        aria-label={label}
      >
        <circle cx="8" cy="8" r="6.2" />
        <path d={spec.path} />
      </svg>
    </Tooltip>
  );
}

/** Filled ✓/✕ circle for dense timeline nodes where a stroked glyph is too quiet. */
export function OutcomeDot({ ok }: { ok: boolean }): JSX.Element {
  return (
    <span
      className={`flex size-3.5 items-center justify-center rounded-full text-[8px] leading-none font-bold text-white ${
        ok ? 'bg-emerald-500' : 'bg-red-500'
      }`}
      aria-hidden
    >
      {ok ? '✓' : '✕'}
    </span>
  );
}

// Each entry carries its own radius so sizes never fight a base rounded-* class.
const AVATAR_SIZE = {
  xs: 'size-5 rounded-lg text-[9px]',
  sm: 'size-7 rounded-lg text-[10px]',
  md: 'size-8 rounded-lg text-[11px]',
  lg: 'size-10 rounded-lg text-[13px]',
  xl: 'size-11 rounded-xl text-lg',
} as const;

/** "ML" from "Michal Lastname"; single-word names give their first two letters. */
function initials(name: string): string {
  const words = name.trim().split(/[\s-_.]+/).filter(Boolean);
  const first = words[0] ?? '';
  return words.length > 1 ? `${first[0] ?? ''}${words[1]?.[0] ?? ''}` : first.slice(0, 2);
}

/**
 * Initials tile for people and entities; `src` swaps in an image, `brand`
 * inverts to the accent fill (instance logos, the auth screens).
 */
export function Avatar({
  name,
  src,
  size = 'md',
  brand,
  className = '',
}: {
  name: string;
  src?: string;
  size?: keyof typeof AVATAR_SIZE;
  brand?: boolean;
  className?: string;
}): JSX.Element {
  const shape = `${AVATAR_SIZE[size]} shrink-0 ${className}`;
  if (src) return <img src={src} alt={name} className={`${shape} object-cover`} />;
  return (
    <span
      className={`flex items-center justify-center font-semibold uppercase ${shape} ${
        brand
          ? 'bg-accent-600 text-white dark:bg-accent-500 dark:text-zinc-950'
          : 'bg-zinc-100 dark:bg-zinc-800'
      }`}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/**
 * Bordered card holding divider-separated rows (pairs with `.row-link`).
 * `subtle` lightens the dividers for nested/secondary lists.
 */
export function ListCard({
  children,
  subtle,
  className = '',
  ariaLabel,
}: {
  children: ReactNode;
  subtle?: boolean;
  className?: string;
  /** Names the list for assistive tech (renders as role="group"). */
  ariaLabel?: string;
}): JSX.Element {
  return (
    <div
      role={ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
      className={`card divide-y p-0 ${
        subtle ? 'divide-zinc-100 dark:divide-zinc-800/60' : 'divide-zinc-200 dark:divide-zinc-800'
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** Right-aligned action footer inside a card, above its own top rule. */
export function CardActions({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div
      className={`mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800 ${className}`}
    >
      {children}
    </div>
  );
}

/** Corner count bubble for a trigger (active filters, unread items). */
export function CountBadge({ count, tone = 'default' }: { count: number; tone?: 'default' | 'danger' }): JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span
      className={`absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold ${
        tone === 'danger' ? 'bg-red-500 text-white' : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
      }`}
      aria-hidden
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Tiny uppercase caption above a block (the "eyebrow"). */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`dim text-[11px] font-medium tracking-widest uppercase ${className}`}>{children}</div>;
}

/** Two-column label/value grid for detail views; fill with DetailRow. */
export function DetailGrid({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <dl className={`grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-[13px] ${className}`}>{children}</dl>
  );
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="dim">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Hash-route breadcrumb above a detail-page title. */
export function Breadcrumb({
  items,
  className = '',
}: {
  items: ReadonlyArray<{ label: string; href?: string }>;
  className?: string;
}): JSX.Element {
  return (
    <nav className={`dim text-[13px] ${className}`} aria-label="Breadcrumb">
      {items.map((item, i) => (
        <span key={`${item.label}-${i}`}>
          {i > 0 ? ' / ' : ''}
          {item.href ? (
            <a href={item.href} className="hover:underline">
              {item.label}
            </a>
          ) : (
            item.label
          )}
        </span>
      ))}
    </nav>
  );
}
