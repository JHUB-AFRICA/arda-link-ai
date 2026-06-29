// AUTO-GENERATED from WPDx (Water Point Data Exchange) on 2026-05-25.
// Pulled inside a ~15 km buffer around the Bula Pesa Ward bbox
// (WARD: 0.28284..0.42715°N, 37.51149..37.65473°E
//  FETCH: 0.148..0.562°N, 37.376..37.790°E).
// Re-pull with: pnpm --filter @workspace/scripts run pull-wpdx
//
// Source: WPDx-Basic (dataset jfkt-jmqa), © Water Point Data Exchange, CC-BY 4.0.
// Attribution required when re-publishing.
//
// Each point carries `insideWard`: true means it falls inside the ward bbox
// (treat as a regular ward water point); false means it sits in the wider
// catchment (use only when answering "where's the nearest WPDx-verified one?"
// and always disclose it's outside the ward).

export interface WpdxWaterPoint {
  wpdxId: string;
  name: string | null;
  lat: number;
  lon: number;
  quadrant: "NW" | "NE" | "SW" | "SE";
  area: string;
  source: string | null;
  waterSource: string | null;
  waterTech: string | null;
  facilityType: string | null;
  statusClean: string | null;
  reportDate: string | null;
  adm2: string | null;
  adm3: string | null;
  datasetTitle: string | null;
  insideWard: boolean;
}

export const BULA_PESA_WATER_POINTS_WPDX: readonly WpdxWaterPoint[] =
  Object.freeze([]) as readonly WpdxWaterPoint[];
