---
name: companion-code-standards
description: >-
  The mechanical coding conventions of the Companion codebase — ESM .js import
  suffix, strict-TS settings, readonly DTOs, zod at the edge, error types, the
  comment style, Tailwind + the ui.tsx kit, dependency discipline. Use when
  writing or editing any TypeScript/React here so the diff matches the existing
  code. There is no linter; consistency is enforced by reading neighbours.
---

# Companion code standards

No ESLint, no Prettier, no test runner is configured. The bar is: **it
typechecks (`pnpm typecheck`) and reads like the file next to it.** Match the
surrounding code's naming, comment density, and idiom.

## TypeScript

- **ESM everywhere.** `"type": "module"`, `module`/`moduleResolution: NodeNext`.
  Relative imports **must** carry the `.js` suffix even though the source is
  `.ts`: `import { route } from '../router.js'`. The shared package is always
  `import … from '@companion/contract'`.
- **`import type` for types.** Type-only imports use `import type { X } from …`
  (`isolatedModules` is on). Mixed value/type imports split the type out.
- **strict + `noUncheckedIndexedAccess`.** Indexing an array/record yields
  `T | undefined`. Handle it (`?? fallback`, a guard, or `arr[i]!` only when you
  have already proven it's present — see the router's `match[i + 1] ?? ''`).
- **`noFallthroughCasesInSwitch`** — every `case` returns or `break`s.
- **DTOs are `readonly`.** Every field on a contract interface is `readonly`;
  arrays are `ReadonlyArray<T>` / `readonly T[]`. Don't mutate them; build new.
- **No `any`.** Use `unknown` at boundaries and narrow. `as` casts are for
  DB-row shapes and parsed JSON only, right next to the parse.
- **Return types are explicit** on exported functions and React components
  (`): JSX.Element`, `): Promise<ProposalRecord>`).

## Validation & errors (backend)

- **zod validates untrusted input at the edge only.** A route's `body:` schema
  is parsed once by the `route()` factory; the handler receives typed, defaulted
  data. Don't re-validate downstream. Reuse `z.enum`s that mirror contract unions.
- **Throw typed HTTP errors** from handlers/services: `badRequest(why)`,
  `notFound(what)`, `forbidden(why)`, or `new HttpError(status, msg)` from
  `http/router.ts`; `AuthError` for auth. The router maps `ZodError → 400`,
  `AuthError/HttpError → their status`, everything else → 500. Never write status
  codes by hand in a handler — `return`, `Reply`, `created(x)`, or `accepted(x)`.
- **Log with the structured logger** (`log.info/warn/error` from `../log.js`),
  passing a context object: `log.warn('proposal analysis failed', { id, err: String(err) })`.

## Errors (frontend)

- `api.ts` throws `ApiError(message, status)`; a 401 auto-clears the session.
- Pages hold `error` in `useState<string | null>` and render an `error-bar`.
  Optimistic updates roll back on catch (see `Profile.tsx saveScope`).
- Fire-and-forget side effects use `void api.foo().catch(() => undefined)` when
  a live broadcast will reconcile the UI anyway (see `useNotifications`).

## Comments

This codebase comments the **why**, not the what. Files and non-obvious blocks
open with a short block comment stating intent and invariants; inline comments
explain a decision or a footgun. Do not narrate mechanics.

```ts
// Role change / disable must not ride old sessions.
if (fields.role !== undefined || fields.disabled === true) {
  this.store.sessions.deleteForUser(username);
}
```

Match that voice. A comment that restates the next line is noise; delete it.

## Naming

- **Backend files**: lowercase, kebab for multi-word (`gateway-client.ts`,
  `local-backend.ts`). Route registries `http/routes/<area>.ts` exporting
  `<area>Routes`. Service classes are the domain noun (`class Proposals`).
- **Store classes**: `<Domain>Store`, file `store/<domain>.ts`.
- **Web**: pages `PascalCase.tsx` (`RunsPage`, `IssuesArea`), hooks
  `use<Thing>.ts` (`useRuns`, `useWorkspacePrs`), lib files lowercase.
- **IDs**: prefixed short uuids — `` `prop-${randomUUID().slice(0, 12)}` ``,
  `runner-local`.

## Frontend specifics

- **React 18 function components** returning `JSX.Element`. Data comes from a
  hook; the page is presentation + actions.
- **Reuse `components/ui.tsx`.** `Page`, `PageHeader`, `Section`, `StatTile`,
  `Modal`, `Dropdown`, `Tabs`, `Switch`, `EmptyState`, `Spinner`, `ActionMenu`,
  `ContextMenu`, `Tooltip`, `CopyText`, `timeAgo`, badges. Don't hand-roll a
  modal/dropdown/spinner — import the existing one.
- **Tailwind v4** utility classes + a few project classes from `styles.css`
  (`dim`, `card`, `input`, `error-bar`, `size-4`). Always style both themes
  (`dark:` variants). Icons are inline `<svg viewBox="0 0 24 24" className="size-4">`
  with the shared `stroke` config in `modules.tsx`.
- **No router library.** Routing is `location.hash` + the `Route()` switch in
  `App.tsx`; deep-linkable list state lives in the hash via `useHash*` helpers.
- **The live loop** is `useLive(refresh, when)` from `lib/live.ts` — load now,
  reload on a matching WS message. Prefer it over hand-written effects.

## Dependencies

Dependencies are deliberate and few (backend: `better-sqlite3`, `ws`, `zod`,
`jsonrepair`, moxxy SDK; web: `react`, `highlight.js`). **Do not add a package
without a real reason** — reach for the platform (`node:crypto`, `fetch`,
`URLSearchParams`) and the existing kit first. Native deps must be listed under
root `pnpm.onlyBuiltDependencies`. If you believe a new dep is warranted, say so
explicitly and justify it rather than adding it silently.
