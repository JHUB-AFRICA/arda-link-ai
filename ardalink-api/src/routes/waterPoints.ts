/**
 * Water-points surface — backed by the WPDx (Water Point Data
 * Exchange) snapshot in `data/wpdxIsiolo.ts`.
 *
 *   GET /api/water-points/near?lat=X&lon=Y&limit=5&working_only=true
 *   GET /api/water-points/ward/:ward
 *   GET /api/water-points/status
 *
 * Public paths — the snapshot is aggregated open data (CC-BY WPDx),
 * no per-herder rows involved. Kept public so the /talk app and the
 * dashboard's ward-map component can both consume without minting
 * bearer tokens.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  nearestPoints,
  pointsForWard,
  totalCount,
  workingCount,
  type NearbyPoint,
} from "../lib/wpdx.js";

const router: IRouter = Router();

interface WpdxApiPoint {
  wpdxId: string;
  ward: string | null;
  subCounty: string | null;
  lat: number;
  lon: number;
  displayName: string;
  waterSource: string | null;
  waterTech: string | null;
  facilityType: string | null;
  status: "working" | "broken" | "unknown";
  reportDate: string | null;
  distanceKm: number | null;
}

function toApi(np: NearbyPoint, includeDistance = true): WpdxApiPoint {
  return {
    wpdxId: np.point.wpdxId,
    ward: np.point.ward,
    subCounty: np.point.subCounty,
    lat: np.point.lat,
    lon: np.point.lon,
    displayName: np.displayName,
    waterSource: np.point.waterSource,
    waterTech: np.point.waterTech,
    facilityType: np.point.facilityType,
    status: np.status,
    reportDate: np.point.reportDate,
    distanceKm: includeDistance ? Math.round(np.distanceKm * 10) / 10 : null,
  };
}

router.get(
  "/water-points/near",
  (req: Request, res: Response): void => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({ error: "lat + lon required (decimal degrees)" });
      return;
    }
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "5"), 10) || 5, 1),
      50,
    );
    const workingOnly = /^(true|1|yes)$/i.test(
      String(req.query.working_only ?? ""),
    );
    const rows = nearestPoints({ lat, lon }, limit, { workingOnly });
    res.json({
      origin: { lat, lon },
      workingOnly,
      count: rows.length,
      points: rows.map((r) => toApi(r, true)),
    });
  },
);

router.get(
  "/water-points/ward/:ward",
  (req: Request, res: Response): void => {
    const ward = String(req.params.ward ?? "");
    const rows = pointsForWard(ward);
    res.json({
      ward,
      count: rows.length,
      points: rows.map((r) => toApi(r, false)),
    });
  },
);

router.get(
  "/water-points/status",
  (_req: Request, res: Response): void => {
    res.json({
      dataset: "WPDx-Plus (eqje-vguj)",
      county: "Isiolo",
      total: totalCount(),
      working: workingCount(),
      broken: totalCount() - workingCount(),
      source_url: "https://data.waterpointdata.org/resource/eqje-vguj.json",
      license: "CC-BY 4.0",
    });
  },
);

export default router;
