/**
 * Consent persistence for the public Talk app.
 *
 * The consent banner lives under the phone-entry form. When the user
 * accepts (taps Continue), we record the consent timestamp in
 * localStorage so the next session knows they're already opted in.
 * When the user changes their phone number, we clear the consent so
 * the new owner re-confirms.
 *
 * The state is intentionally a **timestamp**, not a boolean, so we
 * can later add a "you consented 6 months ago, please re-confirm"
 * reminder without a schema change.
 */

export const CONSENT_STORAGE_KEY = "ardalink_talk_consent_at";

/** Read the persisted consent timestamp (ISO 8601) or `null` if none. */
export function readConsent(): string | null {
  try {
    return localStorage.getItem(CONSENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** True iff the user has previously consented. */
export function hasConsent(): boolean {
  return readConsent() !== null;
}

/** Persist the consent timestamp for the current session. */
export function recordConsent(at: Date = new Date()): string {
  const iso = at.toISOString();
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, iso);
  } catch {
    /* ignore quota / disabled storage */
  }
  return iso;
}

/** Clear the persisted consent. */
export function clearConsent(): void {
  try {
    localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}