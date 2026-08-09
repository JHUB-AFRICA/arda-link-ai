/**
 * Landmark-mention matcher — turns a named place in a herder's own
 * message into real coordinates, so it can anchor a location estimate
 * the same way a live GPS share does (just less precise/certain).
 *
 * Before this, curated landmark data (828 OSM-derived points with real
 * lat/lon, see ../bulaPesaLandmarks.ts) only ever fed the LLM's prompt
 * as prose for it to recognize and talk about — it never became a
 * coordinate anything else in this codebase could compute a distance
 * from. A herder naming "Shibli Petrol Station" got a reply that
 * *mentioned* the place but still measured distances from their ward's
 * centroid or registered location, both far coarser than the landmark
 * itself. This module closes that gap: given free text and a ward, it
 * returns the best-matching landmark's own coordinates.
 *
 * No fuzzy-matching library exists in this codebase (see ../index.ts's
 * docstring) and adding one is out of scope here — this is a plain
 * case-insensitive substring match, same rigor as this file's sibling
 * `wardIdFromLocationText()` alias-matcher in wardMapping.ts.
 */

import { BULA_PESA_LANDMARKS, type Landmark } from "../bulaPesaLandmarks.js";

/** Only Bula Pesa (242) has curated landmark data today — same
 * per-ward registry as ../index.ts's landmarksBlockForWard, kept
 * separate rather than imported from there so this module has no
 * dependency on prompt-formatting code. */
const LANDMARK_POOLS: Record<string, readonly Landmark[]> = {
  "242": BULA_PESA_LANDMARKS,
};

export interface LandmarkMatch {
  name: string;
  lat: number;
  lon: number;
}

// Skip names too short/generic to match safely against free text
// ("Isiolo" alone would match constantly and mean nothing specific).
const MIN_NAME_LENGTH = 4;

/**
 * Find the best (longest) curated landmark named in `text`, scoped to
 * `wardId`'s pool. Returns null when the ward has no curated data, no
 * landmark name appears in the text, or `text` is empty/whitespace.
 *
 * Longest match wins so a more specific multi-word name is preferred
 * over a shorter name it happens to contain (e.g. "Kiwanjani Primary
 * School" over a bare "Kiwanjani" hamlet entry, if both existed).
 */
export function findLandmarkMention(
  text: string,
  wardId: string | null | undefined,
): LandmarkMatch | null {
  const trimmed = text.trim();
  if (!trimmed || !wardId) return null;
  const pool = LANDMARK_POOLS[wardId];
  if (!pool) return null;

  const haystack = trimmed.toLowerCase();
  let best: Landmark | null = null;
  for (const lm of pool) {
    if (lm.name.length < MIN_NAME_LENGTH) continue;
    if (haystack.includes(lm.name.toLowerCase())) {
      if (!best || lm.name.length > best.name.length) best = lm;
    }
  }
  return best ? { name: best.name, lat: best.lat, lon: best.lon } : null;
}
