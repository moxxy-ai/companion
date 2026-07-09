---
name: companion-add-backend-area
description: >-
  Step-by-step recipe to add a new backend domain area to apps/companiond
  end-to-end — contract types, store class + migration, service class, typed
  route registry, deps wiring, and the composition root. Use when building a new
  API surface / module on the daemon. Pair with companion-add-web-area for the UI.
---

# Add a backend area to companiond

The daemon is designed so a new area is **one new file per layer plus one line
in each registry**. Follow the spine top-to-bottom. Read
`companion-architecture`, `companion-contract-and-rbac`, and
`companion-store-and-migrations` first; this recipe assumes their conventions.

Worked example below: an area called **widgets**.

## 1. Contract — types, DTO, permission, WS event

In `packages/contract/src/index.ts` (or a topical file):

```ts
export interface WidgetRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly createdAt: number;
}
export interface CreateWidgetRequest { readonly name: string; readonly tags?: ReadonlyArray<string>; }
```

In `packages/contract/src/auth.ts`: add `'widgets:read'` and `'widgets:manage'`
to the `Permission` union **and** `ALL_PERMISSIONS`, then grant in
`ROLE_PERMISSIONS`. Add `| { readonly t: 'widgets.changed' }` to
`SpaServerMessage`. (Details: `companion-contract-and-rbac`.)

## 2. Store — table + class

Add the DDL to `store/migrations.ts` and create `store/widgets.ts`
(`class WidgetsStore`) following `companion-store-and-migrations`. Wire it into
the `Store` facade in `store/db.ts` (import, `public readonly widgets`,
construct in ctor — respecting dependency order).

## 3. Service — business logic + broadcast

Create `widgets/widgets.ts`. Constructor-inject only what you need; end every
mutation with a broadcast.

```ts
import { randomUUID } from 'node:crypto';
import type { CreateWidgetRequest, SpaServerMessage, WidgetRecord } from '@companion/contract';
import type { Store } from '../store/db.js';

/** Widgets: <one line on the lifecycle this owns>. */
export class Widgets {
  constructor(
    private readonly store: Store,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  create(workspaceId: string, input: CreateWidgetRequest): WidgetRecord {
    const widget: WidgetRecord = {
      id: `wdg-${randomUUID().slice(0, 12)}`,
      workspaceId,
      name: input.name,
      tags: input.tags ?? [],
      createdAt: Date.now(),
    };
    this.store.widgets.insert(widget);
    this.broadcast({ t: 'widgets.changed' });
    return widget;
  }

  list(workspaceId: string): WidgetRecord[] {
    return this.store.widgets.list(workspaceId);
  }
}
```

Services that run agents also take `orchestrator` / `fixes` / `checkouts`;
services that talk to GitHub take a `(ctx) => GitHubClient | null` factory
resolved per purpose (see `Triage`, `Proposals`). Take the minimum.

## 4. Route registry — the HTTP surface

Create `http/routes/widgets.ts`. Declarations only; the router does auth + zod.

```ts
import { z } from 'zod';
import type { WidgetRecord } from '@companion/contract';
import { route, badRequest, created, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  tags: z.array(z.string()).max(20).optional(),
});

export function widgetRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/workspaces/:id/widgets',
      access: 'widgets:read',
      handler: ({ params }): { widgets: WidgetRecord[] } => ({
        widgets: deps.widgets.list(params.id),
      }),
    }),
    route({
      method: 'POST',
      path: '/api/workspaces/:id/widgets',
      access: 'widgets:manage',
      body: createSchema,
      handler: ({ params, body }) => created({ widget: deps.widgets.create(params.id, body) }),
    }),
  ];
}
```

Notes: path params are typed from the pattern (`params.id`); `body` is the
zod **output** (defaults applied); return a plain object for 200, or
`created(x)` / `accepted(x)` / `new Reply(status, body)`; throw `badRequest` /
`notFound` / `forbidden` for errors.

## 5. Register the routes — one line

`http/routes/index.ts`: import `widgetRoutes` and add `...widgetRoutes(deps),`
to the array in `buildRoutes`.

## 6. Deps + composition root — expose the service

- `http/deps.ts`: add `readonly widgets: Widgets;` to `ApiDeps` (import the type).
- `index.ts`: construct `const widgets = new Widgets(store, broadcast);` after
  its dependencies exist, and add `widgets,` to the `deps` object passed to
  `startHttpServer`.

## 7. Verify

`pnpm typecheck` (root) must be clean — the compiler catches an unhandled
`SpaServerMessage` variant, an ungranted permission, a missing deps field, a
DTO mismatch. Then drive it: `pnpm dev`, hit the route with a valid session, and
confirm the WS `widgets.changed` fires on create (see the `run`/`verify`
skills). RBAC needs no test beyond "the route declares the right `access`" —
enforcement is central and already covered.

## Checklist

- [ ] contract: DTO(s) `readonly`, permission in union **and** `ALL_PERMISSIONS`
      **and** `ROLE_PERMISSIONS`, `SpaServerMessage` variant
- [ ] store: migration (idempotent/additive) + `XStore` + facade wiring
- [ ] service: constructor DI, broadcasts after every mutation
- [ ] routes: registry file, correct `access`, zod body, one line in `index.ts`
- [ ] deps: field in `ApiDeps` + constructed & injected in `index.ts`
- [ ] `pnpm typecheck` clean; behaviour driven once in `pnpm dev`
