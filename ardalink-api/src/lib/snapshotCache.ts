import { desc } from "drizzle-orm";
import {
  db,
  satelliteSnapshotsTable,
  climateSnapshotsTable,
} from "@workspace/db";
import type { IntelligenceResult } from "./intelligence.js";
import type { ClimateSnapshot } from "./climate.js";
import type { VegetationForecast } from "./predict.js";
import { logger } from "./logger.js";
import {
  DEFAULT_WARD_ID,
  assertKnownTenant,
  isKnownTenant,
  tenantForWardId,
} from "./wardMapping.js";

const DEFAULT_SNAPSHOT_TENANT = tenantForWardId(DEFAULT_WARD_ID);

/**
 * Resolve the tenant slug for a fire-and-forget cache write.
 *
 * Pre-2026-07-21 this silently fell back to the pseudo-tenant `"isiolo"`
 * when the caller forgot to attach a `tenant_id` — those rows are now
 * orphaned in the local DB because no operator's tenant_id matches
 * `"isiolo"`. We now log a warning and default to the canonical
 * `bula-pesa` (DEFAULT_WARD_ID) tenant so the row is at least
 * queryable from the demo dashboard.
 */
function resolveTenant(candidate: string | undefined, source: string): string {
  if (isKnownTenant(candidate)) return candidate!;
  logger.warn(
    { candidate, source, fallback: DEFAULT_SNAPSHOT_TENANT },
    "[Cache] Missing/unknown tenant_id on snapshot; using default",
  );
  return DEFAULT_SNAPSHOT_TENANT;
}

export async function saveSatelliteSnapshot(
  result: IntelligenceResult,
): Promise<void> {
  const newestImageDate =
    result.live.imageDates[result.live.imageDates.length - 1] ?? "";
  const tenantId = resolveTenant(
    (result as { tenant_id?: string }).tenant_id,
    "saveSatelliteSnapshot",
  );
  try {
    // Belt-and-braces: throws only when resolveTenant is buggy, but
    // makes the invariant explicit at the DB boundary.
    assertKnownTenant(tenantId);
    await db.insert(satelliteSnapshotsTable).values({
      newestImageDate,
      result: result as unknown as Record<string, unknown>,
      // Phase 12 — fire-and-forget path runs after the request context
      // is torn down, so the GUC `app.current_tenant_id` is unset. Pass
      // the tenant explicitly to satisfy the RLS `tenant_isolation`
      // policy on the `satellite_snapshots` table.
      tenantId,
    });
    logger.info({ newestImageDate, tenantId }, "[Cache] Satellite snapshot persisted");
  } catch (err) {
    logger.error({ err }, "[Cache] Failed to persist satellite snapshot");
  }
}

export async function loadLatestSatelliteSnapshot(): Promise<IntelligenceResult | null> {
  try {
    const [row] = await db
      .select()
      .from(satelliteSnapshotsTable)
      .orderBy(desc(satelliteSnapshotsTable.capturedAt))
      .limit(1);
    if (!row) return null;
    return row.result as unknown as IntelligenceResult;
  } catch (err) {
    logger.error({ err }, "[Cache] Failed to load satellite snapshot");
    return null;
  }
}

export async function saveClimateSnapshot(
  climate: ClimateSnapshot,
  forecast: VegetationForecast | undefined,
): Promise<void> {
  const tenantId = resolveTenant(
    (climate as { tenant_id?: string }).tenant_id,
    "saveClimateSnapshot",
  );
  try {
    assertKnownTenant(tenantId);
    await db.insert(climateSnapshotsTable).values({
      climate: climate as unknown as Record<string, unknown>,
      forecast: (forecast ?? null) as unknown as Record<string, unknown> | null,
      // Phase 12 — same RLS rationale as satellite_snapshots.
      tenantId,
    });
    logger.info({ tenantId }, "[Cache] Climate snapshot persisted");
  } catch (err) {
    logger.error({ err }, "[Cache] Failed to persist climate snapshot");
  }
}

export async function loadLatestClimateSnapshot(): Promise<{
  climate: ClimateSnapshot;
  forecast: VegetationForecast | undefined;
  capturedAt: Date;
} | null> {
  try {
    const [row] = await db
      .select()
      .from(climateSnapshotsTable)
      .orderBy(desc(climateSnapshotsTable.capturedAt))
      .limit(1);
    if (!row) return null;
    return {
      climate: row.climate as unknown as ClimateSnapshot,
      forecast: (row.forecast ?? undefined) as unknown as
        | VegetationForecast
        | undefined,
      capturedAt: row.capturedAt,
    };
  } catch (err) {
    logger.error({ err }, "[Cache] Failed to load climate snapshot");
    return null;
  }
}
