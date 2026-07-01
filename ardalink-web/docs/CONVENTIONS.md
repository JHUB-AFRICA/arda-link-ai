# ArdaLink Web — code conventions (addendum)

This is a **service-specific addendum** to the root
[`CONVENTIONS.md`](../../CONVENTIONS.md). Read the root document first —
this file only covers what is unique to the React 19 / Vite 7 / TypeScript
dashboard + talk + typed-fetch monorepo.

---

## 1. Tooling

| Tool | Version | Purpose | Where |
|---|---|---|---|
| React | 19 | UI framework | `package.json` |
| Vite | 7 | Dev server + bundler | `vite.config.ts` |
| TypeScript | 5.x | Source language | `tsconfig.base.json` |
| pnpm | 9 | Workspace + install | `pnpm-workspace.yaml` |
| Tailwind | 4 | Styling | `tailwind.config.ts` |
| vitest + Testing Library | latest | Unit + component tests | `*.test.tsx` |
| prettier | latest | Formatter | `.prettierrc` |

Run before pushing:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run format:check
pnpm run build       # all three: dashboard, talk, api-client-react
```

---

## 2. Workspace layout

This is a pnpm workspace. Treat each subdirectory as its own package:

```
ardalink-web/
├── dashboard/              ← Operator dashboard (private, authenticated)
├── talk/                   ← Public browser Talk app (anonymous)
├── packages/
│   └── api-client-react/   ← Typed hooks + client shared by both apps
└── pnpm-workspace.yaml
```

Cross-package imports **must** go through the workspace package, not through
relative paths:

```ts
// ✅ Correct
import { useBrief } from "@workspace/api-client-react";

// ❌ Wrong — creates an undeclared coupling
import { useBrief } from "../../packages/api-client-react/src/hooks/useBrief";
```

---

## 3. Layering

Within each app (`dashboard/`, `talk/`):

```
pages/                  ← Route components, top of the tree
   │
   ▼
features/               ← Domain-specific UI (Brief, Chat, Map…)
   │                       each may have its own components/ + hooks/
   ▼
components/             ← Shared UI primitives
   │
   ▼
lib/                    ← Pure helpers (no React)
   │
   ▼
hooks/                  ← Generic React hooks (no app state)
```

`features/` may import from `components/`, `lib/`, `hooks/`. It may **not**
import from another `features/` directory — if two features need the same
component, hoist it to `components/`.

---

## 4. Components

### 4.1 When to make a component

Pull JSX into a named component when **any** of these holds:

- It's used more than once
- It's longer than ~40 lines
- It has its own props / state / effects
- It would benefit from a name in JSX (`<DroughtGradeBadge>` vs an inline
  ternary)

A single-use component over 200 lines is fine **only** if it's split into
internal components within the same file — see the root rule on file size.

### 4.2 Props

Always define an explicit `Props` type. Never use `React.FC` — pass props
generically and let inference do its job:

```tsx
type ChoroplethProps = {
  wards: IsioloWardsFeatureCollection;
  selectedWardId: string | null;
  onSelectWard: (wardId: string) => void;
};

export function Choropleth({ wards, selectedWardId, onSelectWard }: ChoroplethProps) {
  ...
}
```

### 4.3 Hooks

- One responsibility per hook. If your `useFoo` returns ten things, split it.
- Hooks that touch the network live in `packages/api-client-react/` and are
  the **only** place that imports `@tanstack/react-query` directly.

---

## 5. State

| State type | Where it lives | Why |
|---|---|---|
| Server state (API data) | React Query via the typed hooks | Cache, dedupe, refetch |
| Form state | Local `useState` or a small `useReducer` | Cheap, local, ephemeral |
| Auth / tenant context | React Context (`AuthGate`) | Truly global, low write frequency |
| Cross-tab ephemeral state | `localStorage` + a storage event listener | Survives reload, syncs tabs |
| URL state | Router params / search params | Shareable, deep-linkable |

Do **not** put server state into Redux, Zustand, or Context. Reach for React
Query first.

---

## 6. Styling

- Tailwind utility classes are the default.
- Co-located component styles via the `cn()` helper from
  `lib/cn.ts` for conditional class composition.
- No inline `style={{ ... }}` except for genuinely dynamic values
  (positions, computed transforms).
- Brand palette is enforced by CI — see the `marketing` job in
  `.github/workflows/monorepo-ci.yml`. New colours must be added there first.

---

## 7. Accessibility

Every interactive component:

- Has a visible focus state (Tailwind `focus-visible:` variant).
- Has an accessible name (`aria-label`, visible label, or visible text).
- Renders the correct semantic element (`<button>` not `<div onClick>`,
  `<a>` for navigation).
- Works without a mouse — keyboard navigable.

CI does not yet enforce this — reviewers must.

---

## 8. Testing

- Component tests live next to the component: `Choropleth.tsx` →
  `Choropleth.test.tsx`.
- Hooks: `useFoo.ts` → `useFoo.test.ts`.
- Pure helpers in `lib/`: standard vitest unit tests.
- Network-touching code uses MSW (`src/mocks/`) — never hit a real API in a
  unit test.

Snapshot tests are discouraged — they ossify the UI and discourage the kind
of refactoring this conventions document is here to enable. Use them only
for genuinely stable, decorative output (icons, generated SVGs).

---

## 9. Performance

- Code-split at the route level (`React.lazy` + `Suspense`).
- Lists over ~50 items: virtualise with `react-window` or equivalent.
- Heavy map / chart components: dynamic `import()` so they don't bloat the
  initial bundle.
- Don't fetch on every render. Use React Query's caching and your hook's
  stale-time defaults.