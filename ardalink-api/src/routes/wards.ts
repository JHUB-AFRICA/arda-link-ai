/**
 * Ward geometry surface — served from Supabase's PostGIS data.
 *
 *   GET /api/wards/map
 *
 * Returns a compact JSON structure sized for the operator dashboard's
 * ward-map component: 5 active-ward polygons + their latest NDVI +
 * their adjacency graph. Everything cached, so back-to-back reloads of
 * the dashboard don't hammer Supabase.
 *
 * When Supabase is unconfigured or unreachable, the endpoint returns
 * `{ ready: false }` so the client can render an empty state instead
 * of a spinner.
 */

import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import {
  isSupabaseConfigured,
  latestSatelliteFor,
  listActiveWardsWithGeometry,
  listWardNeighbors,
  fetchWardMonthlyBaseline,
  computeVci,
  countWorseThanYears,
} from "../lib/supabase.js";

interface WardMapWard {
  ward_id: string;
  name: string;
  county: string;
  centroid: { type: "Point"; coordinates: [number, number] } | null;
  geometry: {
    type: "MultiPolygon";
    coordinates: number[][][][];
  } | null;
  ndvi_mean: number | null;
  vci_value: number | null;
  ndre_mean: number | null;
  period_end: string | null;
}

interface WardMapEdge {
  a: string;
  b: string;
  km: number;
}

interface WardMapResponse {
  ready: boolean;
  wards: WardMapWard[];
  edges: WardMapEdge[];
  supabase: { configured: boolean; reachable: boolean };
}

const router: IRouter = Router();

router.get("/wards/map", async (_req, res): Promise<void> => {
  if (!isSupabaseConfigured()) {
    const empty: WardMapResponse = {
      ready: false,
      wards: [],
      edges: [],
      supabase: { configured: false, reachable: false },
    };
    res.json(empty);
    return;
  }

  try {
    const wards = await listActiveWardsWithGeometry();
    if (!wards || wards.length === 0) {
      const empty: WardMapResponse = {
        ready: false,
        wards: [],
        edges: [],
        supabase: { configured: true, reachable: false },
      };
      res.json(empty);
      return;
    }

    // Fetch latest satellite + neighbor lists in parallel per ward. Each
    // helper is individually cached, so a second dashboard reload is a
    // no-op on the Supabase side.
    const [sats, neighborLists] = await Promise.all([
      Promise.all(wards.map((w) => latestSatelliteFor(w.ward_id))),
      Promise.all(wards.map((w) => listWardNeighbors(w.ward_id))),
    ]);

    const mapWards: WardMapWard[] = wards.map((w, i) => {
      const sat = sats[i];
      return {
        ward_id: w.ward_id,
        name: w.name,
        county: w.county,
        centroid: w.centroid,
        geometry: w.geometry,
        ndvi_mean: sat?.ndvi_mean ?? null,
        vci_value: sat?.vci_value ?? null,
        ndre_mean: sat?.ndre_mean ?? null,
        period_end: sat?.period_end ?? null,
      };
    });

    // Deduplicate the adjacency edges — ward_neighbors stores both
    // directions of every edge (A→B and B→A). Emit one row per
    // undirected pair so the dashboard doesn't render doubled lines.
    const edgeSet = new Set<string>();
    const edges: WardMapEdge[] = [];
    for (let i = 0; i < neighborLists.length; i++) {
      const list = neighborLists[i];
      if (!list) continue;
      for (const n of list) {
        const key = [n.ward_id, n.neighbor_ward_id].sort().join("-");
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({
          a: n.ward_id,
          b: n.neighbor_ward_id,
          km: n.shared_boundary_km,
        });
      }
    }

    const response: WardMapResponse = {
      ready: true,
      wards: mapWards,
      edges,
      supabase: { configured: true, reachable: true },
    };
    res.json(response);
  } catch (err) {
    logger.error({ err }, "[Wards] Failed to build ward map response");
    const failed: WardMapResponse = {
      ready: false,
      wards: [],
      edges: [],
      supabase: { configured: true, reachable: false },
    };
    res.status(500).json(failed);
  }
});

/**
 * GET /api/wards/:ward_id/baseline?month=6
 *
 * Debug / dashboard endpoint — returns the historical NDVI envelope
 * for one ward at one calendar month, plus the current reading and
 * derived VCI. Ops team uses this to sanity-check what herder-facing
 * surfaces are saying.
 *
 * If ?month is omitted, uses the current UTC month.
 *
 * Shape:
 *   {
 *     ready: true,
 *     wardId, month,
 *     baseline: { years, yearsSpan, ndvi: {min,max,p5,p50,p95,mean,stdev,minYear,maxYear}, ndre? },
 *     current:  { ndviMean, periodEnd },
 *     derived:  { vci, worseThanYears, driestYearOnRecord }
 *   }
 */
router.get("/wards/:wardId/baseline", async (req, res): Promise<void> => {
  const wardId = req.params.wardId;
  const monthParam = Number(req.query.month);
  const month =
    Number.isFinite(monthParam) && monthParam >= 1 && monthParam <= 12
      ? Math.floor(monthParam)
      : new Date().getUTCMonth() + 1;

  if (!isSupabaseConfigured()) {
    res.json({
      ready: false,
      reason: "supabase_not_configured",
      wardId,
      month,
    });
    return;
  }

  try {
    const [baseline, current] = await Promise.all([
      fetchWardMonthlyBaseline(wardId, month),
      latestSatelliteFor(wardId),
    ]);

    if (!baseline) {
      res.json({
        ready: false,
        reason: "no_baseline",
        wardId,
        month,
        current: current
          ? { ndviMean: current.ndvi_mean, periodEnd: current.period_end }
          : null,
      });
      return;
    }

    const vci = computeVci(current?.ndvi_mean ?? null, baseline);
    const worse = countWorseThanYears(current?.ndvi_mean ?? null, baseline);

    res.json({
      ready: true,
      wardId,
      month,
      baseline: {
        years: baseline.years,
        yearsSpan: baseline.yearsSpan,
        ndvi: baseline.ndvi,
        ndre: baseline.ndre,
      },
      current: current
        ? {
            ndviMean: current.ndvi_mean,
            ndreMean: current.ndre_mean,
            periodEnd: current.period_end,
          }
        : null,
      derived: {
        vci,
        worseThanYears: worse?.worseThan ?? null,
        totalYears: worse?.totalYears ?? null,
        driestYearOnRecord: baseline.ndvi.minYear,
      },
    });
  } catch (err) {
    logger.error({ err, wardId, month }, "[Wards] baseline query failed");
    res.status(500).json({ ready: false, reason: "query_failed" });
  }
});

/**
 * GET /api/wards/timeseries
 *
 * Compact time-series feed for the dashboard NDVI + rainfall panels.
 * Returns per-ward:
 *   - ndvi:     last 12 months of monthly ndvi_mean from satellite_indices
 *   - forecast: next 14 days of rainfall_mm_p50 / p95 / prob from weather_forecast
 *   - weather:  latest weather observation (30d rainfall, temp)
 *
 * One request lets the panel render all 5 wards. Tenant-exempt (public
 * aggregate) so the map/dashboard can show it without a Bearer.
 */
router.get("/wards/timeseries", async (_req, res): Promise<void> => {
  if (!isSupabaseConfigured()) {
    res.json({ ready: false, reason: "supabase_not_configured", wards: [] });
    return;
  }
  try {
    const sbBase = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
    const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };
    const wards = await listActiveWardsWithGeometry();
    if (!wards || wards.length === 0) {
      res.json({ ready: false, reason: "no_wards", wards: [] });
      return;
    }
    const cutoff12mo = new Date();
    cutoff12mo.setMonth(cutoff12mo.getMonth() - 12);
    const cutoffFcst = new Date();
    cutoffFcst.setHours(0, 0, 0, 0);

    const perWard = await Promise.all(
      wards.map(async (w) => {
        const ndviUrl =
          `${sbBase}/rest/v1/satellite_indices?ward_id=eq.${encodeURIComponent(w.ward_id)}` +
          `&period_end=gte.${encodeURIComponent(cutoff12mo.toISOString())}` +
          `&select=period_end,ndvi_mean,vci_value&order=period_end.asc&limit=24`;
        const fcstUrl =
          `${sbBase}/rest/v1/weather_forecast?ward_id=eq.${encodeURIComponent(w.ward_id)}` +
          `&target_date=gte.${encodeURIComponent(cutoffFcst.toISOString().slice(0, 10))}` +
          `&select=target_date,rainfall_mm_p50,rainfall_mm_p95,precipitation_probability,temperature_c_max` +
          `&order=target_date.asc,generated_at.desc&limit=14`;
        try {
          const [ndviRes, fcstRes] = await Promise.all([
            fetch(ndviUrl, { headers, signal: AbortSignal.timeout(4_000) }),
            fetch(fcstUrl, { headers, signal: AbortSignal.timeout(4_000) }),
          ]);
          const ndvi = ndviRes.ok
            ? ((await ndviRes.json()) as unknown[])
            : [];
          const forecast = fcstRes.ok
            ? ((await fcstRes.json()) as unknown[])
            : [];
          return {
            ward_id: w.ward_id,
            name: w.name,
            ndvi,
            forecast,
          };
        } catch (err) {
          logger.warn(
            { err: String(err), wardId: w.ward_id },
            "[Wards] timeseries: per-ward fetch failed",
          );
          return {
            ward_id: w.ward_id,
            name: w.name,
            ndvi: [],
            forecast: [],
          };
        }
      }),
    );
    res.json({ ready: true, wards: perWard });
  } catch (err) {
    logger.error({ err }, "[Wards] timeseries failed");
    res.status(500).json({ ready: false, reason: "query_failed", wards: [] });
  }
});

export default router;
