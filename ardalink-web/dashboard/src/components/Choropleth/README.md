# Choropleth module

The interactive ward-level choropleth for Isiolo County. The operator's
job here is **diagnose a specific ward** — pick a metric, pick a time
slice, click a ward, read the four panels. That's it.

## Architecture

```
Choropleth/index.tsx              ← Orchestrator. Owns metric, slice,
                                    layer-toggle, selected-ward state.
   │
   ├─ Header.tsx                   ← Control bar. Metric + slice +
                                    layer toggles. No view toggle,
                                    no tour button.
   │
   ├─ WardsLayer.tsx               ← GeoJSON choropleth. Click a ward
   │                                 → onSelectWard(name).
   ├─ PastoralistPinsLayer.tsx     ← Herder CircleMarkers.
   ├─ ReportPinsLayer.tsx          ← Ground-truth markers.
   ├─ AlertMarkersLayer.tsx        ← Alert markers, jittered around
   │                                 the Isiolo centroid.
   │
   ├─ Legend.tsx                   ← Colour scale + selected-ward readout.
   ├─ Hud.tsx                      ← Time-slice indicator (top-right).
   ├─ Skeleton.tsx                 ← Loading placeholder used by panels.
   │
   ├─ Panels/Comparison.tsx        ← Ward table; selected ward highlighted.
   ├─ Panels/SeverityBars.tsx      ← Ranked severity bars.
   ├─ Panels/Sparkline.tsx         ← Single-line SVG mini-trend.
   ├─ Panels/TimeTravelSparkline.tsx ← One Sparkline row per ward.
   └─ Panels/InsightsPanel.tsx     ← Narrative bullets + alert count.

hooks.ts                            ← useChoroplethData + type aliases.
utils.ts                            ← Pure helpers (MetricMeta, colour
                                      scales, Leaflet style, HTML escape).
```

## Public API

The module exports a single named component plus a default export:

```ts
import { Choropleth } from "@/components/Choropleth";
// or
import Choropleth from "@/components/Choropleth";
```

### Props

| Prop | Type | Required | Purpose |
|---|---|---|---|
| `selectedWardId` | `string \| null` | yes | Ward the operator clicked. Drives map outline + Comparison highlight. |
| `onSelectWard` | `(id: string \| null) => void` | yes | Called when the operator clicks a ward. Pass `null` to deselect. |
| `initialMetric` | `ChoroplethMetric` | no (`"bcs"`) | Metric on first render. |
| `initialSlice` | `TimeSlice` | no (`"30d"`) | Time slice on first render. |

## Data flow

```
dashboard.tsx                (owns selectedWardId)
     │
     ▼
Choropleth/index.tsx         (metric, slice, layer toggles, fetch wards)
     │
     ├── useChoroplethData   → 8 typed React-Query hooks
     │
     ▼
Sub-components               (pure render from props)
```

The selected ward is a **controlled prop pair**. The parent owns the
state. The Choropleth only emits selection events via `onSelectWard`.

Pressing `Esc` while focused inside the Choropleth clears the selection
(handled in the orchestrator's keydown effect).

## What this module does NOT do

- No Kenya-counties view. The wider Kenya choropleth was out of product
  scope; the rankings / insights / time-travel hooks are scoped to
  `["ISIOLO"]` because that's the only county in scope.
- No camera tour animation. The "Tour wards" button and the
  `dispatchFlyToWard` / `WardsStoreUpdater` / `MapBridge` helpers were
  demo theatre, not operator workflow.
- No module-level side store. Previously the active map and wards were
  kept on `let` bindings in module scope so the tour button could reach
  them. With the tour gone, every layer reads its props directly.

## Verification checklist (before merging)

- [ ] Every panel renders with real data (no mock fallback).
- [ ] Map click → `onSelectWard` fires with the correct ward ID.
- [ ] Map click on selected ward → `onSelectWard(null)` (deselect).
- [ ] `Esc` clears the current selection.
- [ ] HUD reflects current `slice` value.
- [ ] Skeleton appears within 200 ms of mount when GeoJSON is loading.
- [ ] Error state appears if the wards fetch fails.
- [ ] Switching metric re-colours wards without remounting the map.
- [ ] Switching slice re-fetches aggregates without remounting the map.
- [ ] Layer toggles hide/show without re-fetching.
- [ ] Keyboard: Tab order reaches every interactive control.

## Tests

The error boundary in `ChoroplethErrorBoundary.tsx` has its own test at
`tests/choroplethErrorBoundary.test.tsx`. The Choropleth itself relies
on the wider dashboard tests (`tests/dashboard.test.tsx` and friends)
to exercise the integrated view. Add focused tests for the panels and
layers here as the module grows.