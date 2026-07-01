/**
 * hooks — single import surface for every data hook the Choropleth
 * orchestrator and its sub-components need.
 *
 * Public surface:
 *   - {@link useChoroplethData}  — bundle of all data hooks in one call
 *   - re-exported type aliases for the shapes consumed by sub-components
 *
 * Depends on: @workspace/api-client-react (the typed React-Query hooks),
 * local types for the Isiolo wards GeoJSON shape.
 *
 * Side effects: React Query network requests via the upstream hooks.
 */
import {
  useWardAggregates,
  useWardPresets,
  useRankings,
  useInsights,
  useAlertMarkers,
  useTimeTravel,
  usePastoralistPins,
  useReportPins,
  type ChoroplethMetric,
  type TimeSlice,
  type PastoralistPin,
  type ReportPin,
  type AlertMarker,
} from "@workspace/api-client-react";

/** Geographic feature collection for the 10 Isiolo wards. */
export interface IsioloWardsFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id?: number;
    properties: Record<string, unknown>;
    geometry: {
      type: "Polygon" | "MultiPolygon";
      coordinates: number[][][] | number[][][][];
    };
  }>;
}

/** Ward-aggregate shape consumed by the panels and the choropleth layer. */
export type WardAggregates = {
  byWard: Record<string, number | null>;
  unit: string;
} | null;

/** A single ranking row, as returned by the rankings endpoint. */
export type RankingRow = {
  county: string;
  value: number | null;
  rank: number;
  normalised: number;
};

/** Payload of the time-travel endpoint. */
export type TimeTravelData = {
  series: Record<string, Record<string, number | null>>;
  slice_labels: Record<string, string>;
} | null;

/** Payload of the insights endpoint. */
export type InsightsData = {
  bullets: string[];
  generatedAt: string;
} | null;

/** All data the Choropleth renders, returned in one bundle. */
export type ChoroplethData = {
  wardAggregates: WardAggregates;
  wardPresets: {
    wards: Array<{ name: string; displayName: string; isDemoHome: boolean }>;
  } | null;
  rankings: { rows: RankingRow[]; metric: string } | null;
  insights: InsightsData;
  alerts: { count: number; markers: AlertMarker[] } | null;
  timeTravel: TimeTravelData;
  pastoralistPins: { count: number; pins: PastoralistPin[] } | null;
  reportPins: { count: number; pins: ReportPin[] } | null;
};

/**
 * Fetch every data source the Choropleth needs in one call.
 *
 * All hooks are keyed by `(metric, slice)` so a switch in either
 * triggers a refetch. The rankings / insights / time-travel hooks
 * are scoped to Isiolo via the `["ISIOLO"]` filter — the only
 * county in product scope.
 *
 * @param metric Active metric on the choropleth.
 * @param slice  Active time slice.
 */
export function useChoroplethData(
  metric: ChoroplethMetric,
  slice: TimeSlice,
): ChoroplethData {
  const wardAggregatesQuery = useWardAggregates(metric, slice);
  const wardPresetsQuery = useWardPresets();
  const rankingsQuery = useRankings(metric, slice, ["ISIOLO"]);
  const insightsQuery = useInsights(slice, ["ISIOLO"]);
  const alertsQuery = useAlertMarkers(slice);
  const timeTravelQuery = useTimeTravel(metric, ["ISIOLO"]);
  const pastoralistPinsQuery = usePastoralistPins();
  const reportPinsQuery = useReportPins(slice);

  return {
    wardAggregates: wardAggregatesQuery.data
      ? { byWard: wardAggregatesQuery.data.byWard, unit: wardAggregatesQuery.data.unit }
      : null,
    wardPresets: wardPresetsQuery.data ?? null,
    rankings: rankingsQuery.data
      ? { rows: rankingsQuery.data.rows, metric: rankingsQuery.data.metric }
      : null,
    insights: insightsQuery.data
      ? { bullets: insightsQuery.data.bullets, generatedAt: insightsQuery.data.generatedAt }
      : null,
    alerts: alertsQuery.data
      ? { count: alertsQuery.data.count, markers: alertsQuery.data.markers }
      : null,
    timeTravel: timeTravelQuery.data
      ? { series: timeTravelQuery.data.series, slice_labels: timeTravelQuery.data.slice_labels }
      : null,
    pastoralistPins: pastoralistPinsQuery.data
      ? { count: pastoralistPinsQuery.data.count, pins: pastoralistPinsQuery.data.pins }
      : null,
    reportPins: reportPinsQuery.data
      ? { count: reportPinsQuery.data.count, pins: reportPinsQuery.data.pins }
      : null,
  };
}

// Re-export the upstream types so sub-components don't need to reach
// into @workspace/api-client-react directly.
export type { PastoralistPin, ReportPin, AlertMarker };