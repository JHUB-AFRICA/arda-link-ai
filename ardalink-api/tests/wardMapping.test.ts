import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WARD_ID,
  knownWardIds,
  tenantForWardId,
  wardIdForTenant,
  wardIdFromLocationText,
} from "../src/lib/wardMapping.js";

describe("wardMapping", () => {
  it("maps every canonical tenant slug 1:1 to a Supabase ward_id", () => {
    // Since 2026-07-08 all 5 Isiolo Sub-County wards are valid tenant
    // slugs. Every mapping is unique and stable.
    expect(wardIdForTenant("wabera")).toBe("241");
    expect(wardIdForTenant("bula-pesa")).toBe("242");
    expect(wardIdForTenant("ngare-mara")).toBe("245");
    expect(wardIdForTenant("burat")).toBe("246");
    expect(wardIdForTenant("oldonyiro")).toBe("247");
  });

  it("accepts the legacy double-L alias for Bulla Pesa", () => {
    expect(wardIdForTenant("bulla-pesa")).toBe("242");
  });

  it("lower-cases and trims input before matching", () => {
    expect(wardIdForTenant("  Bula-Pesa  ")).toBe("242");
    expect(wardIdForTenant("BURAT")).toBe("246");
  });

  it("falls back to DEFAULT_WARD_ID for unknown slugs", () => {
    // Unknown tenants — including the retired demo tenants — must not
    // throw. They fall through to the default so downstream code sees a
    // valid ward_id and the observability layer flags them.
    expect(wardIdForTenant("garbatulla")).toBe(DEFAULT_WARD_ID);
    expect(wardIdForTenant("merti")).toBe(DEFAULT_WARD_ID);
    expect(wardIdForTenant("nonexistent")).toBe(DEFAULT_WARD_ID);
    expect(wardIdForTenant("")).toBe(DEFAULT_WARD_ID);
  });

  it("DEFAULT_WARD_ID is Bulla Pesa (the primary demo ward)", () => {
    expect(DEFAULT_WARD_ID).toBe("242");
  });

  it("reverse-maps every ward_id to its canonical tenant slug", () => {
    expect(tenantForWardId("241")).toBe("wabera");
    expect(tenantForWardId("242")).toBe("bula-pesa");
    expect(tenantForWardId("245")).toBe("ngare-mara");
    expect(tenantForWardId("246")).toBe("burat");
    expect(tenantForWardId("247")).toBe("oldonyiro");
  });

  it("reverse-maps unknown ward_ids to the default tenant slug", () => {
    expect(tenantForWardId("999")).toBe("bula-pesa");
    expect(tenantForWardId("")).toBe("bula-pesa");
  });

  it("knownWardIds returns exactly the 5 Isiolo wards", () => {
    const ids = knownWardIds();
    expect(ids).toHaveLength(5);
    expect(new Set(ids)).toEqual(new Set(["241", "242", "245", "246", "247"]));
  });

  describe("wardIdFromLocationText", () => {
    it("returns null on empty / null input", () => {
      expect(wardIdFromLocationText("")).toBeNull();
      expect(wardIdFromLocationText(null)).toBeNull();
      expect(wardIdFromLocationText(undefined)).toBeNull();
    });

    it("maps Bulla Pesa spellings and its neighborhoods to ward 242", () => {
      expect(wardIdFromLocationText("Bulla Pesa")).toBe("242");
      expect(wardIdFromLocationText("Bula Pesa town")).toBe("242");
      expect(wardIdFromLocationText("kula pesa")).toBe("242");
      expect(wardIdFromLocationText("I am near Gotu today")).toBe("242");
    });

    it("maps Ngare Mara + Kambi Garba to ward 245", () => {
      // Kambi Garba is a landmark inside Ngare Mara ward that herders
      // frequently name instead of the ward itself. The fork's alias
      // table includes this specifically.
      expect(wardIdFromLocationText("Ngare Mara")).toBe("245");
      expect(wardIdFromLocationText("ngaremara")).toBe("245");
      expect(wardIdFromLocationText("we are grazing at Kambi Garba")).toBe(
        "245",
      );
    });

    it("maps Wabera, Burat and Oldonyiro variants", () => {
      expect(wardIdFromLocationText("Wabera")).toBe("241");
      expect(wardIdFromLocationText("BURAT")).toBe("246");
      expect(wardIdFromLocationText("Oldonyiro market")).toBe("247");
      // 'oldony iro' handles the spelling seen in one seeded pastoralist row.
      expect(wardIdFromLocationText("oldony iro")).toBe("247");
    });

    it("returns null when the location has no known alias", () => {
      expect(wardIdFromLocationText("Nairobi")).toBeNull();
      expect(wardIdFromLocationText("some random place")).toBeNull();
    });
  });

  describe("regression guard — retired tenant strings must not appear in prod code", () => {
    // Guard against re-introducing the retired demo tenants as identifiers
    // in production code. Docs and archived migrations are allowed to name
    // them (they document the retirement). We grep for exact word matches
    // and let tests reference them freely.
    const REPO_ROOT = path.resolve(__dirname, "..", "..");
    const RETIRED_TOKENS = ["garbatulla", "merti", "kinna"];

    for (const token of RETIRED_TOKENS) {
      it(`no non-test, non-doc code references '${token}'`, () => {
        // `git grep -l` limits the search to tracked files, which avoids
        // scanning node_modules or build output.
        let hits: string[];
        try {
          // wardMapping.ts is the canonical file that documents the
          // retirement, so it must be allowed to reference the tokens.
          const out = execSync(
            `git grep -l -w "${token}" -- ` +
              `':(exclude)*.md' ` +
              `':(exclude)docs/**' ` +
              `':(exclude)**/docs/**' ` +
              `':(exclude)**/*.test.ts' ` +
              `':(exclude)**/tests/**' ` +
              `':(exclude)**/seed-data/**' ` +
              `':(exclude)**/migrations/**' ` +
              `':(exclude)**/CHANGELOG.md' ` +
              // Files that intentionally *document* the retirement.
              `':(exclude)ardalink-api/src/lib/wardMapping.ts' ` +
              `':(exclude)ardalink-engine/ardalink_engine/src/api/satellite.py'`,
            { cwd: REPO_ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
          );
          hits = out.trim().split("\n").filter(Boolean);
        } catch (err: unknown) {
          // git grep exits 1 when it finds nothing — treat as success.
          const status = (err as { status?: number }).status;
          if (status === 1) hits = [];
          else throw err;
        }

        expect(
          hits,
          `Retired token '${token}' reappeared in production code:\n${hits.join("\n")}`,
        ).toEqual([]);
      });
    }

    it("seed-demo.sql explicitly retires garbatulla and merti", () => {
      // The seed is allowed to mention retired tenants because it deletes
      // them on replay. This assertion just confirms the DELETE is still
      // there — if a future refactor removes it, this test fails loudly.
      const seed = readFileSync(
        path.join(REPO_ROOT, "ardalink-api", "docs", "local-dev", "seed-data", "seed-demo.sql"),
        "utf8",
      );
      expect(seed).toMatch(/garbatulla/);
      expect(seed).toMatch(/merti/);
      expect(seed.toLowerCase()).toMatch(/delete\s+from/);
    });
  });
});
