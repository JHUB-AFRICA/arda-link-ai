#!/usr/bin/env node
// Refresh src/lib/data/wpdxIsiolo.ts from the live WPDx SODA API.
//
// Usage:  node ardalink-api/scripts/pull-wpdx.mjs
//
// Overwrites the snapshot in place. Commit the diff to record what WPDx
// looked like the day we pulled — the herder-facing helpers key off the
// static snapshot, not a live call, so freshness of this file matters.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "lib", "data", "wpdxIsiolo.ts");

// WPDx Plus dataset ID. Fields discovered via
//   curl 'https://data.waterpointdata.org/resource/eqje-vguj.json?country_id=KEN&$limit=1'
const ENDPOINT = "https://data.waterpointdata.org/resource/eqje-vguj.json";
const COUNTY = "Isiolo";
const COLS = [
  "wpdx_id",
  "clean_adm1",
  "clean_adm2",
  "clean_adm3",
  "lat_deg",
  "lon_deg",
  "water_source_clean",
  "water_tech_clean",
  "facility_type",
  "status_clean",
  "status_id",
  "report_date",
  "install_year",
  "management_clean",
  "pay",
  "is_latest",
];

const url = new URL(ENDPOINT);
url.searchParams.set("clean_adm1", COUNTY);
url.searchParams.set("$limit", "500");
url.searchParams.set("$select", COLS.join(","));

console.log(`→ Fetching WPDx for ${COUNTY}: ${url}`);
const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) {
  console.error(`WPDx fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const rows = await res.json();
console.log(`  ${rows.length} rows returned`);

function q(v) {
  if (v === null || v === undefined) return "null";
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const stats = {
  byWard: {},
  byStatus: {},
  bySource: {},
};
for (const r of rows) {
  const w = r.clean_adm3 ?? "?";
  const s = r.status_clean ?? "?";
  const src = r.water_source_clean ?? "?";
  stats.byWard[w] = (stats.byWard[w] ?? 0) + 1;
  stats.byStatus[s] = (stats.byStatus[s] ?? 0) + 1;
  stats.bySource[src] = (stats.bySource[src] ?? 0) + 1;
}
const summarise = (obj) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

const now = new Date().toISOString().slice(0, 10);
const banner = `// AUTO-GENERATED from WPDx (Water Point Data Exchange) on ${now}.
// SODA endpoint: ${ENDPOINT}
// Query:         ?clean_adm1=${COUNTY} (returned ${rows.length} rows)
// Re-pull with:  node ardalink-api/scripts/pull-wpdx.mjs
//
// Source: WPDx Plus dataset (eqje-vguj), (C) Water Point Data Exchange, CC-BY 4.0.
// Attribution required when re-publishing.
//
// Snapshot stats:
//   Wards:   ${summarise(stats.byWard)}
//   Status:  ${summarise(stats.byStatus)}
//   Source:  ${summarise(stats.bySource)}
//
// The stale/sparse coverage IS the point ArdaLink is trying to fix — herder
// calls fill the gap between formal water-point surveys. Treat this as a
// baseline; ground_truth_reports carry fresher status.
`;

const emit = [];
emit.push(banner);
emit.push("");
emit.push("export interface WpdxPoint {");
emit.push("  wpdxId: string;");
emit.push("  county: string | null;");
emit.push("  subCounty: string | null;");
emit.push("  ward: string | null;");
emit.push("  lat: number;");
emit.push("  lon: number;");
emit.push("  waterSource: string | null;");
emit.push("  waterTech: string | null;");
emit.push("  facilityType: string | null;");
emit.push("  statusClean: string | null;");
emit.push("  reportDate: string | null;");
emit.push("  installYear: string | null;");
emit.push("  management: string | null;");
emit.push("  pay: string | null;");
emit.push("  isLatest: boolean;");
emit.push("}");
emit.push("");
emit.push(`export const WPDX_ISIOLO: readonly WpdxPoint[] = Object.freeze([`);
for (const r of rows) {
  emit.push("  {");
  emit.push(`    wpdxId: ${q(r.wpdx_id)},`);
  emit.push(`    county: ${q(r.clean_adm1)},`);
  emit.push(`    subCounty: ${q(r.clean_adm2)},`);
  emit.push(`    ward: ${q(r.clean_adm3)},`);
  emit.push(`    lat: ${Number(r.lat_deg ?? 0)},`);
  emit.push(`    lon: ${Number(r.lon_deg ?? 0)},`);
  emit.push(`    waterSource: ${q(r.water_source_clean)},`);
  emit.push(`    waterTech: ${q(r.water_tech_clean)},`);
  emit.push(`    facilityType: ${q(r.facility_type)},`);
  emit.push(`    statusClean: ${q(r.status_clean)},`);
  emit.push(`    reportDate: ${q(r.report_date)},`);
  emit.push(`    installYear: ${q(r.install_year)},`);
  emit.push(`    management: ${q(r.management_clean)},`);
  emit.push(`    pay: ${q(r.pay)},`);
  emit.push(`    isLatest: ${r.is_latest === true || r.is_latest === "true" ? "true" : "false"},`);
  emit.push("  },");
}
emit.push(`]) as readonly WpdxPoint[];`);
emit.push("");

writeFileSync(OUT, emit.join("\n"));
console.log(`→ Wrote ${OUT}`);
