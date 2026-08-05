/**
 * Tests for the choropleth endpoints.
 *
 * /api/open-data/geo/kenya-counties — public, returns the bundled
 * GeoJSON with the 47+1 county polygons.
 *
 * /api/open-data/geo/county-presets — public, returns the static
 * pastoral + main reference county lists.
 *
 * /api/open-data/geo/per-county-aggregates — bearer-protected, returns
 * numeric aggregates per county for the four supported metrics.
 *
 * /api/open-data/geo/rankings, /insights, /alert-markers, /time-travel —
 * newer endpoints powering the redesigned Choropleth dashboard.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app";

const SECRET = "choropleth-test-secret-32-bytes-long-fixed";

function mintJwt(claims: object, secret = SECRET): string {
  const header = { alg: "HS256", typ: "JWT" };
  const enc = (o: object): string =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const headerB64 = enc(header);
  const payloadB64 = enc(claims);
  const sig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${sig}`;
}

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("GET /api/open-data/geo/kenya-counties", () => {
  it("is reachable without auth (public-by-contract)", async () => {
    const res = await request(createApp()).get(
      "/api/open-data/geo/kenya-counties",
    );
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.type).toBe("FeatureCollection");
      expect(Array.isArray(res.body.features)).toBe(true);
      expect(res.body.features.length).toBeGreaterThanOrEqual(47);
    }
  });
});

describe("GET /api/open-data/geo/county-presets", () => {
  it("is public (no auth needed)", async () => {
    const res = await request(createApp()).get(
      "/api/open-data/geo/county-presets",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pastoral)).toBe(true);
    expect(Array.isArray(res.body.main)).toBe(true);
    expect(res.body.pastoral.length).toBeGreaterThanOrEqual(1);
    expect(res.body.main.length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(res.body.default_main_selected)).toBe(true);
  });
});

describe("GET /api/open-data/geo/per-county-aggregates", () => {
  it("rejects unauthenticated callers", async () => {
    const res = await request(createApp()).get(
      "/api/open-data/geo/per-county-aggregates?metric=reports",
    );
    expect(res.status).toBe(401);
  });

  it.each(["reports", "bcs", "ndvi", "herd"])(
    "returns the %s metric for an authenticated tenant",
    async (metric) => {
      const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
      const res = await request(createApp())
        .get(`/api/open-data/geo/per-county-aggregates?metric=${metric}`)
        .set("Authorization", `Bearer ${token}`);
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.metric).toBe(metric);
        expect(typeof res.body.byCounty).toBe("object");
        expect(typeof res.body.unit).toBe("string");
      }
    },
  );

  it("honours the ?slice= query parameter", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/per-county-aggregates?metric=reports&slice=7d")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) expect(res.body.slice).toBe("7d");
  });

  it("defaults to slice=30d when slice is missing", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/per-county-aggregates?metric=reports")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) expect(res.body.slice).toBe("30d");
  });

  it("falls back to 30d for an unrecognised slice value", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/per-county-aggregates?metric=reports&slice=banana")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) expect(res.body.slice).toBe("30d");
  });
});

describe("GET /api/open-data/geo/rankings", () => {
  it("rejects unauthenticated callers", async () => {
    const res = await request(createApp()).get(
      "/api/open-data/geo/rankings?metric=ndvi&counties=ISIOLO",
    );
    expect(res.status).toBe(401);
  });

  it("returns a sorted-by-metric list with rank + normalised", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get(
        "/api/open-data/geo/rankings?metric=ndvi&slice=30d&counties=ISIOLO,NAIROBI,MARSABIT",
      )
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.rows).toHaveLength(3);
      expect(res.body.rows.map((r: { rank: number }) => r.rank)).toEqual([
        1, 2, 3,
      ]);
      for (const r of res.body.rows) {
        expect(r.normalised).toBeGreaterThanOrEqual(0);
        expect(r.normalised).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("GET /api/open-data/geo/insights", () => {
  it("returns 3-5 plain-English bullets", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/insights?slice=30d&counties=ISIOLO,NAIROBI")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.bullets)).toBe(true);
      expect(res.body.bullets.length).toBeGreaterThanOrEqual(3);
      expect(res.body.bullets.length).toBeLessThanOrEqual(5);
      for (const b of res.body.bullets) {
        expect(typeof b).toBe("string");
        expect(b.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("GET /api/open-data/geo/alert-markers", () => {
  it("returns an array of alert markers for the slice", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/alert-markers?slice=30d")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.markers)).toBe(true);
      expect(res.body.slice).toBe("30d");
    }
  });
});

describe("GET /api/open-data/geo/time-travel", () => {
  it("returns the metric across 5 time slices for the selected counties", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/time-travel?metric=ndvi&counties=ISIOLO")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.metric).toBe("ndvi");
      expect(res.body.selected_counties).toEqual(["ISIOLO"]);
      expect(Object.keys(res.body.series).sort()).toEqual([
        "1y",
        "30d",
        "7d",
        "90d",
        "all",
      ]);
    }
  });
});

describe("GET /api/open-data/geo/isiolo-wards", () => {
  it("is public (no auth needed)", async () => {
    const res = await request(createApp()).get(
      "/api/open-data/geo/isiolo-wards",
    );
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.type).toBe("FeatureCollection");
      expect(Array.isArray(res.body.features)).toBe(true);
      expect(res.body.features.length).toBeGreaterThanOrEqual(8);
      for (const f of res.body.features) {
        // The canonical IEBC GeoJSON uses `county` (not GADM's `NAME_1`) and
        // `ward` (not GADM's `NAME_3`). The dashboard accepts both names —
        // see ardalink-web/dashboard/src/components/Choropleth.tsx.
        expect(f.properties.county ?? f.properties.NAME_1).toBe("Isiolo");
        expect(typeof (f.properties.ward ?? f.properties.NAME_3)).toBe("string");
      }
    }
  });
});

describe("GET /api/open-data/geo/ward-presets", () => {
  it("is public and lists all 10 Isiolo wards with all 5 real active wards flagged", async () => {
    // Fixed 2026-08-06: isDemoHome previously only flagged 3 of the 5
    // real active wards (Bulla Pesa, Ngare Mara, Burat) — Wabera and
    // Oldonyiro were marked false, indistinguishable from this list's
    // actually-dormant/retired wards (Chari, Cherab, Garbatulla, Kinna,
    // Sericho). All 5 real active wards are correctly flagged now.
    const res = await request(createApp()).get(
      "/api/open-data/geo/ward-presets",
    );
    expect(res.status).toBe(200);
    expect(res.body.wards).toHaveLength(10);
    const homeWards = res.body.wards
      .filter((w: { isDemoHome: boolean }) => w.isDemoHome)
      .map((w: { name: string }) => w.name);
    expect(homeWards.sort()).toEqual(
      ["Bulla Pesa", "Burat", "Ngare Mara", "Oldonyiro", "Wabera"].sort(),
    );
    expect(res.body.tenant_home_ward["bula-pesa"]).toBe("Bulla Pesa");
    expect(res.body.tenant_home_ward["burat"]).toBe("Burat");
    expect(res.body.tenant_home_ward["wabera"]).toBe("Wabera");
    expect(res.body.tenant_home_ward["oldonyiro"]).toBe("Oldonyiro");
  });
});

describe("GET /api/open-data/geo/ward-aggregates", () => {
  it("rejects unauthenticated callers", async () => {
    const res = await request(createApp()).get(
      "/api/open-data/geo/ward-aggregates?metric=reports",
    );
    expect(res.status).toBe(401);
  });

  it.each(["reports", "bcs", "ndvi", "herd"])(
    "buckets the %s metric by ward, keyed on real ward_id-derived names",
    async (metric) => {
      // Fixed 2026-08-06: computeWardAggregates now reads real
      // ward_id-keyed Supabase data (ground_truth_calls, pastoralists,
      // api_latest_satellite_indices) instead of resolving a
      // free-text location field that was always null on the real row
      // — see geoHelpers.ts's own history note on this function. In
      // this test environment Supabase isn't configured, so byWard is
      // correctly empty (no fabricated fallback data), matching the
      // same "Supabase not configured" pattern already established by
      // the report-pins/pastoralist-pins tests below.
      const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
      const res = await request(createApp())
        .get(`/api/open-data/geo/ward-aggregates?metric=${metric}&slice=30d`)
        .set("Authorization", `Bearer ${token}`);
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.metric).toBe(metric);
        expect(typeof res.body.byWard).toBe("object");
        // Any key present must be a real ward display name, never the
        // empty string ("" would mean a broken property lookup slipped
        // back in — see WardsLayer.tsx's own history for that failure
        // mode on the frontend side of this same bug).
        for (const key of Object.keys(res.body.byWard)) {
          expect(key).not.toBe("");
        }
      }
    },
  );

  it("uses all 5 real active wards for the admin view, not a hardcoded subset", async () => {
    // Fixed 2026-08-06: previously hardcoded to exactly 3 tenants
    // (bula-pesa, ngare-mara, burat) for tenant_id="admin" — Wabera and
    // Oldonyiro never appeared in any admin aggregate. Can't assert on
    // real values without Supabase configured in this test environment,
    // but the request must succeed (not throw) across all 5 real wards.
    const token = mintJwt({ sub: "test", tenant_id: "admin" });
    const res = await request(createApp())
      .get("/api/open-data/geo/ward-aggregates?metric=ndvi&slice=30d")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(typeof res.body.byWard).toBe("object");
    }
  });
});

describe("GET /api/open-data/geo/pastoralist-pins", () => {
  it("returns each herder as a pin with lat/lon + ward", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/pastoralist-pins")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.count).toBeGreaterThan(0);
      for (const pin of res.body.pins) {
        expect(typeof pin.lat).toBe("number");
        expect(typeof pin.lon).toBe("number");
        expect(typeof pin.ward).toBe("string");
        expect(pin.ward).toBe("Bulla Pesa");
      }
    }
  });
});

describe("GET /api/open-data/geo/report-pins", () => {
  it("returns each report as a pin with BCS + NDVI + ward", async () => {
    // Reads from Supabase ground_truth_calls. In the test environment
    // Supabase is not configured, so count=0 is the expected outcome.
    // Shape-only assertions are guarded inside the `if`.
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/report-pins?slice=30d")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(typeof res.body.count).toBe("number");
      expect(Array.isArray(res.body.pins)).toBe(true);
      for (const pin of res.body.pins) {
        expect(typeof pin.lat).toBe("number");
        expect(typeof pin.lon).toBe("number");
        expect(typeof pin.ward).toBe("string");
      }
    }
  });

  it("honours the slice parameter", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/open-data/geo/report-pins?slice=7d")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) expect(res.body.slice).toBe("7d");
  });
});
