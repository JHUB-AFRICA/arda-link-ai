/**
 * Supabase → local Postgres sync worker.
 *
 * Pulls rows from Supabase primary that were created or updated since
 * the last successful sync, using a per-table `updated_at` watermark
 * stored in module state.
 *
 * On first run after a server restart, each watermark is initialised
 * from the local table's MAX timestamp so the job resumes exactly where
 * it left off instead of re-pulling the full history.
 *
 * Scope — two tables are synced:
 *
 *   pastoralist_leads — ops can insert / update leads directly in the
 *     Supabase dashboard. Without this job those changes would be
 *     invisible to local read paths during a Supabase outage.
 *
 *   weather_data — has a UNIQUE (ward_id, observed_date, source)
 *     constraint locally so a safe batch upsert is possible.
 *
 * lead_interactions and weather_forecast are omitted: interactions are
 * append-only and fully covered by dual-write (localMirror.ts); forecast
 * rows have no stable unique key on the local side today.
 *
 * Error contract: each table sync is independent — a failed weather pull
 * never blocks the lead sync. All errors are warn-logged and swallowed.
 *
 * ENV:
 *   SYNC_JOB_ENABLED   — "false" disables entirely (default: enabled)
 *   SYNC_INTERVAL_MS   — poll interval (default: 300_000 = 5 min)
 *   SYNC_BATCH_SIZE    — max rows per table per cycle (default: 500)
 */

import { eq, inArray, max, sql } from "drizzle-orm";
import {
  db,
  pastoralistLeadsTable,
  weatherDataTable,
  type InsertPastoralistLead,
  type InsertWeatherData,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { sbQuery, isSupabaseConfigured } from "../lib/supabase/index.js";

// ── Config ─────────────────────────────────────────────────────────────────

const FIVE_MIN_MS = 5 * 60 * 1000;
const EPOCH = "1970-01-01T00:00:00.000Z";

const INTERVAL_MS = parseInt(
  process.env.SYNC_INTERVAL_MS ?? String(FIVE_MIN_MS),
  10,
);
const BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE ?? "500", 10);

// ── Supabase row shapes (PostgREST snake_case) ─────────────────────────────

interface SbSyncLead {
  lead_id: string;
  phone_number: string;
  full_name: string | null;
  preferred_language: string | null;
  ward_id: string | null;
  herd_size: number | null;
  enrollment_source: string | null;
  status: string;
  alerts_enabled: boolean;
  first_contact_at: string;
  last_contact_at: string | null;
  verified_at: string | null;
  verified_by: string | null;
  promoted_pastoralist_id: string | null;
  notes: string | null;
  tenant_id: string | null;
  updated_at: string;
}

interface SbSyncWeatherData {
  ward_id: string;
  observed_date: string;
  rainfall_mm_30d: number | null;
  humidity_pct: number | null;
  temperature_c: number | null;
  evapotranspiration_mm: number | null;
  source: string | null;
  tenant_id: string | null;
  updated_at: string;
}

// ── Result types ───────────────────────────────────────────────────────────

export interface SyncTableResult {
  pulled: number;
  upserted: number;
  errors: number;
  newWatermark: string;
}

export interface SyncCycleResult {
  syncedAt: string;
  pastoralistLeads: SyncTableResult;
  weatherData: SyncTableResult;
}

// ── Watermark state ────────────────────────────────────────────────────────

interface Watermarks {
  pastoralistLeads: string;
  weatherData: string;
}

let watermarks: Watermarks | null = null;
let lastCycleResult: SyncCycleResult | null = null;

/**
 * Initialise watermarks from local DB MAX timestamps.
 * Ensures restarts pick up where the last successful sync left off.
 */
async function initWatermarks(): Promise<Watermarks> {
  const [leadRow, weatherRow] = await Promise.all([
    db
      .select({ maxAt: max(pastoralistLeadsTable.updatedAt) })
      .from(pastoralistLeadsTable),
    db
      .select({ maxAt: max(weatherDataTable.updatedAt) })
      .from(weatherDataTable),
  ]);

  return {
    pastoralistLeads:
      leadRow[0]?.maxAt?.toISOString() ?? EPOCH,
    weatherData:
      weatherRow[0]?.maxAt?.toISOString() ?? EPOCH,
  };
}

// ── Per-table sync helpers ─────────────────────────────────────────────────

function sbLeadToInsert(r: SbSyncLead): InsertPastoralistLead {
  return {
    phoneNumber: r.phone_number,
    fullName: r.full_name ?? null,
    preferredLanguage: r.preferred_language ?? null,
    wardId: r.ward_id ?? null,
    location: null,
    herdSize: r.herd_size ?? null,
    enrollmentSource: r.enrollment_source ?? null,
    status: r.status ?? "lead",
    alertsEnabled: r.alerts_enabled ?? true,
    firstContactAt: r.first_contact_at ? new Date(r.first_contact_at) : new Date(),
    lastContactAt: r.last_contact_at ? new Date(r.last_contact_at) : null,
    verifiedAt: r.verified_at ? new Date(r.verified_at) : null,
    verifiedBy: r.verified_by ?? null,
    promotedPastoralistId: r.promoted_pastoralist_id ?? null,
    notes: r.notes ?? null,
    tenantId: r.tenant_id ?? null,
  };
}

function sbWeatherDataToInsert(r: SbSyncWeatherData): InsertWeatherData {
  return {
    wardId: r.ward_id,
    observedDate: r.observed_date,
    rainfallMm30d: r.rainfall_mm_30d != null ? String(r.rainfall_mm_30d) : null,
    humidityPct: r.humidity_pct != null ? String(r.humidity_pct) : null,
    temperatureC: r.temperature_c != null ? String(r.temperature_c) : null,
    evapotranspirationMm:
      r.evapotranspiration_mm != null ? String(r.evapotranspiration_mm) : null,
    source: r.source ?? null,
    tenantId: r.tenant_id ?? null,
  };
}

async function syncPastoralistLeads(
  watermark: string,
  batchSize: number,
): Promise<SyncTableResult> {
  const result: SyncTableResult = {
    pulled: 0,
    upserted: 0,
    errors: 0,
    newWatermark: watermark,
  };

  try {
    const rows = await sbQuery<SbSyncLead>(
      `pastoralist_leads?updated_at=gt.${encodeURIComponent(watermark)}&order=updated_at.asc&limit=${batchSize}`,
    );
    if (!rows || rows.length === 0) return result;

    result.pulled = rows.length;

    // Batch-check which phones already exist locally. The local table
    // has no UNIQUE on phone_number (only an index — migration 0003),
    // so ON CONFLICT is unavailable. A future migration adding
    // UNIQUE(phone_number) will collapse this into a single upsert.
    const phones = rows.map((r) => r.phone_number);
    const existingSet = new Set<string>(
      (
        await db
          .select({ phone: pastoralistLeadsTable.phoneNumber })
          .from(pastoralistLeadsTable)
          .where(inArray(pastoralistLeadsTable.phoneNumber, phones))
      ).map((r) => r.phone),
    );

    const toInsert = rows.filter((r) => !existingSet.has(r.phone_number));
    const toUpdate = rows.filter((r) => existingSet.has(r.phone_number));

    if (toInsert.length > 0) {
      await db
        .insert(pastoralistLeadsTable)
        .values(toInsert.map(sbLeadToInsert));
      result.upserted += toInsert.length;
    }

    for (const row of toUpdate) {
      try {
        await db
          .update(pastoralistLeadsTable)
          .set({
            fullName: row.full_name ?? null,
            preferredLanguage: row.preferred_language ?? null,
            wardId: row.ward_id ?? null,
            herdSize: row.herd_size ?? null,
            enrollmentSource: row.enrollment_source ?? null,
            status: row.status ?? "lead",
            alertsEnabled: row.alerts_enabled ?? true,
            lastContactAt: row.last_contact_at
              ? new Date(row.last_contact_at)
              : null,
            verifiedAt: row.verified_at ? new Date(row.verified_at) : null,
            verifiedBy: row.verified_by ?? null,
            promotedPastoralistId: row.promoted_pastoralist_id ?? null,
            notes: row.notes ?? null,
            tenantId: row.tenant_id ?? null,
            updatedAt: new Date(),
          })
          .where(
            eq(pastoralistLeadsTable.phoneNumber, row.phone_number),
          );
        result.upserted++;
      } catch (err) {
        result.errors++;
        logger.warn(
          { err: String(err), phone: row.phone_number },
          "[SyncJob] pastoralist_leads UPDATE failed",
        );
      }
    }

    result.newWatermark = rows[rows.length - 1]!.updated_at;
  } catch (err) {
    logger.warn(
      { err: String(err), watermark },
      "[SyncJob] pastoralist_leads sync failed",
    );
  }

  return result;
}

async function syncWeatherData(
  watermark: string,
  batchSize: number,
): Promise<SyncTableResult> {
  const result: SyncTableResult = {
    pulled: 0,
    upserted: 0,
    errors: 0,
    newWatermark: watermark,
  };

  try {
    const rows = await sbQuery<SbSyncWeatherData>(
      `weather_data?updated_at=gt.${encodeURIComponent(watermark)}&order=updated_at.asc&limit=${batchSize}`,
    );
    if (!rows || rows.length === 0) return result;

    result.pulled = rows.length;

    await db
      .insert(weatherDataTable)
      .values(rows.map(sbWeatherDataToInsert))
      .onConflictDoUpdate({
        target: [
          weatherDataTable.wardId,
          weatherDataTable.observedDate,
          weatherDataTable.source,
        ],
        set: {
          rainfallMm30d: sql`excluded.rainfall_mm_30d`,
          humidityPct: sql`excluded.humidity_pct`,
          temperatureC: sql`excluded.temperature_c`,
          evapotranspirationMm: sql`excluded.evapotranspiration_mm`,
          tenantId: sql`excluded.tenant_id`,
          updatedAt: new Date(),
        },
      });

    result.upserted = rows.length;
    result.newWatermark = rows[rows.length - 1]!.updated_at;
  } catch (err) {
    logger.warn(
      { err: String(err), watermark },
      "[SyncJob] weather_data sync failed",
    );
  }

  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getLastSyncResult(): SyncCycleResult | null {
  return lastCycleResult;
}

export function isSyncJobEnabled(): boolean {
  return process.env.SYNC_JOB_ENABLED !== "false";
}

export function resetSyncCacheForTest(): void {
  watermarks = null;
  lastCycleResult = null;
}

export async function runSyncCycle(): Promise<SyncCycleResult> {
  if (!watermarks) {
    watermarks = await initWatermarks().catch(() => ({
      pastoralistLeads: EPOCH,
      weatherData: EPOCH,
    }));
  }

  const [leadsResult, weatherResult] = await Promise.all([
    syncPastoralistLeads(watermarks.pastoralistLeads, BATCH_SIZE),
    syncWeatherData(watermarks.weatherData, BATCH_SIZE),
  ]);

  watermarks.pastoralistLeads = leadsResult.newWatermark;
  watermarks.weatherData = weatherResult.newWatermark;

  const cycle: SyncCycleResult = {
    syncedAt: new Date().toISOString(),
    pastoralistLeads: leadsResult,
    weatherData: weatherResult,
  };
  lastCycleResult = cycle;

  const totalPulled = leadsResult.pulled + weatherResult.pulled;
  if (totalPulled > 0) {
    logger.info(
      {
        leads: { pulled: leadsResult.pulled, upserted: leadsResult.upserted },
        weather: { pulled: weatherResult.pulled, upserted: weatherResult.upserted },
      },
      "[SyncJob] cycle complete",
    );
  }

  return cycle;
}

let syncTimer: NodeJS.Timeout | null = null;

export function startSyncJob(): void {
  if (!isSyncJobEnabled()) {
    logger.info("[SyncJob] disabled via SYNC_JOB_ENABLED=false");
    return;
  }
  if (!isSupabaseConfigured()) {
    logger.info("[SyncJob] Supabase not configured — skipping");
    return;
  }

  const tick = () => {
    void runSyncCycle().catch((err) =>
      logger.error({ err }, "[SyncJob] unhandled error in runSyncCycle"),
    );
  };

  tick();
  syncTimer = setInterval(tick, INTERVAL_MS);
  logger.info({ intervalMs: INTERVAL_MS, batchSize: BATCH_SIZE }, "[SyncJob] started");
}

export function stopSyncJob(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    logger.info("[SyncJob] stopped");
  }
}
