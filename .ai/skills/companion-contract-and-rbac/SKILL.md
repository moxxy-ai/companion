---
name: companion-contract-and-rbac
description: >-
  How to evolve the shared spine — packages/contract — safely: add or change a
  DTO, add a Permission and thread it end-to-end through roles + routes +
  modules, add a SpaServerMessage WS event, or extend a union. Use whenever a
  type crosses the client/server boundary or a new capability/role rule is
  needed. Getting this wrong silently breaks RBAC or the live stream.
---

# Contract & RBAC — the type-safe spine

`packages/contract` is imported by both apps as `@companion/contract`
(`workspace:*`). It is the **only** place a cross-boundary type may be defined.
Because both the daemon's route table and the SPA's module registry consume the
same `Permission` map, a capability added here is enforced by the type system on
both sides — that is the whole design, don't route around it.

Files: `auth.ts` (roles, permissions, auth DTOs), `workspaces.ts`,
`pipelines.ts`, `checks.ts`, `moxxy.ts`, `runner-agent.ts`, and `index.ts`
(barrel re-export + Run/GitHub/notification/etc. types).

## Adding or changing a DTO

1. Put it in the topical file (or `index.ts` for run/github/notification-ish
   types), all fields `readonly`, arrays `ReadonlyArray<T>`.
2. Document non-obvious fields with a short comment (see how `RunRecord` /
   `RunnerHealth` annotate `null` semantics — "null = unknown → assume capable").
3. If it's a new file, add `export * from './x.js'` to `index.ts`.
4. `pnpm --filter @companion/contract build` (or rely on `pnpm dev`'s watch), then
   `pnpm typecheck` at the root — the compiler flags every consumer that now
   needs updating on **both** sides. Fix them; don't `any` past them.

Renaming/removing a field is a breaking change across both apps — let the
typechecker enumerate the call sites and update each.

## Adding a Permission (thread it end-to-end)

`Permission` is a string union in `auth.ts`. A capability is only real once it
appears in **every** one of these places:

1. **`packages/contract/src/auth.ts`** — add the literal to the `Permission`
   union **and** to the `ALL_PERMISSIONS` array (they must stay in sync), then
   grant it in `ROLE_PERMISSIONS` for the roles that should have it. `admin`
   gets `ALL_PERMISSIONS`; `maintainer` is `ALL_PERMISSIONS` minus the
   admin-only set; `business` is an explicit allowlist.
2. **Backend route** — set `access: 'your:permission'` on each `route({...})`.
   The router calls `auth.require(user, access)`; no handler-level checks.
3. **SPA module** (`apps/web/src/modules.tsx`) — the area's `permission:` field.
   Nav visibility and RBAC filtering derive from it automatically.
4. **SPA route guard** (`apps/web/src/App.tsx`) — `guard(can('your:permission'), <Page/>)`.

Naming is `area:verb` — `read`, `manage`, `act`, `create`, `run`, `connect`.
Reuse an existing verb if it fits; don't invent a synonym.

Route access has three non-permission values too: `'public'` (no auth, e.g.
`/api/auth/state`, `/healthz`), `'any'` (any signed-in user regardless of role,
e.g. `/api/profile`), and a concrete `Permission`.

## Adding a live WS event

The server→browser stream is the `SpaServerMessage` union in `index.ts`.

1. Add a variant: `| { readonly t: 'widgets.changed'; readonly repo?: string }`.
   Follow the existing convention — coarse `'<area>.changed'` signals trigger a
   refetch; `'run.changed'` carries the full record for in-place patching.
2. **Emit it** from the service after every mutation: `this.broadcast({ t: 'widgets.changed' })`.
3. **Consume it** on the client in the area's hook:
   `useLive(refresh, (msg) => msg.t === 'widgets.changed')`.

`SpaServerMessage` is exhaustively switched in a few places; the compiler will
point you at anything that must handle the new variant.

## RBAC facts worth remembering

- `verify()` re-reads role & `disabled` from the account on **every** request,
  so a demotion or disable takes effect immediately and no token can outrank its
  account. Role/disable/password changes also delete the user's sessions.
- The install must always keep **one enabled admin** (`guardLastAdmin`); nobody
  may change their own role or delete their own account.
- Private workspaces add a second gate on top of role: `canAccessRepo` /
  membership. Role says *what kind of thing* you can do; workspace membership
  says *which workspaces' data* you see. Keep the two concerns separate.
