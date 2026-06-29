/**
 * Consent state-machine tests.
 *
 * Contract:
 *   - `hasConsent()` is `false` on first visit.
 *   - `recordConsent()` persists a timestamp and makes `hasConsent()`
 *     return `true`.
 *   - `clearConsent()` removes the timestamp and makes `hasConsent()`
 *     return `false` again.
 *   - State is durable across calls (localStorage round-trip).
 *   - Storage failures (quota, disabled) are swallowed silently; the
 *     helpers never throw.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  CONSENT_STORAGE_KEY,
  hasConsent,
  readConsent,
  recordConsent,
  clearConsent,
} from "../src/lib/consent";

function makeStorageStub() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => (data.get(k) ?? null) as string | null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
}

let stub: ReturnType<typeof makeStorageStub>;

beforeEach(() => {
  stub = makeStorageStub();
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: stub },
    writable: true,
    configurable: true,
  });
});

describe("consent state", () => {
  it("starts with no consent recorded", () => {
    expect(hasConsent()).toBe(false);
    expect(readConsent()).toBeNull();
  });

  it("transitions idle → asked → granted on recordConsent()", () => {
    expect(hasConsent()).toBe(false);
    const iso = recordConsent();
    expect(hasConsent()).toBe(true);
    expect(readConsent()).toBe(iso);
    expect(stub.getItem(CONSENT_STORAGE_KEY)).toBe(iso);
  });

  it("uses an explicit Date when one is passed in", () => {
    const at = new Date("2026-06-29T12:00:00.000Z");
    const iso = recordConsent(at);
    expect(iso).toBe("2026-06-29T12:00:00.000Z");
    expect(stub.getItem(CONSENT_STORAGE_KEY)).toBe(
      "2026-06-29T12:00:00.000Z",
    );
  });

  it("overwrites any previously-stored consent on a new recordConsent()", () => {
    recordConsent(new Date("2026-06-29T10:00:00.000Z"));
    expect(readConsent()).toBe("2026-06-29T10:00:00.000Z");
    recordConsent(new Date("2026-06-29T18:00:00.000Z"));
    expect(readConsent()).toBe("2026-06-29T18:00:00.000Z");
  });

  it("transitions granted → cleared on clearConsent()", () => {
    recordConsent();
    expect(hasConsent()).toBe(true);
    clearConsent();
    expect(hasConsent()).toBe(false);
    expect(readConsent()).toBeNull();
    expect(stub.getItem(CONSENT_STORAGE_KEY)).toBeUndefined();
  });

  it("clearConsent() is idempotent (safe to call when no consent is recorded)", () => {
    expect(() => clearConsent()).not.toThrow();
    expect(hasConsent()).toBe(false);
  });
});