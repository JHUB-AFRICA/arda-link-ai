/**
 * Satellite routes — live GEE VCI and MODIS NDVI data.
 *
 * Proxies requests to the ArdaLink engine's `/api/v1/satellite/*` endpoints,
 * which wrap the Google Earth Engine pipeline.
 *
 * Routes:
 * - GET /api/satellite/vci?ward=<ward_id>
 * - POST /api/satellite/trigger
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { fetchSatelliteVCI, triggerSatelliteRefresh, type VCISnapshot } from "../lib/engine.js";
import { logger } from "../lib/logger.js";
import { withTenantContext } from "../lib/tenancy-context.js";
import { satelliteSnapshotsTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * GET /api/satellite/vci?ward=<ward_id>
 *
 * Returns the live Vegetation Condition Index for a single ward.
 * Proxies to the engine and returns 503 when GEE is not configured.
 */
router.get("/satellite/vci", async (req: Request, res: Response): Promise<void> => {
  const wardId = req.query.ward as string;
  if (!wardId) {
    res.status(400).json({ error: "missing_ward", message: "ward query parameter is required" });
    return;
  }

  try {
    // The engine's tenancy middleware requires an attested X-Tenant-ID header
    // when TENANT_ATTESTATION_SECRET is set. Fall back to "isiolo" when the
    // caller has no bound tenant (public/demo requests).
    const tenantId = req.tenant?.tenant_id ?? "isiolo";
    const vci = await fetchSatelliteVCI(wardId, tenantId);

    if (!vci) {
      res.status(503).json({
        error: "engine_unreachable",
        message: "ArdaLink engine is not responding. Ensure it's running on the configured port.",
      });
      return;
    }

    // Also write to satellite_snapshots table for persistence
    await withTenantContext(tenantId, async (tx) => {
      await tx
        .insert(satelliteSnapshotsTable)
        .values({
          tenantId,
          newestImageDate: vci.captured_at.split("T")[0] ?? new Date().toISOString().split("T")[0],
          result: {
            ward_id: vci.ward_id,
            ward_name: vci.ward_name,
            vci: vci.vci,
            ndvi_now: vci.ndvi_now,
            ndvi_min: vci.ndvi_min,
            ndvi_max: vci.ndvi_max,
            urban_masked: vci.urban_masked,
            prosopis_factor: vci.prosopis_factor,
            captured_at: vci.captured_at,
          },
        })
        .onConflictDoNothing(); // Don't overwrite if recent snapshot exists
    });

    logger.info({ wardId, vci: vci.vci }, "[Satellite] VCI fetched and cached");
    res.json(vci);
  } catch (err: unknown) {
    logger.error({ err, wardId }, "[Satellite] VCI fetch failed");
    res.status(500).json({ error: "satellite_fetch_failed", message: String(err) });
  }
});

/**
 * POST /api/satellite/trigger?dryRun=false
 *
 * Triggers VCI fetch for all demo wards (Bula Pesa, Garbatulla, Kinna).
 * Used by the satellite scheduler and manual trigger from the dashboard.
 */
router.post("/satellite/trigger", async (req: Request, res: Response): Promise<void> => {
  const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

  try {
    const tenantId = req.tenant?.tenant_id ?? "isiolo";
    const result = await triggerSatelliteRefresh(dryRun, tenantId);

    if (!result) {
      res.status(503).json({
        error: "engine_unreachable",
        message: "ArdaLink engine is not responding.",
      });
      return;
    }

    // If successful and not a dry run, write results to satellite_snapshots
    if (result.status === "success" && result.results && !dryRun) {
      for (const [wardId, snapshot] of Object.entries(result.results)) {
        if (!snapshot) continue;

        await withTenantContext(tenantId, async (tx) => {
          await tx
            .insert(satelliteSnapshotsTable)
            .values({
              tenantId,
              newestImageDate: new Date().toISOString().split("T")[0],
              result: snapshot,
            })
            .onConflictDoNothing();
        });
      }

      logger.info(
        { wards: result.wards, status: result.status },
        "[Satellite] Trigger completed and snapshots written",
      );
    }

    res.json(result);
  } catch (err: unknown) {
    logger.error({ err }, "[Satellite] Trigger failed");
    res.status(500).json({ error: "satellite_trigger_failed", message: String(err) });
  }
});

/**
 * GET /api/satellite/snapshots?limit=10
 *
 * Returns recent satellite snapshots from the database.
 * Useful for the dashboard to display historical VCI trends.
 */
router.get("/satellite/snapshots", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 10)));

  try {
    const tenantId = req.tenant?.tenant_id;
    if (!tenantId) {
      res.status(401).json({ error: "unauthorized", message: "Tenant context required" });
      return;
    }

    const snapshots = await withTenantContext(tenantId, async (tx) => {
      return tx
        .select({
          id: satelliteSnapshotsTable.id,
          capturedAt: satelliteSnapshotsTable.capturedAt,
          newestImageDate: satelliteSnapshotsTable.newestImageDate,
          result: satelliteSnapshotsTable.result,
        })
        .from(satelliteSnapshotsTable)
        .orderBy(satelliteSnapshotsTable.capturedAt)
        .limit(limit);
    });

    res.json({
      tenant_id: tenantId,
      count: snapshots.length,
      snapshots,
    });
  } catch (err: unknown) {
    logger.error({ err }, "[Satellite] Snapshots fetch failed");
    res.status(500).json({ error: "snapshots_fetch_failed", message: String(err) });
  }
});

export default router;
