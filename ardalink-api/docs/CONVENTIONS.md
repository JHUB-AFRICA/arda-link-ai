# ArdaLink API — code conventions (addendum)

This is a **service-specific addendum** to the root
[`CONVENTIONS.md`](../../CONVENTIONS.md). Read the root document first —
this file only covers what is unique to the TypeScript / Node 24 / Express
service layer.

---

## 1. Tooling

| Tool | Version | Purpose | Where |
|---|---|---|---|
| TypeScript | 5.x | Source language | `tsconfig.json` |
| Express | 5.x | HTTP framework | `src/index.ts` |
| tsx | 4.x | Dev runner + watch | `package.json` `scripts.dev` |
| vitest | latest | Test runner | `tests/` |
| zod | latest | Runtime schema validation | `src/lib/schemas/` |
| pino | latest | Structured logging | `src/lib/logger.ts` |
| prettier | latest | Formatter | `.prettierrc` |

Run lint + typecheck before pushing:

```bash
pnpm run typecheck
pnpm run lint
pnpm run format:check
```

---

## 2. Layering

Source code is organised in four layers. Imports must respect the arrows —
no upward imports, no sideways imports between siblings of the same layer.

```
routes/     ← Express handlers (HTTP boundary)
   │
   ▼
lib/        ← Domain logic, services, integrations
   │
   ▼
db/         ← Drizzle schema + queries
   │
   ▼
config/     ← Env, secrets, feature flags (loaded once at boot)
```

`routes/` may import from `lib/` and `db/`. `lib/` may import from `db/` and
`config/`. `db/` may import only from `config/`. Anything else is a layering
violation and must be justified in the PR description.

---

## 3. File organisation

In addition to the root rules:

- **`routes/<resource>.ts`** — one Express router per top-level resource
  (`auth`, `intelligence`, `ussd`, `voice`, `sms`, `openData`, `chat`).
  Demo and test routes live under `routes/demo/` and `routes/test/`.
- **`lib/<domain>/`** — when a domain has ≥ 5 files, switch from a flat
  `lib/<domain>.ts` to `lib/<domain>/index.ts` + sibling files.
- **`lib/schemas/`** — every zod schema that crosses the network boundary
  lives here, one file per resource. The schema is the single source of
  truth for both validation and TS type inference.

---

## 4. Documentation specifics

### 4.1 JSDoc style

Use `/** ... */` block comments above every documented item. Single-line
docs are fine for one-line summaries:

```ts
/** Head of cattle. 0 if unknown or not owned. */
cattle: number;
```

Multi-line docs use the structure shown in the root document. The `@param`
list uses **em-dash** between the parameter name and the description, not a
colon — it scans better in IDE hover popups.

### 4.2 What to NEVER export

- `console.log` wrappers
- `any`-typed helpers
- Test fixtures
- Database row types that escape the `db/` layer

If you find yourself wanting to export one of these, the design is wrong —
rework the boundary instead.

### 4.3 Request and response types

Every route exports both the request body type and the response type. They
are the contract that the web client depends on:

```ts
/** POST /api/intelligence/brief — request body. */
export interface IntelligenceBriefRequest { ... }

/** POST /api/intelligence/brief — response body. */
export interface IntelligenceBriefResponse { ... }
```

If a route shares types with another route, hoist the shared types into
`lib/schemas/` — never duplicate.

---

## 5. Async / error handling

- All async route handlers must call `next(err)` (Express 5) or throw a
  typed `HttpError`. Never swallow with `.catch(() => null)`.
- The global error handler in `src/middlewares/errorHandler.ts` is the only
  place that formats error responses — never return a 5xx ad-hoc from a
  handler.
- Timeouts: every outbound HTTP call goes through `src/lib/fetchWithTimeout.ts`,
  not bare `fetch`. No unbounded timeouts on the request path.

---

## 6. Logging

Use the project logger (`src/lib/logger.ts`), never `console.log`. Each log
line must include a stable set of context fields:

```ts
logger.info({ tenantId, ward, droughtGrade }, "computed drought score");
```

Never log secrets, JWTs, raw phone numbers, or full request bodies.

---

## 7. Testing

- `tests/unit/` for pure logic
- `tests/integration/` for routes (uses an in-memory Postgres via the test
  harness in `tests/integration/setup.ts`)
- `tests/e2e/` for full-stack scenarios against a dockerised stack

Every public function in `lib/` has at least one unit test. Every route has
at least one integration test that exercises both the success and the
"upstream degraded" paths.