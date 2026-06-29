# `@workspace/api-client-react`

Typed React Query hooks and a small fetch helper for the ArdaLink API.
Shared by the **operator dashboard** and the **public Talk** app.

- **Status**: 0.1.0 — first release that ships with tests and an MIT
  licence. Used in production by the dashboard and the Talk app.
- **Runtime**: browser (ESM). Depends on `react@19.1` and
  `@tanstack/react-query@^5.90`.
- **No build step** — the package is consumed directly via TypeScript
  source through the pnpm workspace link. The dashboard's Vite config
  handles bundling.

---

## Install

This package lives in `ardalink-web/packages/api-client-react/` and is
linked into the workspace by name. **Do not `npm install` it** — add
the peer deps to the consumer's `package.json` instead:

```jsonc
// ardalink-web/dashboard/package.json  (already present)
{
  "dependencies": {
    "@tanstack/react-query": "^5.90.0"
  },
  "peerDependencies": {
    "react": "19.1.0",
    "@tanstack/react-query": "^5.90.0"
  }
}
```

Then import:

```tsx
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  useGetStatus,
  useListPastoralists,
  mintCallToken,
  readToken,
} from "@workspace/api-client-react";
```

---

## What you get

### Fetch helper

`apiFetch(path, init)` is the only thing that should ever talk to the
HTTP API directly. It:

- attaches `Authorization: Bearer <jwt>` from localStorage when
  present,
- sets `content-type: application/json` for bodies,
- throws `Error("<status>: <body>")` on non-2xx,
- returns `undefined` on a 204 No Content.

The token lookup order is:

1. `localStorage["ardalink.jwt"]`
2. `?token=…` query parameter (demo link sharing)
3. `#token=…` URL hash (copy-paste-able links)

Cases (2) and (3) **persist the token to localStorage** so the URL can
be sanitised later. Use the exported `readToken()` helper to read the
current token without triggering the persistence side-effect.

### Typed hooks

Every endpoint the dashboard or Talk app calls has a corresponding
`useXxx` hook:

| Hook | Endpoint |
|---|---|
| `useGetStatus` | `GET /api/status` |
| `useGetForecast` | `GET /api/forecast` |
| `useListPastoralists` | `GET /api/pastoralists` |
| `useCreatePastoralist` | `POST /api/pastoralists` |
| `useDeletePastoralist` | `DELETE /api/pastoralists/:id` |
| `useListGroundTruthRecent` | `GET /api/ground-truth/recent?limit=` |
| `useGetGroundTruthSummary` | `GET /api/ground-truth/summary` |
| `useIntelligenceBrief` | `GET /api/intelligence/brief?lang=&regenerate=` |
| `useTriggerCheck` | `POST /api/trigger-check` |
| `useChatWithLand` | `POST /api/chat` |
| `useMintCallToken` | `POST /api/call-tokens` |
| `usePerCountyAggregates(metric)` | `GET /api/open-data/geo/per-county-aggregates` |
| `usePerCountyAggregatesSlice(metric, slice)` | `GET …&slice=` |
| `useRankings(metric, slice, counties)` | `GET /api/open-data/geo/rankings` |
| `useInsights(slice, counties)` | `GET /api/open-data/geo/insights` |
| `useAlertMarkers(slice)` | `GET /api/open-data/geo/alert-markers` |
| `useTimeTravel(metric, counties)` | `GET /api/open-data/geo/time-travel` |
| `useCountyPresets` | `GET /api/open-data/geo/county-presets` |
| `useWardPresets` | `GET /api/open-data/geo/ward-presets` |
| `useWardAggregates(metric, slice)` | `GET /api/open-data/geo/ward-aggregates` |
| `usePastoralistPins` | `GET /api/open-data/geo/pastoralist-pins` |
| `useReportPins(slice)` | `GET /api/open-data/geo/report-pins` |

Each hook has a stable query-key helper (`getXxxQueryKey`) so you can
invalidate it from another query or from a websocket event.

### Token management

```ts
import { setToken, clearToken, readToken } from "@workspace/api-client-react";

setToken("eyJ...");          // store the JWT for next requests
clearToken();                // forget it (logout)
readToken();                 // read it (also resolves from URL hash)
```

`readToken()` is exported as the stable, public way to look up the JWT.
The internal `getToken()` does the URL-hash persistence as a side-effect
when the source is the hash.

---

## Environment

`apiFetch` reads `import.meta.env.VITE_API_BASE` (Vite). When unset,
requests go to the same origin as the page. For local dev:

```env
# ardalink-web/dashboard/.env.local
VITE_API_BASE=http://localhost:3000
```

---

## Test

```bash
pnpm --filter @workspace/api-client-react run test
```

The suite covers three contracts:

1. **`apiFetch` Bearer-token injection** — localStorage token is sent
   on every request; no token → no Authorization header; body sets
   `content-type: application/json` automatically.
2. **`readToken` URL-hash persistence** — localStorage wins; URL hash
   is read and persisted; query beats hash; tenant param is also
   persisted.
3. **Error surfacing** — non-2xx throws `<status>: <body>`; 503 from a
   missing upstream provider bubbles up unchanged; 204 returns
   `undefined`.

A test-only `__apiFetch` export is exposed so the 204 short-circuit can
be asserted directly. Application code must not use it.

---

## License

[MIT](../../../../LICENSE) — Copyright (c) 2026 ArdaLink.