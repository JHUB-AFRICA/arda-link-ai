// Memory & learning loop — turns the ground_truth_reports table into live
// context the Realtime AI consults at the start of every call.
//
// Two layers:
//   1. Per-herder memory  — what did THIS phone tell us recently
//   2. Ward-level rollup  — what are ALL herders saying across the ward
//
// Both produce compact, prompt-friendly text blocks. We keep them small
// (~10–20 lines each) so the Realtime token budget stays sane.

import {
  db,
  groundTruthReportsTable,
  type GroundTruthReport,
} from "@workspace/db";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { logger } from "./logger.js";

const HERDER_LOOKBACK = 2; // last N calls for the same phone
const WARD_ROLLUP_DAYS = 7; // ward-level window
const WARD_LOOKBACK_MAX = 200; // safety cap
const MEMORY_FETCH_TIMEOUT_MS = 800; // hard ceiling so call setup never stalls

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn(
        { ms, label },
        "[Memory] fetch exceeded timeout — using fallback",
      );
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.error({ err, label }, "[Memory] fetch threw — using fallback");
        resolve(fallback);
      },
    );
  });
}

// ─── Per-herder memory ──────────────────────────────────────────────────────

function describeReport(r: GroundTruthReport): string {
  const when = new Date(r.timestamp).toISOString().slice(0, 10);
  const where = r.reportedLocation ?? r.reportedQuadrant ?? "unknown area";
  const bits: string[] = [];
  if (r.bcsScore != null) {
    const conf = r.bcsConfidence ? ` (${r.bcsConfidence})` : "";
    bits.push(`BCS ${r.bcsScore.toFixed(1)}${conf}`);
  }
  if (r.offtakeRate) bits.push(`offtake=${r.offtakeRate}`);
  if (r.mortalityRate) bits.push(`mortality=${r.mortalityRate}`);
  if (r.milkProduction) bits.push(`milk=${r.milkProduction}`);
  if (r.waterTrekkingDistance) bits.push(`trek=${r.waterTrekkingDistance}`);
  if (
    r.waterPointName &&
    r.waterPointStatus &&
    r.waterPointStatus !== "unknown"
  ) {
    bits.push(`${r.waterPointName}=${r.waterPointStatus}`);
  }
  if (r.supplementaryFeeding) bits.push(`feed=${r.supplementaryFeeding}`);
  const indicators =
    bits.length > 0 ? bits.join(", ") : "no indicators captured";
  const tag = r.actionTag ? ` · action: ${r.actionTag}` : "";
  return `  • ${when} near ${where} — ${indicators}${tag}`;
}

/**
 * Build a "LAST CONTACT" block for this herder. Returns empty string if
 * there is no prior history (first-time caller, browser demo, etc.).
 */
async function fetchHerderMemoryRaw(phone: string): Promise<string> {
  const rows = await db
    .select()
    .from(groundTruthReportsTable)
    .where(eq(groundTruthReportsTable.phone, phone))
    .orderBy(desc(groundTruthReportsTable.timestamp))
    .limit(HERDER_LOOKBACK);

  if (rows.length === 0) return "";

  const lines = [
    "─── LAST CONTACT WITH THIS HERDER ───",
    `You have spoken with this person before (${rows.length} prior call${rows.length === 1 ? "" : "s"}). Use this to sound continuous — reference what they told you last time naturally ("last time you said the cows were thin near Burat — how are they now?"). Do NOT recite the list back; weave one or two specifics in.`,
    ...rows.map(describeReport),
  ];
  return lines.join("\n");
}

export async function formatHerderMemoryBlock(
  phone: string | null | undefined,
): Promise<string> {
  if (!phone || phone.startsWith("browser-")) return "";
  return withTimeout(
    fetchHerderMemoryRaw(phone),
    MEMORY_FETCH_TIMEOUT_MS,
    "",
    "herder-memory",
  );
}

// ─── Ward-level rollup ──────────────────────────────────────────────────────

type Quadrant = "NW" | "NE" | "SW" | "SE";
const QUAD_NAMES: Record<Quadrant, string> = {
  NW: "Wabera",
  NE: "Ngare Mara",
  SW: "Bulla Pesa town",
  SE: "Kambi Garba",
};

interface QuadRollup {
  reports: number;
  bcsValues: number[];
  mortalityFlags: number; // count of reports with mortality !== "none"
  earlyOfftake: number; // count of reports with offtake === "early"
  milkReduced: number; // count of reports with milk reduced/stopped
  trekOver10: number; // count of reports with over_10km
  waterIssues: Map<string, number>; // waterPointName -> count of problem reports
}

function emptyRollup(): QuadRollup {
  return {
    reports: 0,
    bcsValues: [],
    mortalityFlags: 0,
    earlyOfftake: 0,
    milkReduced: 0,
    trekOver10: 0,
    waterIssues: new Map(),
  };
}

function isProblemStatus(s: string | null): boolean {
  return s === "operational_poor" || s === "not_operational" || s === "dry";
}

/**
 * Build a "WARD GROUND-TRUTH ROLLUP" block — what herders across Bula Pesa
 * have collectively said in the last `WARD_ROLLUP_DAYS` days. Returns empty
 * string if no recent reports.
 */
async function fetchWardRollupRaw(): Promise<string> {
  const since = new Date(Date.now() - WARD_ROLLUP_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(groundTruthReportsTable)
    .where(
      and(
        gte(groundTruthReportsTable.timestamp, since),
        isNotNull(groundTruthReportsTable.reportedQuadrant),
      ),
    )
    .orderBy(desc(groundTruthReportsTable.timestamp))
    .limit(WARD_LOOKBACK_MAX);

  if (rows.length === 0) return "";

  const byQuad: Record<Quadrant, QuadRollup> = {
    NW: emptyRollup(),
    NE: emptyRollup(),
    SW: emptyRollup(),
    SE: emptyRollup(),
  };

  for (const r of rows) {
    const q = r.reportedQuadrant as Quadrant | null;
    if (!q || !(q in byQuad)) continue;
    const bucket = byQuad[q];
    bucket.reports++;
    if (r.bcsScore != null) bucket.bcsValues.push(r.bcsScore);
    if (r.mortalityRate && r.mortalityRate !== "none") bucket.mortalityFlags++;
    if (r.offtakeRate === "early") bucket.earlyOfftake++;
    if (r.milkProduction === "reduced" || r.milkProduction === "stopped")
      bucket.milkReduced++;
    if (r.waterTrekkingDistance === "over_10km") bucket.trekOver10++;
    if (r.waterPointName && isProblemStatus(r.waterPointStatus)) {
      const key = r.waterPointName;
      bucket.waterIssues.set(key, (bucket.waterIssues.get(key) ?? 0) + 1);
    }
  }

  const lines: string[] = [
    "─── WARD GROUND-TRUTH ROLLUP (last 7 days, from other herders) ───",
    `Total reports: ${rows.length}. Use these patterns to sound informed — e.g. "three other herders near you reported the same borehole is dry." Cite trends, never invent numbers beyond this block.`,
  ];

  let printed = 0;
  for (const q of ["NW", "NE", "SW", "SE"] as const) {
    const b = byQuad[q];
    if (b.reports === 0) continue;
    printed++;
    const meanBcs =
      b.bcsValues.length > 0
        ? (b.bcsValues.reduce((a, x) => a + x, 0) / b.bcsValues.length).toFixed(
            2,
          )
        : "n/a";
    const bits: string[] = [`${b.reports} report${b.reports === 1 ? "" : "s"}`];
    if (meanBcs !== "n/a") bits.push(`mean BCS ${meanBcs}`);
    if (b.mortalityFlags > 0)
      bits.push(
        `${b.mortalityFlags} mortality flag${b.mortalityFlags === 1 ? "" : "s"}`,
      );
    if (b.earlyOfftake > 0) bits.push(`${b.earlyOfftake} selling early`);
    if (b.milkReduced > 0) bits.push(`${b.milkReduced} milk-down`);
    if (b.trekOver10 > 0) bits.push(`${b.trekOver10} walking >10km to water`);
    lines.push(`[${QUAD_NAMES[q]}] ${bits.join(" · ")}`);
    if (b.waterIssues.size > 0) {
      const issues = Array.from(b.waterIssues.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, n]) => `${name} (${n}x)`)
        .join("; ");
      lines.push(`    water-point issues: ${issues}`);
    }
  }

  if (printed === 0) return "";
  return lines.join("\n");
}

export async function formatWardRollupBlock(): Promise<string> {
  return withTimeout(
    fetchWardRollupRaw(),
    MEMORY_FETCH_TIMEOUT_MS,
    "",
    "ward-rollup",
  );
}

// ─── Water-point usage stats (which sites herders actually visit) ───────────
//
// Pulls the last 30 days of reports, counts how often each OSM water point
// has been named by a herder, and splits the count into "working" vs
// "problem" sightings. This lets the AI prioritise sites that real
// pastoralists actually use over the long tail of OSM points that may be
// abandoned or unknown to locals.

const USAGE_WINDOW_DAYS = 30;
const USAGE_TOP_N = 8;

interface UsageRow {
  name: string;
  totalMentions: number;
  workingMentions: number;
  problemMentions: number;
  lastSeen: Date;
}

async function fetchWaterPointUsageRaw(): Promise<string> {
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      name: groundTruthReportsTable.waterPointName,
      status: groundTruthReportsTable.waterPointStatus,
      ts: groundTruthReportsTable.timestamp,
    })
    .from(groundTruthReportsTable)
    .where(
      and(
        gte(groundTruthReportsTable.timestamp, since),
        isNotNull(groundTruthReportsTable.waterPointName),
      ),
    )
    .orderBy(desc(groundTruthReportsTable.timestamp))
    .limit(500);

  if (rows.length === 0) return "";

  const byName = new Map<string, UsageRow>();
  for (const r of rows) {
    if (!r.name) continue;
    const existing = byName.get(r.name) ?? {
      name: r.name,
      totalMentions: 0,
      workingMentions: 0,
      problemMentions: 0,
      lastSeen: r.ts,
    };
    existing.totalMentions++;
    if (r.status === "operational_good") existing.workingMentions++;
    else if (isProblemStatus(r.status)) existing.problemMentions++;
    if (r.ts > existing.lastSeen) existing.lastSeen = r.ts;
    byName.set(r.name, existing);
  }

  const ranked = Array.from(byName.values())
    .sort((a, b) => b.totalMentions - a.totalMentions)
    .slice(0, USAGE_TOP_N);

  if (ranked.length === 0) return "";

  const lines: string[] = [
    `─── WATER POINTS HERDERS ACTUALLY USE (last ${USAGE_WINDOW_DAYS} days, top ${ranked.length}) ───`,
    `These are the OSM points that real callers from Bula Pesa have named in conversations. Prioritise these when suggesting where to water animals — they are the sites locals know and visit. Mentions counts include all statuses; "working" and "problem" are subsets.`,
  ];
  for (const u of ranked) {
    const bits: string[] = [
      `${u.totalMentions} mention${u.totalMentions === 1 ? "" : "s"}`,
    ];
    if (u.workingMentions > 0) bits.push(`${u.workingMentions} working`);
    if (u.problemMentions > 0) bits.push(`${u.problemMentions} problem`);
    bits.push(`last ${u.lastSeen.toISOString().slice(0, 10)}`);
    lines.push(`  • ${u.name} — ${bits.join(", ")}`);
  }
  return lines.join("\n");
}

export async function formatWaterPointUsageBlock(): Promise<string> {
  return withTimeout(
    fetchWaterPointUsageRaw(),
    MEMORY_FETCH_TIMEOUT_MS,
    "",
    "water-point-usage",
  );
}
