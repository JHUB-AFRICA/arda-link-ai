/**
 * Local-Postgres mirror writes for Supabase-primary tables.
 *
 * Every function is best-effort: it swallows all errors and returns
 * void so a herder-facing route continues even if the local mirror is
 * down. Callers invoke these AFTER their Supabase write attempt (which
 * has its own logging path), so a failed Supabase write is still
 * captured locally, and a failed local write is still audited via
 * warn-log without disturbing the primary flow.
 *
 * Tenant attribution: today's writes go with `tenant_id = null`,
 * matching the Supabase-side helpers `upsertPastoralistLead` +
 * `logLeadInteraction` + `upsertWeatherData` which also don't stamp
 * tenant. The RLS policy on every mirror table (migration 0003)
 * treats NULL `tenant_id` as visible everywhere, so writes succeed
 * without setting `app.current_tenant_id`.
 */

import { eq } from "drizzle-orm";
import {
  db,
  pastoralistLeadsTable,
  leadInteractionsTable,
  weatherDataTable,
  weatherForecastTable,
  whatsappMessagesTable,
  type InsertPastoralistLead,
  type InsertLeadInteraction,
  type InsertWeatherData,
  type InsertWeatherForecast,
  type InsertWhatsappMessage,
} from "@workspace/db";
import { logger } from "./logger.js";

// ── pastoralist_leads ──────────────────────────────────────────────────

/**
 * Mirror a pastoralist lead into local Postgres. Idempotent on
 * `phone_number`. Local schema doesn't yet have a UNIQUE constraint
 * on phone_number (migration 0003 only added a plain index), so we
 * SELECT-then-INSERT-or-UPDATE instead of relying on ON CONFLICT.
 *
 * On UPDATE, fields the caller left `undefined` are preserved — this
 * matches the Supabase-side merge semantic in `upsertPastoralistLead`.
 */
export async function mirrorPastoralistLead(
  row: Partial<InsertPastoralistLead> & { phoneNumber: string },
): Promise<void> {
  try {
    const existing = await db
      .select({ leadId: pastoralistLeadsTable.leadId })
      .from(pastoralistLeadsTable)
      .where(eq(pastoralistLeadsTable.phoneNumber, row.phoneNumber))
      .limit(1);

    if (existing.length > 0) {
      const patch: Record<string, unknown> = {
        lastContactAt: new Date(),
        updatedAt: new Date(),
      };
      if (row.fullName !== undefined) patch.fullName = row.fullName;
      if (row.preferredLanguage !== undefined)
        patch.preferredLanguage = row.preferredLanguage;
      if (row.wardId !== undefined) patch.wardId = row.wardId;
      if (row.location !== undefined) patch.location = row.location;
      if (row.herdSize !== undefined) patch.herdSize = row.herdSize;
      if (row.enrollmentSource !== undefined)
        patch.enrollmentSource = row.enrollmentSource;
      if (row.status !== undefined) patch.status = row.status;
      if (row.alertsEnabled !== undefined)
        patch.alertsEnabled = row.alertsEnabled;
      if (row.notes !== undefined) patch.notes = row.notes;

      await db
        .update(pastoralistLeadsTable)
        .set(patch)
        .where(eq(pastoralistLeadsTable.phoneNumber, row.phoneNumber));
    } else {
      await db.insert(pastoralistLeadsTable).values({
        phoneNumber: row.phoneNumber,
        fullName: row.fullName ?? null,
        preferredLanguage: row.preferredLanguage ?? null,
        wardId: row.wardId ?? null,
        location: row.location ?? null,
        herdSize: row.herdSize ?? null,
        enrollmentSource: row.enrollmentSource ?? null,
        status: row.status ?? "lead",
        alertsEnabled: row.alertsEnabled ?? true,
        lastContactAt: row.lastContactAt ?? new Date(),
        notes: row.notes ?? null,
        tenantId: row.tenantId ?? null,
      });
    }
  } catch (err) {
    logger.warn(
      { err: String(err), phone: row.phoneNumber },
      "[LocalMirror] pastoralist_leads upsert failed",
    );
  }
}

// ── lead_interactions ──────────────────────────────────────────────────

/**
 * Mirror an audit-log row into local Postgres. Plain INSERT — audit
 * rows don't dedupe; duplicates from repeat calls are the intended
 * signal (same phone hitting the same USSD screen twice).
 */
export async function mirrorLeadInteraction(
  row: InsertLeadInteraction,
): Promise<void> {
  try {
    await db.insert(leadInteractionsTable).values(row);
  } catch (err) {
    logger.warn(
      { err: String(err), channel: row.channel, phone: row.phoneNumber },
      "[LocalMirror] lead_interactions insert failed",
    );
  }
}

// ── whatsapp_messages ────────────────────────────────────────────────────

/**
 * Mirror a WhatsApp thread-log row into local Postgres. Plain INSERT —
 * append-only, same as lead_interactions; duplicates are not expected
 * but aren't a correctness problem if they happen (a retried webhook
 * delivery just logs the same turn twice).
 */
export async function mirrorWhatsappMessage(
  row: InsertWhatsappMessage,
): Promise<void> {
  try {
    await db.insert(whatsappMessagesTable).values(row);
  } catch (err) {
    logger.warn(
      { err: String(err), phone: row.phoneNumber, direction: row.direction },
      "[LocalMirror] whatsapp_messages insert failed",
    );
  }
}

// ── weather_data ───────────────────────────────────────────────────────

/**
 * Mirror a daily observation into local Postgres. Uses the migration's
 * `UNIQUE (ward_id, observed_date, source)` so a same-day re-run of
 * the forecast job updates rather than duplicates.
 */
export async function mirrorWeatherData(row: InsertWeatherData): Promise<void> {
  try {
    await db
      .insert(weatherDataTable)
      .values(row)
      .onConflictDoUpdate({
        target: [
          weatherDataTable.wardId,
          weatherDataTable.observedDate,
          weatherDataTable.source,
        ],
        set: {
          rainfallMm30d: row.rainfallMm30d ?? null,
          humidityPct: row.humidityPct ?? null,
          temperatureC: row.temperatureC ?? null,
          evapotranspirationMm: row.evapotranspirationMm ?? null,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn(
      { err: String(err), ward: row.wardId, date: row.observedDate },
      "[LocalMirror] weather_data upsert failed",
    );
  }
}

// ── weather_forecast ───────────────────────────────────────────────────

/**
 * Mirror a batch of forecast rows into local Postgres. The Supabase
 * side keeps every generated_at snapshot so consumers can trend
 * forecast-vs-actual; local mirror does the same (plain INSERT per row).
 */
export async function mirrorWeatherForecastBatch(
  rows: readonly InsertWeatherForecast[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(weatherForecastTable).values([...rows]);
  } catch (err) {
    logger.warn(
      { err: String(err), count: rows.length, wardSample: rows[0]?.wardId },
      "[LocalMirror] weather_forecast insert failed",
    );
  }
}
