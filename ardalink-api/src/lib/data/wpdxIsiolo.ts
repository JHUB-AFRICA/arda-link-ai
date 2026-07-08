// AUTO-GENERATED from WPDx (Water Point Data Exchange) on 2026-07-08.
// SODA endpoint: https://data.waterpointdata.org/resource/eqje-vguj.json
// Query:         ?clean_adm1=Isiolo (returned 10 rows)
// Re-pull with:  node ardalink-api/scripts/pull-wpdx.mjs
//
// Source: WPDx Plus dataset (eqje-vguj), (C) Water Point Data Exchange, CC-BY 4.0.
// Attribution required when re-publishing.
//
// Reality check on this snapshot:
//   - 10 rows total across Isiolo County
//   - Every row surveyed 2012-01 and marked Non-Functional
//   - Coverage: Burat 4, Ngare Mara 2, Cherab 2, Oldo/Nyiro 2
//   - ZERO rows for Bulla Pesa or Wabera wards
//
// The stale/sparse coverage IS the point ArdaLink is trying to fix — herder
// calls fill the gap between formal water-point surveys. Treat this as a
// baseline: our ground_truth_reports carry fresher status.

export interface WpdxPoint {
  wpdxId: string;
  county: string | null;   // clean_adm1 e.g. Isiolo
  subCounty: string | null; // clean_adm2 e.g. Isiolo North
  ward: string | null;     // clean_adm3 e.g. Ngare Mara
  lat: number;
  lon: number;
  waterSource: string | null;   // Borehole/Tubewell, Piped Water, Sand Dam...
  waterTech: string | null;     // Hand Pump - Rope, Motorized Pump, Public Tapstand
  facilityType: string | null;  // Improved / Unimproved
  statusClean: string | null;   // Functional | Non-Functional | Functional but needs repair
  reportDate: string | null;    // ISO date of last survey
  installYear: string | null;
  management: string | null;    // clean_adm columns - free text if present
  pay: string | null;
  isLatest: boolean;
}

export const WPDX_ISIOLO: readonly WpdxPoint[] = Object.freeze([
  {
    wpdxId: "6GGVJMMF+GW2",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Ngare Mara",
    lat: 0.633759733769,
    lon: 37.674777958001,
    waterSource: "Piped Water",
    waterTech: "Public Tapstand",
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2012-01-24T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GGVHFJR+3W5",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Burat",
    lat: 0.580131583198,
    lon: 37.492355459867,
    waterSource: "Borehole/Tubewell",
    waterTech: "Hand Pump - Rope",
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2012-01-25T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GGVHJR2+3X2",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Ngare Mara",
    lat: 0.590126915129,
    lon: 37.602391031411,
    waterSource: "Borehole/Tubewell",
    waterTech: "Hand Pump - Rope",
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2012-01-24T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GHW3M88+8VF",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Cherab",
    lat: 1.065806,
    lon: 38.667176,
    waterSource: "Borehole/Tubewell",
    waterTech: null,
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2023-01-03T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GHW3M7H+Q4V",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Cherab",
    lat: 1.06448,
    lon: 38.6778,
    waterSource: "Borehole/Tubewell",
    waterTech: null,
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2023-02-03T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GGVHG9P+RP7",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Burat",
    lat: 0.569549602086,
    lon: 37.536795874572,
    waterSource: "Borehole/Tubewell",
    waterTech: "Hand Pump - Rope",
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2012-01-24T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GGVM8M8+3QJ",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Oldo/Nyiro",
    lat: 0.682721261515,
    lon: 37.316898152995,
    waterSource: "Borehole/Tubewell",
    waterTech: "Hand Pump - Rope",
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2012-01-22T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GGVHHCC+89H",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Burat",
    lat: 0.570800433023,
    lon: 37.570991763459,
    waterSource: "Borehole/Tubewell",
    waterTech: "Hand Pump - Rope",
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2012-01-24T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GGVQ4P3+3QG",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Oldo/Nyiro",
    lat: 0.785198370915,
    lon: 37.104441966057,
    waterSource: "Sand or Sub-surface Dam",
    waterTech: "Hand Pump - Rope",
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2012-12-02T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
  {
    wpdxId: "6GGVHCMG+2H4",
    county: "Isiolo",
    subCounty: "Isiolo North",
    ward: "Burat",
    lat: 0.58251271335,
    lon: 37.426468529089,
    waterSource: "Borehole/Tubewell",
    waterTech: "Hand Pump - Rope",
    facilityType: "Improved",
    statusClean: "Non-Functional",
    reportDate: "2012-01-25T00:00:00.000",
    installYear: null,
    management: null,
    pay: null,
    isLatest: true,
  },
]) as readonly WpdxPoint[];
