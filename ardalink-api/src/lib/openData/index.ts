/**
 * Open-source data layer barrel — re-exports the full public surface
 * of the domain modules in this directory. External callers should
 * always import from here (`./openData/index.js`), never reach into a
 * leaf module directly.
 *
 * Wraps three families of free, key-less, attribution-required APIs:
 * Open-Meteo (forecast/archive/air-quality), Microsoft Planetary
 * Computer STAC, and the county-level insights/rankings computed from
 * our own ground-truth data. Split out of a single 1065-line
 * `openData.ts`, mirroring the `src/lib/llm/` barrel pattern already
 * used in this codebase.
 */

export {
  type HistoricalClimateWindow,
  fetchHistoricalClimateWindow,
  fetchYearOverYearClimate,
} from "./historicalClimate.js";

export {
  type AirQualitySnapshot,
  fetchAirQualitySnapshot,
} from "./airQuality.js";

export {
  type PlanetaryComputerCollection,
  type StacItemSummary,
  discoverPlanetaryComputer,
  discoverAllForWard,
} from "./planetaryComputer.js";

export {
  type TimeSlice,
  TIME_SLICE_LABELS,
  timeSliceStart,
} from "./timeSlices.js";

export {
  type CountyPreset,
  COUNTY_PRESETS,
  DEFAULT_MAIN_COUNTIES,
} from "./countyPresets.js";

export {
  type PerCountyAggregate,
  computePerCountyAggregates,
  computeInsights,
  computeRankings,
  computeAlertMarkers,
} from "./countyInsights.js";

export {
  type OpenDataSourceInfo,
  OPEN_DATA_SOURCES,
  probeOpenDataSources,
} from "./sourceRegistry.js";
