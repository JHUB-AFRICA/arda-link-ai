import { describe, expect, it } from "vitest";
import {
  DEFAULT_WARD_ID,
  knownWardIds,
  tenantForWardId,
  wardIdForTenant,
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
});
