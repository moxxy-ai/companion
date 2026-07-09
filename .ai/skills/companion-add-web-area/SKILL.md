---
name: companion-add-web-area
description: >-
  Step-by-step recipe to add a new module/area to the apps/web SPA end-to-end —
  api.ts client method, a useLive data hook, a page built from the ui.tsx kit,
  the modules.tsx nav entry, and the App.tsx hash-route guard. Use when adding
  UI for a backend area. Pair with companion-add-backend-area.
---

# Add a web area to the SPA

The SPA mirrors the daemon: a new area is an `api.ts` method + a hook + a page +
one entry in `modules.tsx` + one branch in `App.tsx`. Hash-routed, no
react-router, live over the shared WebSocket. Assumes the backend area exists
(`companion-add-backend-area`) and the conventions in `companion-code-standards`.

Worked example: **widgets** (workspace-scoped, permissions `widgets:read` /
`widgets:manage`).

## 1. API client — `lib/api.ts`

Import the contract types at the top, then add methods to the `api` object using
the `request/post/put/patch/del` + `qs()` helpers already in the file:

```ts
// widgets
workspaceWidgets: (id: string) =>
  request<{ widgets: WidgetRecord[] }>(`/api/workspaces/${id}/widgets`),
createWidget: (id: string, body: CreateWidgetRequest) =>
  post<{ widget: WidgetRecord }>(`/api/workspaces/${id}/widgets`, body),
```

Return types are the exact server shapes — copy them from the route handler's
return so the two never drift.

## 2. Data hook — `hooks/useWorkspaceWidgets.ts`

Wrap the live loop. Scope to the active workspace; reload on the WS event.

```ts
import { useCallback, useState } from 'react';
import type { WidgetRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { useWorkspace } from '../lib/workspace.js';

export function useWorkspaceWidgets(): {
  widgets: WidgetRecord[];
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [widgets, setWidgets] = useState<WidgetRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!current) return setWidgets([]);
    try {
      setWidgets((await api.workspaceWidgets(current.id)).widgets);
    } catch (e) {
      setError(String(e));
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'widgets.changed');
  return { widgets, error, refresh };
}
```

`useLive(refresh, when)` = load now + reload on a matching message. `refresh` is
`useCallback`'d on the active workspace so it re-runs when the workspace
switches but not on every render. For records that arrive one-at-a-time you can
also patch in place (see `useRuns` handling `run.changed`).

## 3. Page — `pages/Widgets.tsx`

Compose the `ui.tsx` kit; gate write actions with `can()`; surface errors in an
`error-bar`.

```tsx
import type { JSX } from 'react';
import { Page, PageHeader, Section, EmptyState } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspaceWidgets } from '../hooks/useWorkspaceWidgets.js';

export function WidgetsPage(): JSX.Element {
  const { can } = useAuth();
  const { widgets, error } = useWorkspaceWidgets();

  return (
    <Page>
      <PageHeader title="Widgets" subtitle="Per-workspace widgets" />
      {error ? <div className="error-bar">{error}</div> : null}
      <Section title="All widgets">
        {widgets.length === 0 ? (
          <EmptyState title="No widgets yet" hint={can('widgets:manage') ? 'Create one to get started.' : undefined} />
        ) : (
          <div className="grid gap-2">
            {widgets.map((w) => (
              <div key={w.id} className="card">{w.name}</div>
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}
```

Use `Modal` + `useConfirm` for create/delete flows, `Dropdown`/`Switch`/`Tabs`
for controls, `timeAgo` for timestamps, `ActionMenu` for row actions. Style both
themes with `dark:`. Keep the repo's UI taste: icon-only controls where obvious,
subtle touches, no gratuitous chrome.

## 4. Module registry — `modules.tsx`

Add an inline SVG to the `icons` map (viewBox `0 0 24 24`, `className="size-4"`,
spread the shared `stroke`), then an entry to `MODULES`:

```tsx
{
  key: 'widgets',
  label: 'Widgets',
  hash: '#/widgets',
  shortcut: 'w',       // unique across MODULES; `g`+key jumps to it
  permission: 'widgets:read',
  section: 'operate',  // 'workspace' | 'plan' | 'code' | 'operate' | 'admin'
  icon: icons.widgets,
},
```

Nav rendering, RBAC filtering, and the `g`+key shortcut all derive from this — no
other wiring needed for the sidebar.

## 5. Route — `App.tsx`

Import the page and add a branch to `Route({ hash })`, guarded by the permission.
**Order matters**: a `startsWith` prefix must not shadow a longer sibling (note
how `/runners` is placed *before* `/runs`). Put the new branch where its prefix
is unambiguous.

```tsx
if (path.startsWith('/widgets')) return guard(can('widgets:read'), <WidgetsPage />);
```

For a detail route, add a regex match near the top of `Route()` (see the
`/runs/:id`, `/repos/:o/:n/prs/:num` patterns) and link with
`location.hash = '#/widgets/…'`.

## 6. Verify

`pnpm typecheck`, then `pnpm dev` and click through: the nav entry shows for a
role with the permission and is hidden without it, the list loads, a mutation
elsewhere reflects live via `widgets.changed`. Drive it in the real app rather
than trusting types alone (see the `run`/`verify` skills).

## Checklist

- [ ] `api.ts` methods return the exact server shapes
- [ ] hook uses `useLive` + the correct `msg.t`, scoped to the workspace
- [ ] page built from `ui.tsx`, write actions gated by `can()`, errors shown
- [ ] `modules.tsx`: unique `shortcut`, right `permission` + `section`, icon
- [ ] `App.tsx`: `guard(can(...))` branch placed so no prefix shadows it
- [ ] `pnpm typecheck` clean; clicked through in `pnpm dev` for both roles
