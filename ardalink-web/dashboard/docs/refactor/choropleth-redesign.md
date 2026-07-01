# Choropleth redesign

**Status:** design proposal · **Branch:** `refactor/choropleth-component-split` · **Author:** engineering

## 1. Why this exists

The current `Choropleth.tsx` is 1593 lines and serves several masters at once.
Operators asked for **one** thing: a clear way to diagnose a specific ward.
Everything else in the file either supports that purpose with too much chrome
or distracts from it.

## 2. What we keep, what we drop

| Element | Action | Why |
|---|---|---|
| Isiolo wards layer (10 wards) | **Keep** | The primary visual |
| Pastoralist pins layer | **Keep** | Operator needs to see herders in context |
| Report pins layer | **Keep** | Ground-truth overlay is core signal |
| Alert markers layer | **Keep** | High-signal, low-noise |
| Metric toggle (BCS / NDVI / reports / herd) | **Keep** | Different diagnoses need different metrics |
| Time-slice toggle (30d / 90d / 1y / all) | **Keep** | Trend matters |
| Layer toggle (pins on/off) | **Keep** | Useful for uncluttered view |
| HUD overlay (time-slice indicator) | **Keep** | Non-intrusive context |
| Comparison panel | **Keep, rework** | Ward-vs-ward, not ward-vs-county |
| Severity rankings panel | **Keep** | The triage signal |
| Time-travel sparkline panel | **Keep** | Confirms the trend |
| Insights panel | **Keep** | Narrative context |
| Legend | **Keep** | Required for any choropleth |
| Skeleton + error states | **Keep** | Always |
| **Kenya counties view** | **Drop** | Out of product scope; pulls in 2 hooks + a layer |
| **Tour animation (camera flythrough)** | **Drop** | Demo theatre, not operator workflow |
| **"Start tour" button** | **Drop** | Nothing to start anymore |

## 3. Behaviour changes

### 3.1 No more view toggle

The header drops the `Wards / Counties` toggle. The map's initial centre and
zoom are fixed at the Isiolo extent — no need to fly out.

### 3.2 Comparison becomes ward-vs-ward

The current `ComparisonPanel` compares the selected ward to all 47 other
counties. With the counties view gone, it compares the selected ward to the
**other 9 Isiolo wards**. The panel layout stays the same; only the data
source changes.

### 3.3 Selected ward becomes a controlled prop

The current component reads "selected ward" from a side-store, which is
fragile. After the redesign:

```ts
type ChoroplethProps = {
  /** Ward the operator clicked. Drives map highlight + comparison panel. */
  selectedWardId: string | null;
  /** Called when the operator clicks a different ward. */
  onSelectWard: (wardId: string | null) => void;
};
```

The parent (`dashboard.tsx`) owns the selection. The Choropleth is fully
controlled.

## 4. File structure

Following `CONVENTIONS.md` — one concern per file, README when ≥ 5 files.

```
components/Choropleth/
├── index.tsx                # Public Choropleth export. Orchestrator only.
├── README.md                # Purpose, architecture, data flow, usage.
├── Header.tsx               # Metric + slice + layer toggles. ~120 LOC.
├── Hud.tsx                  # Time-slice indicator overlay. ~50 LOC.
├── Legend.tsx               # Metric colour scale. ~60 LOC.
├── Skeleton.tsx             # Loading + error states. ~80 LOC.
├── WardsLayer.tsx           # 10 Isiolo wards, coloured by metric. ~120 LOC.
├── PastoralistPinsLayer.tsx # Herder markers. ~50 LOC.
├── ReportPinsLayer.tsx      # Ground-truth markers. ~60 LOC.
├── AlertMarkersLayer.tsx    # Alert pins. ~50 LOC.
├── Panels/
│   ├── Comparison.tsx       # Selected ward vs other 9. ~140 LOC.
│   ├── SeverityBars.tsx     # Ranked list. ~80 LOC.
│   ├── TimeTravelSparkline.tsx # ~70 LOC.
│   └── InsightsPanel.tsx    # Narrative insights. ~60 LOC.
├── hooks.ts                 # All data hooks in one place. ~80 LOC.
└── utils.ts                 # styleForWard, valueColor, buildStops,
                             # formatValue, escapeHtml. ~150 LOC.
```

**Target file sizes** — biggest file ≈ 150 LOC. Average ≈ 90 LOC. Total
across the module: roughly the same as today, just organised.

## 5. Data hooks

After dropping the counties view, these hooks are dropped:

- `usePerCountyAggregatesSlice` (no counties)
- `useCountyPresets` (no counties)

These stay:

- `useWardAggregates` — colours the wards
- `useWardPresets` — ward metadata
- `useRankings` — already filtered to `["ISIOLO"]`
- `useInsights` — narrative
- `useAlertMarkers` — alert pins
- `useTimeTravel` — historical series
- `usePastoralistPins` — herder pins
- `useReportPins` — report pins

All consolidated into `Choropleth/hooks.ts` so the orchestrator has a single
import.

## 6. Removed code inventory

The following internals are deleted:

- `CountiesLayer` and its `styleForCounty` helper
- `tourRef` / `setTouring` / `startTour` callback
- The `view === "counties"` branches in the orchestrator
- The "Start tour" button in the header
- The counties branch in `MapContainer` `center`/`zoom`
- The "counties" tile-layer attribution tweak (the wards-only attribution
  becomes the only one)

Net deletion: ~300 LOC of behaviour no one asked for.

## 7. Verification

Before this lands:

- [ ] Every panel still renders with real data (no mock fallback).
- [ ] Map click → `onSelectWard` fires with the correct ward ID.
- [ ] Map click on selected ward → `onSelectWard(null)` (deselect).
- [ ] HUD reflects current `slice` value.
- [ ] Skeleton appears within 200 ms of mount when GeoJSON is loading.
- [ ] Error state appears if either GeoJSON fetch fails.
- [ ] Switching metric re-colours wards without remounting the map.
- [ ] Switching slice re-fetches aggregates without remounting the map.
- [ ] Layer toggles hide/show without re-fetching.
- [ ] Keyboard: Tab order reaches every interactive control.
- [ ] Keyboard: `Esc` deselects the current ward.

## 8. Roll-out

1. Land this PR with the file structure above + new behaviour.
2. Update `ChoroplethErrorBoundary` if its prop shape changes.
3. Update `dashboard.tsx` to pass `selectedWardId` / `onSelectWard`.
4. Delete the old `Choropleth.tsx` (one-line re-export shim during the PR
   window so other consumers don't break — they don't exist today, but
   keeping the shim costs nothing).

No new dependencies. No backend changes. Pure front-end refactor.