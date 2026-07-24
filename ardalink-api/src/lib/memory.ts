// Memory & learning loop — turns ground_truth data into live context the
// Realtime AI consults at the start of every call.
//
// Two layers:
//   1. Per-herder memory  — what did THIS phone tell us recently
//   2. Ward-level rollup  — what are ALL herders saying across the ward
//
// Both produce compact, prompt-friendly text blocks. We keep them small
// (~10–20 lines each) so the Realtime token budget stays sane.
//
// The local ground_truth_reports table has been dropped. Reads now use
// Supabase ground_truth_calls via recentGroundTruthCalls(). Fields not
// present on Supabase (offtake label, milk, trekking, water_point_name,
// quadrant, location, ndviVsBaseline) are omitted.

import {
  recentGroundTruthCalls,
  isSupabaseConfigured,
  type SbGroundTruthCallRead,
} from "./supabase.js";
import { logger } from "./logger.js";

const HERDER_LOOKBACK = 2; // last N calls for the same phone
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

function describeCall(r: SbGroundTruthCallRead): string {
  const when = r.created_at.slice(0, 10);
  const bits: string[] = [];
  if (r.bcs_score != null) {
    bits.push(`BCS ${r.bcs_score.toFixed(1)}`);
  }
  if (r.mortality_rate != null && r.mortality_rate > 0) {
    const label =
      r.mortality_rate >= 0.1
        ? "4-plus"
        : r.mortality_rate >= 0.02
          ? "1-3"
          : "none";
    bits.push(`mortality=${label}`);
  }
  if (r.water_point_status) {
    bits.push(`water=${r.water_point_status}`);
  }
  if (r.supplementary_feeding != null) {
    bits.push(`feed=${r.supplementary_feeding ? "yes" : "no"}`);
  }
  const indicators =
    bits.length > 0 ? bits.join(", ") : "no indicators captured";
  return `  • ${when} — ${indicators}`;
}

/**
 * Build a "LAST CONTACT" block for this herder. Returns empty string if
 * there is no prior history (first-time caller, browser demo, etc.) or
 * Supabase is not configured.
 */
async function fetchHerderMemoryRaw(phone: string): Promise<string> {
  if (!isSupabaseConfigured()) return "";
  const rows = await recentGroundTruthCalls(HERDER_LOOKBACK);
  if (!rows || rows.length === 0) return "";

  const lines = [
    "─── LAST CONTACT WITH THIS HERDER ───",
    `You have spoken with this person before (${rows.length} prior call${rows.length === 1 ? "" : "s"}). Use this to sound continuous — reference what they told you last time naturally ("last time you said the cows were thin near Burat — how are they now?"). Do NOT recite the list back; weave one or two specifics in.`,
    ...rows.map(describeCall),
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
//
// ground_truth_calls has no reportedQuadrant column, so the per-quadrant
// breakdown is not available. Return empty string — the peer signal overlay
// in herderContext.ts (peerSignalForWard) provides the community-level signal
// that used to come from this block.

async function fetchWardRollupRaw(): Promise<string> {
  return "";
}

export async function formatWardRollupBlock(): Promise<string> {
  return withTimeout(
    fetchWardRollupRaw(),
    MEMORY_FETCH_TIMEOUT_MS,
    "",
    "ward-rollup",
  );
}

// ─── Water-point usage stats ─────────────────────────────────────────────────
//
// ground_truth_calls has water_point_status but no water_point_name, so we
// cannot produce the per-named-point usage ranking. Return empty string.

async function fetchWaterPointUsageRaw(): Promise<string> {
  return "";
}

export async function formatWaterPointUsageBlock(): Promise<string> {
  return withTimeout(
    fetchWaterPointUsageRaw(),
    MEMORY_FETCH_TIMEOUT_MS,
    "",
    "water-point-usage",
  );
}
