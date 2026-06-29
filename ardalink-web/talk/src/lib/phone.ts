/**
 * Phone-number normalisation for the public Talk app.
 *
 * The app is Kenya-first (Isiolo pastoralists). Numbers arrive in
 * three common shapes:
 *
 *   "0712 345 678"   → local with leading zero
 *   "712345678"      → local without leading zero
 *   "254712345678"   → country code without the +
 *   "+254712345678"  → already E.164
 *
 * `normalizePhone` collapses all four to E.164 (`+254712345678`).
 * `isValidPhone` runs the same normalisation and then asserts the
 * result is in the valid E.164 range (9–15 digits after the +).
 *
 * Non-digit characters (spaces, dashes, parentheses) are stripped
 * silently. A leading + is preserved; everything else is rewritten.
 */

/**
 * Convert any common Kenyan phone number format to E.164.
 *
 * @example
 *   normalizePhone("0712 345 678") // → "+254712345678"
 *   normalizePhone("712345678")    // → "+254712345678"
 *   normalizePhone("+254712345678") // → "+254712345678"
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.replace(/[^\d+]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("0")) return "+254" + trimmed.slice(1);
  if (trimmed.startsWith("254")) return "+" + trimmed;
  return "+254" + trimmed;
}

/**
 * E.164 validation. Returns true iff `normalizePhone(raw)` is a string
 * of the shape `+` followed by 9 to 15 digits.
 */
export function isValidPhone(raw: string): boolean {
  const n = normalizePhone(raw);
  return /^\+\d{9,15}$/.test(n);
}

/**
 * Best-effort extraction of the Kenyan mobile prefix (the 9 digits after
 * +254). Returns `null` when the input cannot be normalised into a valid
 * Kenyan mobile number. Useful for telemetry + abuse heuristics.
 */
export function extractMobilePrefix(raw: string): string | null {
  if (!isValidPhone(raw)) return null;
  const n = normalizePhone(raw);
  if (!n.startsWith("+254")) return null;
  const rest = n.slice(4);
  if (rest.length < 9) return null;
  return rest.slice(0, 9);
}