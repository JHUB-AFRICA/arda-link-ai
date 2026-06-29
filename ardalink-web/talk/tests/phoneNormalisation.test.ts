/**
 * Phone-number normalisation for the Talk app.
 *
 * Contract:
 *   - Local format "0712 345 678" → E.164 "+254712345678"
 *   - Local without leading 0  → prepend "+254"
 *   - Country code without +   → prepend "+"
 *   - Already E.164            → unchanged
 *   - Non-digit chars stripped silently
 *   - `isValidPhone` returns true iff the normalised form is +9..15 digits
 */
import { describe, it, expect } from "vitest";
import {
  normalizePhone,
  isValidPhone,
  extractMobilePrefix,
} from "../src/lib/phone";

describe("normalizePhone", () => {
  it("converts local with leading 0 to E.164 (+254)", () => {
    expect(normalizePhone("0712345678")).toBe("+254712345678");
    expect(normalizePhone("0712 345 678")).toBe("+254712345678");
    expect(normalizePhone("0712-345-678")).toBe("+254712345678");
    expect(normalizePhone("(0712) 345-678")).toBe("+254712345678");
  });

  it("prepends +254 when the input has no leading 0 and no country code", () => {
    expect(normalizePhone("712345678")).toBe("+254712345678");
    expect(normalizePhone("712 345 678")).toBe("+254712345678");
  });

  it("prepends + when the input starts with the country code (no +)", () => {
    expect(normalizePhone("254712345678")).toBe("+254712345678");
    expect(normalizePhone("254 712 345 678")).toBe("+254712345678");
  });

  it("leaves an already-E.164 input unchanged", () => {
    expect(normalizePhone("+254712345678")).toBe("+254712345678");
    expect(normalizePhone("+1 415 555 0100")).toBe("+14155550100");
  });

  it("strips non-digit characters except a leading +", () => {
    expect(normalizePhone("+254 (712) 345-678")).toBe("+254712345678");
  });
});

describe("isValidPhone", () => {
  it("accepts valid Kenyan mobile numbers", () => {
    expect(isValidPhone("+254712345678")).toBe(true);
    expect(isValidPhone("0712345678")).toBe(true);
    expect(isValidPhone("712345678")).toBe(true);
  });

  it("accepts valid non-Kenyan E.164 numbers (US, UK, generic)", () => {
    expect(isValidPhone("+14155550100")).toBe(true);
    expect(isValidPhone("+447911123456")).toBe(true);
  });

  it("rejects inputs that normalise to too few digits", () => {
    expect(isValidPhone("")).toBe(false);
    expect(isValidPhone("123")).toBe(false);
    expect(isValidPhone("+1234")).toBe(false);
  });

  it("rejects inputs that normalise to too many digits", () => {
    expect(isValidPhone("+1234567890123456")).toBe(false);
  });
});

describe("extractMobilePrefix", () => {
  it("returns the 9-digit Kenyan mobile prefix for valid inputs", () => {
    expect(extractMobilePrefix("+254712345678")).toBe("712345678");
    expect(extractMobilePrefix("0712345678")).toBe("712345678");
    expect(extractMobilePrefix("712345678")).toBe("712345678");
  });

  it("returns null for inputs that fail validation", () => {
    expect(extractMobilePrefix("")).toBeNull();
    expect(extractMobilePrefix("123")).toBeNull();
  });

  it("returns null for non-Kenyan E.164 numbers", () => {
    expect(extractMobilePrefix("+14155550100")).toBeNull();
  });
});