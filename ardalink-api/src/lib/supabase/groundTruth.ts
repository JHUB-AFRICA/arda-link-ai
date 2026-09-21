/**
 * ground_truth_calls reads/writes — the per-call structured indicator
 * record written by the deterministic voice pipeline (and, since the
 * WhatsApp channel shipped, by WhatsApp free-text turns too).
 */

import { sbInsert, sbGet, type SupabaseMode } from "./client.js";

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
    `ground_truth_calls?select=call_id,pastoralist_id,ward_id,call_timestamp,bcs_score,mortality_rate,offtake_rate,water_point_status,milk_production_liters,water_trek_distance_km,supplementary_feeding,trust_score,source_language,transcript,created_at,pastoralists(phone_number,full_name,preferred_language,ward_id)&order=call_timestamp.desc&limit=${safeLimit}`,
    { mode },
  );
};
