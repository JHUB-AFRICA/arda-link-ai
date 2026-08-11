/**
 * ground_truth_calls reads/writes — the per-call structured indicator
 * record written by the deterministic voice pipeline (and, since the
 * WhatsApp channel shipped, by WhatsApp free-text turns too).
 */

import { sbInsert, sbGet, sbFetch, isSupabaseConfigured, type SupabaseMode } from "./client.js";

/**
 * Read shape of Supabase `ground_truth_calls`. Nullable everywhere except
 * the columns Supabase's schema requires (call_id, pastoralist_id,
 * ward_id, call_timestamp). We pull pastoralist phone + name via
 * PostgREST's embedded-select syntax on public helpers below.
 */
export interface SbGroundTruthCallRead {
  call_id: string;
  pastoralist_id: string;
  ward_id: string;
  call_timestamp: string;
  bcs_score: number | null;
  mortality_rate: number | null;
  offtake_rate: number | null;
  water_point_name: string | null;
  water_point_status: string | null;
  milk_production_liters: number | null;
  water_trek_distance_km: number | null;
  supplementary_feeding: boolean | null;
  trust_score: number | null;
  source_language: string | null;
  transcript: string | null;
  channel: string | null;
  created_at: string;
  // Embedded pastoralist (via `pastoralists(...)` select in PostgREST)
  pastoralists?: {
    phone_number: string | null;
    full_name: string | null;
    preferred_language: string | null;
    ward_id: string | null;
  } | null;
}

export interface SbGroundTruthCallInsert {
  pastoralist_id?: string | null;
  ward_id?: string | null;
  call_timestamp?: string;
  bcs_score?: number | null;
  mortality_rate?: number | null;
  offtake_rate?: number | null;
  water_point_name?: string | null;
  water_point_status?: string | null;
  milk_production_liters?: number | null;
  water_trek_distance_km?: number | null;
  supplementary_feeding?: boolean | null;
  trust_score?: number | null;
  source_language?: string | null;
  transcript?: string | null;
  /** Which channel produced this row. Defaults to 'voice' at the DB
   * level (see migration 0005_add_whatsapp_support) for rows written
   * before this field existed; new callers should always set it. */
  channel?: "voice" | "sms" | "ussd" | "whatsapp";
  /** Best-effort coordinates from a recent WhatsApp location share
   * (see migration 0007_ground_truth_calls_location) — null when no
   * location share preceded the report, or it aged out. QA aid for
   * joining against piosphere-ring advisories, not guaranteed present. */
  reported_lat?: number | null;
  reported_lon?: number | null;
}

/**
 * Insert a ground-truth call. This is the Supabase mirror of our local
 * `ground_truth_reports` insert; called from the deterministic pipeline
 * after every completed call. Returns the inserted row (or null on
 * failure — the local backup insert should always succeed).
 */
export const insertGroundTruthCall = (
  row: SbGroundTruthCallInsert,
  mode: SupabaseMode = "batch",
) =>
  // Ground truth writes happen in the deterministic pipeline's
  // fire-and-forget worker AFTER the AT XML response has already been
  // sent. Slower `batch` timeout is fine — the herder isn't waiting.
  sbInsert<{ call_id: string; call_timestamp: string }>(
    "ground_truth_calls",
    row as unknown as Record<string, unknown>,
    { mode },
  );

/**
 * Recent ground_truth_calls with pastoralist name + phone joined in.
 * Not cached — the operator dashboard needs fresh data every reload.
 * `batch` mode by default because this powers the dashboard, not USSD.
 */
export const recentGroundTruthCalls = (
  limit = 20,
  mode: SupabaseMode = "batch",
) => {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  return sbGet<SbGroundTruthCallRead>(
    `ground_truth_calls?select=call_id,pastoralist_id,ward_id,call_timestamp,bcs_score,mortality_rate,offtake_rate,water_point_name,water_point_status,milk_production_liters,water_trek_distance_km,supplementary_feeding,trust_score,source_language,transcript,created_at,pastoralists(phone_number,full_name,preferred_language,ward_id)&order=call_timestamp.desc&limit=${safeLimit}`,
    { mode },
  );
};

/**
 * Diagnostic-only probe for the ops dashboard's Ground Truth Audit
 * panel, called only when `recentGroundTruthCalls()` has already
 * returned `null`. `sbGet` swallows the real failure reason (by
 * design — every other caller just wants "did I get data or not"),
 * which meant this panel reported a hardcoded, frequently-false
 * `reason: "supabase_not_configured"` even when Supabase was fully
 * configured and reachable but a query failed for another reason —
 * exactly what happened for a month when `ground_truth_calls
 * .water_point_name` went missing live (migration 0016 unapplied) and
 * every read 400'd with PGRST204. Never used on a herder-facing path;
 * this is strictly for giving an operator a truthful "why" here.
 */
export async function probeGroundTruthCallsFailureReason(): Promise<string> {
  if (!isSupabaseConfigured()) return "supabase_not_configured";
  try {
    const res = await sbFetch("ground_truth_calls?select=call_id&limit=1", {
      sbMode: "batch",
    });
    if (res.ok) return "unknown_transient_error";
    const body = await res.text().catch(() => "");
    let code: string | null = null;
    try {
      code = (JSON.parse(body) as { code?: string; message?: string }).code ?? null;
    } catch {
      // Non-JSON error body — fall through to the raw status.
    }
    return code ? `supabase_error_${code}` : `supabase_http_${res.status}`;
  } catch (err) {
    return `probe_failed: ${String(err).slice(0, 200)}`;
  }
}

// ── Ground-truth corrections (operator review layer) ───────────────────
// See migration 0009's header: ground_truth_calls stays append-only.
// Corrections are a separate, additive table — one row per corrected
// field, referencing the original call_id, never an UPDATE on the
// original row.

/** Allowlist of fields an operator may correct — never a free-form
 * column name. Kept in sync with routes/ops/admin.ts's validation. */
export const CORRECTABLE_GROUND_TRUTH_FIELDS = [
  "bcs_score",
  "water_point_status",
  "mortality_rate",
  "offtake_rate",
  "milk_production_liters",
  "water_trek_distance_km",
] as const;
export type CorrectableGroundTruthField = (typeof CORRECTABLE_GROUND_TRUTH_FIELDS)[number];

export interface SbGroundTruthCorrectionInsert {
  call_id: string;
  corrected_by: string;
  field: CorrectableGroundTruthField;
  original_value: string | null;
  corrected_value: string;
  reason: string;
}

export interface SbGroundTruthCorrection extends SbGroundTruthCorrectionInsert {
  id: number;
  corrected_at: string;
}

export const insertGroundTruthCorrection = (
  row: SbGroundTruthCorrectionInsert,
  mode: SupabaseMode = "interactive",
) =>
  sbInsert<SbGroundTruthCorrection>(
    "ground_truth_corrections",
    row as unknown as Record<string, unknown>,
    { mode },
  );

/** All corrections for a set of call_ids, most recent first. Used to
 * left-join corrections onto recentGroundTruthCalls() results. */
export const correctionsForCallIds = (
  callIds: string[],
  mode: SupabaseMode = "batch",
) => {
  if (callIds.length === 0) return Promise.resolve<SbGroundTruthCorrection[] | null>([]);
  const inList = callIds.map((id) => `"${id}"`).join(",");
  return sbGet<SbGroundTruthCorrection>(
    `ground_truth_corrections?call_id=in.(${inList})&order=corrected_at.desc`,
    { mode },
  );
};

/** The single most recent correction for one call_id + field, or null.
 * This is the function the water-point overlay (and any future
 * consumer) calls to decide whether to prefer a correction over the
 * raw ground-truth value. */
export const latestCorrectionFor = async (
  callId: string,
  field: CorrectableGroundTruthField,
  mode: SupabaseMode = "interactive",
): Promise<SbGroundTruthCorrection | null> => {
  const rows = await sbGet<SbGroundTruthCorrection>(
    `ground_truth_corrections?call_id=eq.${encodeURIComponent(callId)}&field=eq.${field}&order=corrected_at.desc&limit=1`,
    { mode },
  );
  return rows?.[0] ?? null;
};
