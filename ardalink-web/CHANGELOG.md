# Changelog

All notable changes are documented here.

## [Unreleased]

## [0.2.0] - 2026-07-14

### Added

- Choropleth refactor: orchestrator (`Choropleth/index.tsx`) + 4 map
  layers (`WardsLayer`, `PastoralistPinsLayer`, `ReportPinsLayer`,
  `WardDetailLayer`, `AlertMarkersLayer`) + 4 analysis panels
  (`Comparison`, `InsightsPanel`, `SeverityBars`, `TimeTravelSparkline`,
  `Sparkline`) + `Header`/`Hud`/`Legend`/`Skeleton` components +
  `hooks.ts` + `utils.ts` + `README.md` — deleted the 1,593-line
  god-file `dashboard/src/components/Choropleth.tsx`
- NDVI history + 14-day rainfall forecast time-series panel
  (`TimeSeriesPanel.tsx`)
- Ops sections: `LeadsSection.tsx`, `CallbackLog.tsx`,
  `GroundTruthSection.tsx`, `PastoralistsTab.tsx`, `DemosTab.tsx`
- ChatModal + deterministic call component (`DeterministicCall.tsx`)
- `dashboard/src/hooks/useCallToken.ts` + `useSatelliteCheck.ts`
- `dashboard/src/lib/dashboard-colors.ts` (brand-palette enforcement)
- `talk/src/lib/consent.ts` (opt-in/opt-out state machine)
- `@workspace/api-client-react` expanded: `useWardDetail` hook +
  `WardDetail` types
- Tenant display name + per-ward colour rules
- Per-cell NDVI heatmap layer + WardMapLive polish
- Vite tunnel-host allowlist + `/api` and `/ws` proxy to local API

### Fixed

- Tunnel-origin guard tightened (`originGuard.ts` change reflected in
  api) — `forecast` no longer 500s when anomaly missing
- Choropleth typecheck cleanups (uncovered by the refactor)

## [0.1.0] - 2026-06-21

### Added

- pnpm workspace with `dashboard/` and `talk/` packages
- React 19 + Vite + Tailwind v4 scaffolds for both apps
- Vitest + Testing Library smoke tests
- 8-doc CTO navigation under `docs/`
- CI gating (prettier + tsc + vitest)
- Dependabot, PR/issue templates, SECURITY.md

### Notes

- Live components migrate from `JHUB-AFRICA/arda-link-ai` in Phase 3.
- Generated API hooks land in v0.2.0.
