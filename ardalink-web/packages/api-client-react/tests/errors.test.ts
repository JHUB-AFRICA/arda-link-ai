/**
 * Tests for apiFetch error surfacing.
 *
 * Contract:
 *   - Non-2xx responses throw `Error("<status>: <body text>")`.
 *   - The body text comes from `res.text()` (best-effort); falls back
 *     to `res.statusText` if reading the body fails.
 *   - A 204 No Content returns `undefined` (not an empty parsed object).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mintCallToken, __apiFetch } from "../src";

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
let originalFetch: typeof fetch;
let originalWindow: unknown;

beforeEach(() => {
  stub = makeStorageStub();
  originalFetch = globalThis.fetch;
  originalWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: stub,
      location: { href: "http://localhost/" },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  }
});

describe("apiFetch — error surfacing", () => {
  it("throws '<status>: <body>' for a 401", async () => {
    stub.setItem("ardalink.jwt", "tok");
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Missing Bearer token",
      json: async () => ({ error: "Missing Bearer token" }),
    })) as unknown as typeof fetch;

    await expect(mintCallToken()).rejects.toThrow(/401: Missing Bearer token/);
  });

  it("throws '<status>: <body>' for a 503 from a missing upstream provider", async () => {
    stub.setItem("ardalink.jwt", "tok");
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () =>
        '503: {"error":"Azure OpenAI not configured","feature":"intelligence/brief"}',
      json: async () => ({
        error: "Azure OpenAI not configured",
        feature: "intelligence/brief",
      }),
    })) as unknown as typeof fetch;

    await expect(mintCallToken()).rejects.toThrow(/503.*Azure OpenAI/);
  });

  it("falls back to statusText when the response body cannot be read", async () => {
    stub.setItem("ardalink.jwt", "tok");
    globalThis.fetch = (async () => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => {
        throw new Error("body stream broken");
      },
      json: async () => {
        throw new Error("body stream broken");
      },
    })) as unknown as typeof fetch;

    await expect(mintCallToken()).rejects.toThrow(/502: Bad Gateway/);
  });

  it("returns undefined for a 204 No Content", async () => {
    stub.setItem("ardalink.jwt", "tok");
    globalThis.fetch = (async () => ({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: async () => {
        throw new Error("no body to parse on 204");
      },
    })) as unknown as typeof fetch;

    // Use the test-only export to assert the 204 short-circuit directly.
    const result = await __apiFetch<void>("/api/healthz");
    expect(result).toBeUndefined();
  });
});