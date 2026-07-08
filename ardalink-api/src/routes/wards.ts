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

export default router;
