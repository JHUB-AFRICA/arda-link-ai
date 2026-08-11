/**
 * Shared "is this satellite reading too old to state with present-tense
 * confidence" check for herder-facing copy — WhatsApp's droughtLine/
 * queryWardLine (whatsappConversation.ts) and the deterministic
 * USSD/SMS/voice brief (herderContext/briefs.ts) both need it.
 *
 * Deliberately a DIFFERENT threshold than heartbeatJob.ts's 36h
 * `satellite_indices` writer-liveness check: that one asks "has the
 * pipeline gone silent" (a 16-day MODIS composite being 1-3 weeks old
 * is completely normal imagery latency, not a broken writer). This one
 * asks "is this specific reading old enough that quoting it with
 * unqualified present-tense wording ('this month', 'mwezi huu') would
 * mislead a herder" — set past a full monthly cycle. Confirmed live
 * incident (2026-08-10 audit): a ward's NDVI reading was ~32 days past
 * its own data period while `droughtLine`/`swSeverityLine` still said
 * "mwezi huu" / "this month" with zero disclosure of the gap.
 */
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export function isSatelliteReadingStale(periodEndIso: string | null): boolean {
  if (!periodEndIso) return false;
  const ageMs = Date.now() - new Date(periodEndIso).getTime();
  if (Number.isNaN(ageMs)) return false;
  return ageMs > STALE_THRESHOLD_MS;
}

/** Short, herder-natural "as of [date]" phrase, or null when there's
 * nothing to anchor it to (no reading, or an unparseable date). */
export function satelliteAsOfPhrase(
  periodEndIso: string | null,
  lang: "sw" | "en",
): string | null {
  if (!periodEndIso) return null;
  const d = new Date(periodEndIso);
  if (Number.isNaN(d.getTime())) return null;
  const formatted = d.toLocaleDateString(lang === "sw" ? "sw-KE" : "en-KE", {
    month: "short",
    day: "numeric",
  });
  return lang === "sw" ? `kwa taarifa ya ${formatted}` : `as of ${formatted}`;
}
