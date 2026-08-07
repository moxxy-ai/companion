import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission } from '@moxxy/companion-contracts';
import { Slot } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import {
  ContextMenu,
  type ContextMenuState,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  IconButton,
  KebabIcon,
  type MenuAction,
  MetaSignal,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  SearchInput,
  Section,
  SegmentedControl,
  Switch,
  timeAgo,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import type {
  IntegrationCategory,
  IntegrationConfigField,
  IntegrationConnectionDraft,
  IntegrationConnectionRecord,
  IntegrationFieldValue,
  EffectiveIntegrationRoute,
  IntegrationProviderDescriptor,
  IntegrationScope,
  IntegrationTargetRef,
} from '../../contract/index.js';
import { integrationsApi } from '../api.js';
import { useIntegrations } from '../hooks/useIntegrations.js';
import { ProviderIcon } from '../ProviderIcon.js';
import { decodeIntegrationTarget, encodeIntegrationTarget, reviewTargetOptions } from '../review-targets.js';

const CATEGORY_LABELS: Record<string, string> = {
  review: 'Code review',
  communication: 'Communication',
  'project-management': 'Project management',
  'developer-tools': 'Developer tools',
};

export function IntegrationsPage(): JSX.Element {
  const { can } = useAuth();
  const { current } = useWorkspace();
  const state = useIntegrations();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<IntegrationCategory | 'all'>('all');
  const [editing, setEditing] = useState<{
    provider: IntegrationProviderDescriptor;
    connection?: IntegrationConnectionRecord;
  } | null>(null);
  const [reviewDefaults, setReviewDefaults] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const reviewScope: IntegrationScope = current
    ? { kind: 'workspace', workspaceId: current.id }
    : { kind: 'instance' };

  const providers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (state.catalog?.providers ?? []).filter(
      (provider) =>
        (category === 'all' || provider.category === category) &&
        (!needle ||
          `${provider.vendor} ${provider.title} ${provider.description} ${provider.capabilities.join(' ')}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [state.catalog, query, category]);

  if (!state.catalog) return state.error ? <Page><ErrorBar error={state.error} /></Page> : <PageLoading label="Loading integrations…" />;

  // This page configures instance + current-workspace defaults. Repository
  // connections have their own focused surface, and connections from another
  // workspace must not be edited against the currently selected workspace.
  const pageConnections = state.catalog.connections.filter(
    (connection) =>
      connection.scope.kind === 'instance' ||
      (connection.scope.kind === 'workspace' && connection.scope.workspaceId === current?.id),
  );
  const catalog = state.catalog;
  const providerOf = new Map(catalog.providers.map((provider) => [provider.id, provider]));
  const canManage = can('integrations:manage');
  const canSelf = can('integrations:self');
  const enabled = pageConnections.filter(
    (connection) => connection.enabled && providerOf.has(connection.providerId),
  ).length;
  const attention = pageConnections.filter(
    (connection) =>
      !providerOf.has(connection.providerId) ||
      connection.health.status === 'unavailable' ||
      connection.health.status === 'degraded',
  ).length;
  const categories = [...new Set(catalog.providers.map((provider) => provider.category))];

  const remove = (connection: IntegrationConnectionRecord): void =>
    void (async () => {
      const ok = await confirmDanger({
        title: `Remove “${connection.name}”?`,
        message: 'Its credentials are deleted and any routing fallback that points to it is removed.',
        confirmLabel: 'Remove connection',
      });
      if (ok) await state.remove(connection.id, connection.ownerId !== null);
    })().catch(() => undefined);

  /**
   * Everything a connection can do beyond its on/off switch. Testing and
   * editing need the provider's module, which a disabled one no longer has, so
   * a stranded connection is left with the one action that still means
   * something.
   */
  const connectionActions = (connection: IntegrationConnectionRecord): MenuAction[] => {
    const provider = providerOf.get(connection.providerId);
    const personal = connection.ownerId !== null;
    if (!(personal ? canSelf : canManage)) return [];
    const busy = state.busy !== null;
    return [
      ...(provider
        ? [
            {
              label: 'Test connection',
              disabled: busy,
              onSelect: () => void state.test(connection.id, personal).catch(() => undefined),
            },
            { label: 'Edit connection', disabled: busy, onSelect: () => setEditing({ provider, connection }) },
          ]
        : []),
      ...(provider?.docsUrl ? [{ label: 'Provider docs', href: provider.docsUrl, external: true }] : []),
      { label: 'Remove', danger: true, disabled: busy, onSelect: () => remove(connection) },
    ];
  };

  return (
    <Page>
      <PageHeader
        title="Integrations"
        subtitle="Connect specialist tools once, then route their capabilities where your teams work"
        actions={
          <>
            <button className="btn-ghost" onClick={() => setReviewDefaults(true)}>
              Review defaults
            </button>
            <Slot name="integrations.page.actions" can={can} />
          </>
        }
      />
      <ErrorBar error={state.error} />

      {pageConnections.length > 0 ? (
        <Section
          title="Your connections"
          description={
            `${enabled} of ${pageConnections.length} enabled` +
            (attention > 0 ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : '')
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {pageConnections.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                provider={providerOf.get(connection.providerId) ?? null}
                can={can}
                workspaceName={current?.name ?? null}
                busy={state.busy === connection.id}
                canToggle={connection.ownerId !== null ? canSelf : canManage}
                actions={connectionActions(connection)}
                onToggle={(value) =>
                  void state.update(connection.id, { enabled: value }, connection.ownerId !== null).catch(
                    () => undefined,
                  )
                }
                onMenu={setMenu}
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="Add an integration"
        description="Everything this instance can talk to. A provider can hold more than one connection."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchInput
            className="min-w-52 flex-1"
            value={query}
            onChange={setQuery}
            placeholder="Search providers and capabilities…"
            ariaLabel="Search integrations"
          />
          <div className="flex flex-wrap gap-1" aria-label="Integration category">
            <FilterButton selected={category === 'all'} onClick={() => setCategory('all')}>All</FilterButton>
            {categories.map((value) => (
              <FilterButton key={value} selected={category === value} onClick={() => setCategory(value)}>
                {CATEGORY_LABELS[value] ?? value}
              </FilterButton>
            ))}
          </div>
        </div>

        {providers.length === 0 ? (
          <EmptyState title="No matching integrations" hint="Clear the search or choose another capability group." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {providers.map((provider) => (
              <CatalogTile
                key={provider.id}
                provider={provider}
                connections={pageConnections.filter((connection) => connection.providerId === provider.id)}
                can={can}
                canConnectHere={
                  provider.scopes.includes('instance') || (!!current && provider.scopes.includes('workspace'))
                }
                canConnect={canManage || (canSelf && provider.supportsPersonal === true)}
                onConnect={() => setEditing({ provider })}
              />
            ))}
          </div>
        )}
      </Section>

      {reviewDefaults ? (
        <ReviewDefaultsModal
          workspaceId={current?.id ?? null}
          workspaceName={current?.name ?? null}
          providers={state.catalog.providers}
          connections={state.catalog.connections}
          canManage={can('integrations:manage')}
          busy={state.busy !== null}
          saving={state.busy?.startsWith('route:') ?? false}
          onClose={() => setReviewDefaults(false)}
          onSave={async (targets) => {
            await state.setRoute('code-review', reviewScope, targets);
            setReviewDefaults(false);
          }}
        />
      ) : null}

      {editing ? (
        <ConnectionModal
          provider={editing.provider}
          connection={editing.connection}
          can={can}
          workspaceId={current?.id ?? null}
          canManage={can('integrations:manage')}
          canSelf={can('integrations:self')}
          busy={state.busy !== null}
          onClose={() => setEditing(null)}
          onCreate={async (draft, personal) => {
            await state.create(draft, personal);
            setEditing(null);
          }}
          onUpdate={async (connection, input) => {
            await state.update(connection.id, input, connection.ownerId !== null);
            setEditing(null);
          }}
        />
      ) : null}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {confirmElement}
    </Page>
  );
}

/**
 * The scope's default code review route. A dialog rather than a panel on the
 * page: it is set once and then inherited, so it was spending the top of the
 * page on a question nobody was asking while scanning the catalogue.
 */
function ReviewDefaultsModal({
  workspaceId,
  workspaceName,
  providers,
  connections,
  canManage,
  busy,
  saving,
  onSave,
  onClose,
}: {
  workspaceId: string | null;
  workspaceName: string | null;
  providers: readonly IntegrationProviderDescriptor[];
  connections: readonly IntegrationConnectionRecord[];
  canManage: boolean;
  busy: boolean;
  saving: boolean;
  onSave: (targets: IntegrationTargetRef[]) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const scope: IntegrationScope = workspaceId
    ? { kind: 'workspace', workspaceId }
    : { kind: 'instance' };
  const [route, setRoute] = useState<EffectiveIntegrationRoute | null>(null);
  const [primary, setPrimary] = useState('');
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(
    () => reviewTargetOptions(providers, connections, scope, true),
    [providers, connections, workspaceId],
  );

  useEffect(() => {
    let live = true;
    void integrationsApi
      .route('code-review', scope)
      .then(({ route: loaded }) => {
        if (!live) return;
        setRoute(loaded);
        setPrimary(loaded.targets[0] ? encodeIntegrationTarget(loaded.targets[0]) : '');
        setFallback(loaded.targets[1] ? encodeIntegrationTarget(loaded.targets[1]) : '');
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const save = async (): Promise<void> => {
    const targets: IntegrationTargetRef[] = [];
    const first = decodeIntegrationTarget(primary, undefined, connections);
    const second = decodeIntegrationTarget(fallback, undefined, connections);
    if (first) targets.push(first);
    if (first && second && encodeIntegrationTarget(second) !== encodeIntegrationTarget(first)) {
      targets.push(second);
    }
    try {
      await onSave(targets);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal title="Default code review route" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="dim text-[13px]">
          {workspaceName
            ? `Used by repositories in ${workspaceName} until a repository overrides it.`
            : 'Used instance-wide until a workspace or repository overrides it.'}
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Primary reviewer">
            <select
              className="input"
              value={primary}
              onChange={(event) => {
                setPrimary(event.target.value);
                if (!event.target.value) setFallback('');
              }}
              disabled={!canManage || !route}
            >
              <option value="">Use inherited platform default</option>
              {primary && !options.some((option) => option.value === primary) ? (
                <option value={primary}>Unavailable · {routeTargetName(primary, connections)}</option>
              ) : null}
              {options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Unavailable fallback">
            <select
              className="input"
              value={fallback}
              onChange={(event) => setFallback(event.target.value)}
              disabled={!canManage || !route || !primary}
            >
              <option value="">No fallback</option>
              {fallback && !options.some((option) => option.value === fallback) ? (
                <option value={fallback}>Unavailable · {routeTargetName(fallback, connections)}</option>
              ) : null}
              {options
                .filter((option) => option.value !== primary)
                .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MetaSignal
            tone={route?.sourceScope?.kind === scope.kind ? 'green' : 'zinc'}
            label={route?.sourceScope
              ? route.sourceScope.kind === scope.kind
                ? `${scope.kind} override`
                : `inherited from ${route.sourceScope.kind}`
              : 'platform default'}
          />
          <span className="dim text-xs">Fallback runs only when the primary is unavailable, never after a real review failure.</span>
        </div>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
          {canManage ? (
            <button className="btn" disabled={busy || !route} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save route'}
            </button>
          ) : null}
        </FormActions>
      </div>
    </Modal>
  );
}

function FilterButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button className={selected ? 'btn' : 'btn-ghost'} onClick={onClick} aria-pressed={selected}>
      {children}
    </button>
  );
}

const HEALTH_TONE: Record<IntegrationConnectionRecord['health']['status'], 'green' | 'amber' | 'red' | 'zinc'> = {
  ready: 'green',
  degraded: 'amber',
  unavailable: 'red',
  checking: 'zinc',
  unknown: 'zinc',
};

/**
 * The provider's own mark, drawn by the module that owns it; initials stand in
 * for providers with no mark, and for a connection whose module is gone and can
 * therefore contribute nothing.
 */
function ProviderMark({
  providerId,
  label,
  className = 'size-10',
}: {
  providerId: string;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`flex ${className} shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200`}
    >
      <ProviderIcon providerId={providerId} fallback={label.slice(0, 2).toUpperCase()} />
    </div>
  );
}

/**
 * One thing you have actually set up. The switch stays on the card because it
 * is the control people reach for; everything rarer sits behind the menu, which
 * is what kept four buttons on every row before.
 */
function ConnectionCard({
  connection,
  provider,
  can,
  workspaceName,
  busy,
  canToggle,
  actions,
  onToggle,
  onMenu,
}: {
  connection: IntegrationConnectionRecord;
  /** null once its module is disabled: the credentials outlive the provider. */
  provider: IntegrationProviderDescriptor | null;
  can: (permission: Permission) => boolean;
  workspaceName: string | null;
  busy: boolean;
  canToggle: boolean;
  actions: MenuAction[];
  onToggle: (enabled: boolean) => void;
  onMenu: (menu: ContextMenuState) => void;
}): JSX.Element {
  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <ProviderMark
          providerId={connection.providerId}
          label={provider?.vendor ?? connection.providerId}
          className="size-9"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="truncate text-sm font-medium">{connection.name}</strong>
            {provider ? (
              <MetaSignal
                tone={HEALTH_TONE[connection.health.status]}
                label={connection.health.status}
                title={connection.health.message}
              />
            ) : (
              <MetaSignal tone="amber" label="provider disabled" />
            )}
            {connection.ownerId ? <MetaSignal tone="zinc" label="just you" /> : null}
          </div>
          <p className="dim mt-1 truncate text-xs">
            {[
              provider?.title ?? connection.providerId,
              scopeLabel(connection.scope, workspaceName ?? undefined),
              connection.health.checkedAt ? `checked ${timeAgo(connection.health.checkedAt)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </div>

      {provider ? null : (
        <p className="dim text-xs">
          Its credentials are kept while the module is off. Re-enable the module to use or edit them.
        </p>
      )}

      <div className="mt-auto flex items-center gap-1.5 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
        <Slot
          name={`integrations.connection.${connection.providerId}.actions`}
          can={can}
          props={{ providerId: connection.providerId, connectionId: connection.id }}
        />
        <span className="flex-1" />
        {provider && canToggle ? (
          <Switch
            checked={connection.enabled}
            onChange={onToggle}
            disabled={busy}
            label={`Enable ${connection.name}`}
          />
        ) : null}
        {actions.length > 0 ? (
          <IconButton
            label={`Actions for ${connection.name}`}
            className="-mr-1"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onMenu({ x: rect.right - 224, y: rect.bottom + 4, actions });
            }}
          >
            <KebabIcon />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One provider in the catalogue: what it is and the single move it offers.
 * A provider already connected stays listed, because a second Slack channel or
 * a second Jira site is a normal thing to want.
 */
function CatalogTile({
  provider,
  connections,
  can,
  canConnect,
  canConnectHere,
  onConnect,
}: {
  provider: IntegrationProviderDescriptor;
  connections: readonly IntegrationConnectionRecord[];
  can: (permission: Permission) => boolean;
  /** The viewer may create connections of this kind at all. */
  canConnect: boolean;
  /** This scope can hold one: some providers are workspace-only. */
  canConnectHere: boolean;
  onConnect: () => void;
}): JSX.Element {
  const builtIn = provider.connectionMode === 'none';
  const live = connections.filter((connection) => connection.enabled).length;
  return (
    <div className="card flex flex-col gap-3" aria-label={provider.title}>
      <div className="flex items-start gap-3">
        <ProviderMark providerId={provider.id} label={provider.vendor} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold" title={provider.title}>{provider.title}</h3>
          {builtIn ? (
            <MetaSignal tone="green" label="built in" />
          ) : connections.length > 0 ? (
            <MetaSignal
              tone={live > 0 ? 'green' : 'zinc'}
              label={`${connections.length} connected${live === connections.length ? '' : `, ${live} on`}`}
            />
          ) : (
            <span className="dim text-xs">{provider.execution}</span>
          )}
        </div>
      </div>

      <p className="dim line-clamp-2 text-xs leading-relaxed" title={provider.description}>
        {provider.description}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {provider.capabilities.map((capability) => (
          <span className="chip" key={capability}>{capability.replace('-', ' ')}</span>
        ))}
      </div>

      <Slot name={`integrations.provider.${provider.id}.panel`} can={can} props={{ providerId: provider.id }} />

      <div className="mt-auto flex items-center gap-2 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
        {provider.docsUrl ? (
          <a className="dim text-xs hover:underline" href={provider.docsUrl} target="_blank" rel="noreferrer">
            Docs ↗
          </a>
        ) : null}
        <span className="flex-1" />
        {builtIn ? (
          <span className="dim text-xs">Nothing to connect</span>
        ) : !canConnectHere ? (
          <span className="dim text-xs">Select a workspace</span>
        ) : canConnect ? (
          <button className={connections.length > 0 ? 'btn-ghost' : 'btn'} onClick={onConnect}>
            {connections.length > 0 ? 'Add another' : 'Connect'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ConnectionModal({
  provider,
  connection,
  can,
  workspaceId,
  fixedScope,
  canManage,
  canSelf,
  busy,
  onClose,
  onCreate,
  onUpdate,
}: {
  provider: IntegrationProviderDescriptor;
  connection?: IntegrationConnectionRecord;
  can: (permission: Permission) => boolean;
  workspaceId: string | null;
  fixedScope?: IntegrationScope;
  canManage: boolean;
  canSelf: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (draft: IntegrationConnectionDraft, personal: boolean) => Promise<void>;
  onUpdate: (
    connection: IntegrationConnectionRecord,
    input: { name: string; scope: IntegrationScope; config: Readonly<Record<string, IntegrationFieldValue | null>> },
  ) => Promise<void>;
}): JSX.Element {
  const availableScopes: Array<'instance' | 'workspace' | 'repository'> = fixedScope
    ? [fixedScope.kind]
    : provider.scopes.filter(
        (scope) => scope === 'instance' || (scope === 'workspace' && workspaceId) || scope === connection?.scope.kind,
      );
  const initialScope =
    fixedScope?.kind ??
    connection?.scope.kind ??
    (workspaceId && availableScopes.includes('workspace') ? 'workspace' : undefined) ??
    (availableScopes.includes('instance') ? 'instance' : undefined) ??
    availableScopes[0] ??
    'instance';
  const [name, setName] = useState(connection?.name ?? provider.title);
  const [scopeKind, setScopeKind] = useState<'instance' | 'workspace' | 'repository'>(initialScope);
  const [personal, setPersonal] = useState(
    connection
      ? connection.ownerId !== null
      : provider.supportsPersonal === true && canSelf && !canManage,
  );
  const [values, setValues] = useState<Record<string, IntegrationFieldValue | null>>(() => ({ ...(connection?.config ?? {}) }));
  const [clearSecrets, setClearSecrets] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const scopedWorkspaceId = connection && connection.scope.kind !== 'instance'
    ? connection.scope.workspaceId
    : workspaceId;
  const scope: IntegrationScope = fixedScope ?? (
    scopeKind === 'workspace' && scopedWorkspaceId
      ? { kind: 'workspace', workspaceId: scopedWorkspaceId }
      : { kind: 'instance' }
  );

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const config: Record<string, IntegrationFieldValue | null> = {};
    for (const field of provider.fields) {
      if (field.kind === 'secret') {
        if (clearSecrets.has(field.key)) config[field.key] = null;
        else if (typeof values[field.key] === 'string' && values[field.key] !== '') config[field.key] = values[field.key]!;
      } else if (values[field.key] !== undefined) {
        config[field.key] = values[field.key]!;
      }
    }
    try {
      if (connection) await onUpdate(connection, { name: name.trim(), scope, config });
      else await onCreate({ providerId: provider.id, name: name.trim(), scope, enabled: true, config: config as Record<string, IntegrationFieldValue> }, personal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal title={`${connection ? 'Edit' : 'Connect'} ${provider.title}`} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {provider.setup ? (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-3 text-sm leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
            {provider.setup}
            {provider.docsUrl ? (
              <a className="ml-2 whitespace-nowrap font-medium text-zinc-900 hover:underline dark:text-zinc-100" href={provider.docsUrl} target="_blank" rel="noreferrer">
                Setup docs ↗
              </a>
            ) : null}
          </div>
        ) : null}
        <Field label="Connection name" hint="A human label used in routing and delivery history.">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        </Field>

        {!fixedScope && availableScopes.length > 1 && connection?.scope.kind !== 'repository' ? (
          <Field label="Available to">
            <SegmentedControl
              value={scopeKind}
              onChange={setScopeKind}
              options={availableScopes.map((value) => ({
                value,
                label: value === 'instance' ? 'Every workspace' : value === 'workspace' ? 'Current workspace' : 'This repository',
              }))}
              label="Connection scope"
              name="integration-scope"
            />
          </Field>
        ) : null}

        {!connection && provider.supportsPersonal && canSelf && canManage ? (
          <Field
            label="Audience"
            hint={personal ? 'Only events addressed to you can use it.' : 'Shared routing and team events can use it.'}
          >
            <SegmentedControl
              value={personal ? 'personal' : 'shared'}
              onChange={(value) => setPersonal(value === 'personal')}
              options={[{ value: 'shared', label: 'Team' }, { value: 'personal', label: 'Just me' }]}
              label="Connection audience"
              name="integration-audience"
            />
          </Field>
        ) : !connection && provider.supportsPersonal && !canManage ? (
          <p className="dim text-xs">This connection is personal and receives only events addressed to you.</p>
        ) : null}

        {provider.fields.map((field) => (
          <ConnectionField
            key={field.key}
            field={field}
            value={values[field.key]}
            configured={connection?.configuredSecrets.includes(field.key) ?? false}
            clear={clearSecrets.has(field.key)}
            onClear={(clear) =>
              setClearSecrets((current) => {
                const next = new Set(current);
                if (clear) next.add(field.key);
                else next.delete(field.key);
                return next;
              })
            }
            onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
          />
        ))}

        <Slot
          name={`integrations.provider.${provider.id}.form`}
          can={can}
          props={{ providerId: provider.id, connectionId: connection?.id ?? null }}
        />
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save connection'}</button>
        </FormActions>
      </form>
    </Modal>
  );
}

function ConnectionField({
  field,
  value,
  configured,
  clear,
  onClear,
  onChange,
}: {
  field: IntegrationConfigField;
  value: IntegrationFieldValue | null | undefined;
  configured: boolean;
  clear: boolean;
  onClear: (value: boolean) => void;
  onChange: (value: IntegrationFieldValue) => void;
}): JSX.Element {
  const hint = field.kind === 'secret' && configured
    ? `${field.description ?? ''}${field.description ? ' ' : ''}A credential is stored; leave blank to keep it.`
    : field.description;
  if (field.kind === 'boolean') {
    return (
      <Field label={field.label} hint={hint}>
        <Switch checked={Boolean(value ?? field.default)} onChange={onChange} label={field.label} />
      </Field>
    );
  }
  if (field.kind === 'select') {
    return (
      <Field label={field.label} hint={hint}>
        <select className="input" value={String(value ?? field.default ?? '')} onChange={(event) => onChange(event.target.value)} required={field.required}>
          <option value="" disabled={field.required}>{field.required ? 'Choose…' : 'Not set'}</option>
          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Field>
    );
  }
  if (field.kind === 'multiselect') {
    return <MultiSelectField field={field} value={value} hint={hint} onChange={onChange} />;
  }
  return (
    <Field label={field.label} hint={hint}>
      <input
        className="input"
        type={field.kind === 'secret' ? 'password' : field.kind === 'url' ? 'url' : 'text'}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        required={field.required && !(field.kind === 'secret' && configured && !clear)}
        disabled={clear}
        autoComplete="off"
      />
      {field.kind === 'secret' && configured && !field.required ? (
        <label className="dim mt-2 flex items-center gap-2 text-xs">
          <input type="checkbox" checked={clear} onChange={(event) => onClear(event.target.checked)} />
          Clear the stored credential
        </label>
      ) : null}
    </Field>
  );
}

/**
 * A closed set as toggles, stored as the comma-separated string the field
 * always held, so every parser and validator behind it is untouched.
 *
 * Toggles rather than a typeahead: with a handful of values, a menu you have to
 * open and filter is more work than the answer is worth, and picking from what
 * is shown beats recalling the spelling of `action_required`. Nothing selected
 * means no filter, which is what the empty string already meant.
 */
function MultiSelectField({
  field,
  value,
  hint,
  onChange,
}: {
  field: IntegrationConfigField;
  value: IntegrationFieldValue | null | undefined;
  hint: ReactNode;
  onChange: (value: IntegrationFieldValue) => void;
}): JSX.Element {
  const selected = new Set(
    (typeof value === 'string' ? value : '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const toggle = (option: string): void => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    // Emitted in the order the provider declared, so the stored value does not
    // depend on the order somebody happened to click.
    onChange((field.options ?? []).map((o) => o.value).filter((o) => next.has(o)).join(','));
  };
  return (
    <Field label={field.label} hint={hint}>
      <div className="flex flex-wrap gap-2">
        {(field.options ?? []).map((option) => {
          const on = selected.has(option.value);
          return (
            <button
              type="button"
              key={option.value}
              aria-pressed={on}
              onClick={() => toggle(option.value)}
              className={`rounded-full border px-3 py-1.5 text-[13px] transition-colors ${
                on
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                  : 'border-zinc-300 text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function scopeLabel(scope: IntegrationScope, workspaceName?: string): string {
  switch (scope.kind) {
    case 'instance': return 'Every workspace';
    case 'workspace': return workspaceName ? `Workspace ${workspaceName}` : 'Current workspace';
    case 'repository': return scope.repo;
  }
}

function routeTargetName(value: string, connections: readonly IntegrationConnectionRecord[]): string {
  if (value.startsWith('provider:')) return value.slice('provider:'.length);
  if (value.startsWith('connection:')) {
    const id = value.slice('connection:'.length);
    const connection = connections.find((candidate) => candidate.id === id);
    return connection ? `${connection.providerId} · ${connection.name}` : id;
  }
  return value;
}
