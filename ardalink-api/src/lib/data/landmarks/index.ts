/**
 * Per-ward landmark registry — Phase 3 of the location/registration/
 * landmark plan (2026-08-06).
 *
 * Only Bula Pesa (ward_id 242) has curated landmark data today
 * (`../bulaPesaLandmarks.ts`, 828 OSM-derived entries — schools,
 * mosques, petrol stations, luggas, hamlets). Building the same for
 * Wabera/Ngare Mara/Burat/Oldonyiro is a real data-acquisition task
 * (OSM Overpass extraction + manual review, like bulaPesaLandmarks.ts
 * itself was), not something achievable through code alone — explicitly
 * out of scope here. Confirmed no live Supabase table exists for this
 * (checked directly: `landmarks`, `named_places`, `settlements`, `poi`,
 * `points_of_interest` all 404), so there's nothing to query instead.
 *
 * This registry exists so adding another ward's landmarks later is a
 * one-file + one-line change — nothing in whatsappConversation.ts or
 * whatsappTurn.ts needs to know which wards are covered.
 */

import { formatLandmarksBlock } from "../bulaPesaLandmarks.js";

const LANDMARK_PROVIDERS: Record<string, () => string> = {
  "242": formatLandmarksBlock, // Bulla Pesa — only ward with curated data today
};

/** Ward IDs with real curated landmark data — used to decide whether
 * to splice in the block or the honest "no data" fallback wording. */
export function hasLandmarkData(wardId: string | null | undefined): boolean {
  return !!wardId && wardId in LANDMARK_PROVIDERS;
}

export function landmarksBlockForWard(wardId: string | null | undefined): string | null {
  if (!wardId) return null;
  return LANDMARK_PROVIDERS[wardId]?.() ?? null;
}
