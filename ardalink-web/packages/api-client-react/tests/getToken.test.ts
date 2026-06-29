/**
 * Tests for getToken() URL-hash token extraction.
 *
 * Contract: the JWT can arrive three ways:
 *   1. Already in localStorage (steady state — return as-is, no write).
 *   2. As `?token=...` query parameter (demo link sharing).
 *   3. As `#token=...` URL hash (copy-paste-able links).
 *
 * In cases (2) and (3) the token (and any companion `tenant=...`) is
 * persisted to localStorage so the URL can be sanitised later.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readToken } from "../src";

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
let originalWindow: unknown;
let originalLocation: unknown;

beforeEach(() => {
  stub = makeStorageStub();
  originalWindow = (globalThis as { window?: unknown }).window;
  originalLocation = (globalThis as { location?: unknown }).location;
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: stub,
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  }
  if (originalLocation === undefined) {
    delete (globalThis as { location?: unknown }).location;
  } else {
    Object.defineProperty(globalThis, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  }
});

function setLocation(href: string) {
  Object.defineProperty(globalThis, "location", {
    value: { href },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis.window, "location", {
    value: { href },
    writable: true,
    configurable: true,
  });
}

describe("readToken — URL hash + query persistence", () => {
  it("returns the localStorage value when present, and does not overwrite it", () => {
    stub.setItem("ardalink.jwt", "stable.jwt.value");
    setLocation("http://localhost/?token=should.be.ignored");

    expect(readToken()).toBe("stable.jwt.value");
  });

  it("extracts token from the URL hash and persists it to localStorage", () => {
    setLocation("http://localhost/#token=hash.jwt.value");

    expect(readToken()).toBe("hash.jwt.value");
    expect(stub.getItem("ardalink.jwt")).toBe("hash.jwt.value");
  });

  it("prefers the query parameter over the URL hash when both are present", () => {
    setLocation("http://localhost/?token=query.jwt#token=hash.jwt");

    // Query wins, hash is ignored.
    expect(readToken()).toBe("query.jwt");
    expect(stub.getItem("ardalink.jwt")).toBe("query.jwt");
  });

  it("persists the companion tenant from the URL hash", () => {
    setLocation("http://localhost/#token=hash.jwt&tenant=garbatulla");

    expect(readToken()).toBe("hash.jwt");
    expect(stub.getItem("ardalink.tenant")).toBe("garbatulla");
  });

  it("returns the empty string when no token source is present", () => {
    setLocation("http://localhost/");

    expect(readToken()).toBe("");
    expect(stub.getItem("ardalink.jwt")).toBeNull();
  });
});