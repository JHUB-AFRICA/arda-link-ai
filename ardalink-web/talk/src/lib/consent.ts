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
 *
 * Storage backend is `globalThis.localStorage` (which on the browser is
 * `window.localStorage`). Resolved at call time so tests can stub
 * `globalThis.localStorage` per-test without module-load races.
 */

export const CONSENT_STORAGE_KEY = "ardalink_talk_consent_at";

function storage(): Storage | null {
  try {
    // globalThis works in both the browser (== window) and Node/jsdom
    // test envs where the test sets `globalThis.localStorage = stub`.
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read the persisted consent timestamp (ISO 8601) or `null` if none. */
export function readConsent(): string | null {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(CONSENT_STORAGE_KEY);
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
  const s = storage();
  if (s) {
    try {
      s.setItem(CONSENT_STORAGE_KEY, iso);
    } catch {
      /* ignore quota / disabled storage */
    }
  }
  return iso;
}

/** Clear the persisted consent. */
export function clearConsent(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
