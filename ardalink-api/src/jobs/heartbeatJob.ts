/**
 * Heartbeat job — detects silent pipeline failures.
 *
 * Every 15 minutes, probes the newest write timestamp across the tables
 * a broken pipeline would silently leave stale. Two roles:
 *
 *   writer-driven — daily GEE / 6-hourly forecast writers should always
 *                   produce fresh rows. A stale row here means the writer
 *                   is broken; the pipeline is marked `degraded` and the
 *                   error log is loud enough for future Sentry to page.
 *
 *   herder-driven — lead_interactions + ground_truth_calls. During
 *                   pre-launch pilot, zero herder writes is legitimate,
 *                   so we surface the timestamp for diagnostics but
 *                   never alarm. This is exactly the "broken vs quiet"
 *                   distinction the gap #7 memo asked for.
 *
 * The most recent snapshot is cached in module state so `/api/healthz`
 * can serve without paying the network cost per request.
 */

import { logger } from "../lib/logger.js";
import { isSupabaseConfigured } from "../lib/supabase/index.js";

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type Role = "writer-driven" | "herder-driven";

export interface TableCheck {
  table: string;
  tsColumn: string;
  /** null → informational only, never alarms. */
  thresholdMs: number | null;
  role: Role;
}

/**
 * Per-table probe config. `tsColumn` is the "when did we learn about
 * this row" column, not the data-recency column — a writer that keeps
 * inserting rows with backdated `period_end` would still be visible in
 * `created_at`. When a table doesn't carry the expected column, the
 * probe returns non-2xx and the table is marked `unknown` so the fix
 * is to add a per-table override here.
 */
export const DEFAULT_CHECKS: readonly TableCheck[] = [
  {
    table: "satellite_indices",
    tsColumn: "created_at",
    thresholdMs: 36 * HOUR_MS,
    role: "writer-driven",
  },
  {
    table: "weather_data",
    tsColumn: "created_at",
    thresholdMs: 12 * HOUR_MS,
    role: "writer-driven",
  },
  {
    table: "weather_forecast",
    tsColumn: "created_at",
    thresholdMs: 12 * HOUR_MS,
    role: "writer-driven",
  },
  {
    table: "lead_interactions",
    tsColumn: "occurred_at",
    thresholdMs: null,
    role: "herder-driven",
  },
  {
    table: "ground_truth_calls",
    tsColumn: "created_at",
    thresholdMs: null,
    role: "herder-driven",
  },
];

export type TableStatus = "fresh" | "stale" | "unknown" | "informational";

export interface TableHeartbeat {
  table: string;
  role: Role;
  lastWriteAt: string | null;
  ageSeconds: number | null;
  thresholdSeconds: number | null;
  status: TableStatus;
}

/**
 * A column-existence probe — distinct from the freshness checks above.
 * Exists because a `*.supabase-only.sql` migration in
 * `docs/local-dev/migrations/` can sit un-applied against the live
 * project indefinitely with nothing ever noticing: `ground_truth_calls
 * .water_point_name` went unapplied for over a month (migration 0016),
 * during which every ground-truth write silently 400'd and the ops
 * dashboard's Ground Truth Audit panel misreported the cause as
 * "supabase_not_configured". A missing column is a schema-drift bug,
 * not a staleness one, so it's tracked separately from `tables` but
 * still escalates `status` — see `runHeartbeat()`.
 */
export interface SchemaCheck {
  table: string;
  column: string;
}

export const DEFAULT_SCHEMA_CHECKS: readonly SchemaCheck[] = [
  { table: "ground_truth_calls", column: "water_point_name" },
];

export interface SchemaCheckResult {
  table: string;
  column: string;
  ok: boolean;
}

export type PipelineStatus = "healthy" | "degraded" | "unknown";

export interface HeartbeatSnapshot {
  checkedAt: string;
  status: PipelineStatus;
  tables: TableHeartbeat[];
  schemaChecks: SchemaCheckResult[];
}

let cached: HeartbeatSnapshot | null = null;

export function getLastHeartbeat(): HeartbeatSnapshot | null {
  return cached;
}

/** Test seam — clears the cached snapshot between test files. */
export function resetHeartbeatCacheForTest(): void {
  cached = null;
}

async function fetchNewestTimestamp(
  check: TableCheck,
): Promise<{ isoTs: string | null; ok: boolean }> {
  const sbBase = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const sbKey = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  const url =
    `${sbBase}/rest/v1/${check.table}` +
    `?select=${encodeURIComponent(check.tsColumn)}` +
    `&order=${encodeURIComponent(check.tsColumn)}.desc.nullslast` +
    `&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, table: check.table, body: body.slice(0, 200) },
        "[Heartbeat] table probe non-2xx — marking unknown",
      );
      return { isoTs: null, ok: false };
    }
    const rows = (await res.json()) as Array<Record<string, string | null>>;
    const iso = rows[0]?.[check.tsColumn] ?? null;
    return { isoTs: iso, ok: true };
  } catch (err) {
    logger.warn(
      { err: String(err), table: check.table },
      "[Heartbeat] probe crashed",
    );
    return { isoTs: null, ok: false };
  }
}

async function fetchColumnExists(check: SchemaCheck): Promise<SchemaCheckResult> {
  const sbBase = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const sbKey = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  const url =
    `${sbBase}/rest/v1/${check.table}` +
    `?select=${encodeURIComponent(check.column)}` +
    `&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, table: check.table, column: check.column, body: body.slice(0, 200) },
        "[Heartbeat] schema probe non-2xx — column likely missing (unapplied migration?)",
      );
    }
    return { table: check.table, column: check.column, ok: res.ok };
  } catch (err) {
    logger.warn(
      { err: String(err), table: check.table, column: check.column },
      "[Heartbeat] schema probe crashed",
    );
    return { table: check.table, column: check.column, ok: false };
  }
}

function evaluate(
  check: TableCheck,
  isoTs: string | null,
  probeOk: boolean,
  now: number,
): TableHeartbeat {
  const thresholdSeconds =
    check.thresholdMs != null ? Math.round(check.thresholdMs / 1000) : null;
  if (!probeOk) {
    return {
      table: check.table,
      role: check.role,
      lastWriteAt: null,
      ageSeconds: null,
      thresholdSeconds,
      status: "unknown",
    };
  }
  if (!isoTs) {
    return {
      table: check.table,
      role: check.role,
      lastWriteAt: null,
      ageSeconds: null,
      thresholdSeconds,
      // Empty table on a writer-driven check is treated as stale so a
      // pipeline that has never produced a row surfaces as degraded.
      status: check.thresholdMs == null ? "informational" : "stale",
    };
  }
  const ageMs = now - new Date(isoTs).getTime();
  const ageSeconds = Math.round(ageMs / 1000);
  let status: TableStatus;
  if (check.thresholdMs == null) {
    status = "informational";
  } else if (ageMs > check.thresholdMs) {
    status = "stale";
  } else {
    status = "fresh";
  }
  return {
    table: check.table,
    role: check.role,
    lastWriteAt: isoTs,
    ageSeconds,
    thresholdSeconds,
    status,
  };
}

export async function runHeartbeat(
  checks: readonly TableCheck[] = DEFAULT_CHECKS,
  schemaChecks: readonly SchemaCheck[] = DEFAULT_SCHEMA_CHECKS,
): Promise<HeartbeatSnapshot> {
  const now = Date.now();
  const checkedAt = new Date(now).toISOString();

  if (!isSupabaseConfigured()) {
    const snap: HeartbeatSnapshot = {
      checkedAt,
      status: "unknown",
      tables: checks.map((c) => ({
        table: c.table,
        role: c.role,
        lastWriteAt: null,
        ageSeconds: null,
        thresholdSeconds:
          c.thresholdMs != null ? Math.round(c.thresholdMs / 1000) : null,
        status: "unknown",
      })),
      schemaChecks: [],
    };
    cached = snap;
    logger.warn(
      "[Heartbeat] Supabase not configured — marking all tables unknown",
    );
    return snap;
  }

  const [results, schemaResults] = await Promise.all([
    Promise.all(
      checks.map(async (c) => {
        const { isoTs, ok } = await fetchNewestTimestamp(c);
        return evaluate(c, isoTs, ok, now);
      }),
    ),
    Promise.all(schemaChecks.map((c) => fetchColumnExists(c))),
  ]);

  const writers = results.filter((r) => r.role === "writer-driven");
  const anyStaleWriter = writers.some((r) => r.status === "stale");
  const allWritersUnknown =
    writers.length > 0 && writers.every((r) => r.status === "unknown");
  const freshnessStatus: PipelineStatus = anyStaleWriter
    ? "degraded"
    : allWritersUnknown
      ? "unknown"
      : "healthy";

  // A schema-drift finding is always bad news, but it should never
  // paper over — or get papered over by — the freshness verdict above:
  // if the pipeline is already `degraded`/`unknown` for staleness
  // reasons, a missing column doesn't change what an operator needs to
  // do next (go look at the pipeline); it only escalates a genuinely
  // `healthy`-looking pipeline that's actually silently dropping writes
  // on the floor, which is exactly the month-long ground_truth_calls
  // gap this check exists to catch next time.
  const anySchemaMismatch = schemaResults.some((r) => !r.ok);
  const status: PipelineStatus =
    anySchemaMismatch && freshnessStatus === "healthy"
      ? "degraded"
      : freshnessStatus;

  const snap: HeartbeatSnapshot = {
    checkedAt,
    status,
    tables: results,
    schemaChecks: schemaResults,
  };
  cached = snap;

  if (anySchemaMismatch) {
    const missing = schemaResults.filter((r) => !r.ok);
    logger.error(
      { status, missing },
      "[Heartbeat] Schema mismatch — a column the app writes/reads is missing live (unapplied *.supabase-only.sql migration?)",
    );
  }
  if (status === "degraded") {
    const staleTables = results
      .filter((r) => r.status === "stale")
      .map((r) => r.table);
    logger.error(
      { status, staleTables, tables: results },
      "[Heartbeat] Pipeline degraded — one or more writer-driven tables are stale",
    );
  } else {
    logger.info(
      { status, tables: results },
      "[Heartbeat] Pipeline check complete",
    );
  }
  return snap;
}

// ── Scheduler ──────────────────────────────────────────────────────────────

let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatEnabled = process.env.HEARTBEAT_JOB_ENABLED !== "false";

export function isHeartbeatJobEnabled(): boolean {
  return heartbeatEnabled;
}

export function startHeartbeatJob(): void {
  if (heartbeatTimer) {
    logger.warn("[Heartbeat] Job already running — stopping previous timer");
    stopHeartbeatJob();
  }
  heartbeatEnabled = process.env.HEARTBEAT_JOB_ENABLED !== "false";
  if (!heartbeatEnabled) {
    logger.info(
      "[Heartbeat] Job disabled via HEARTBEAT_JOB_ENABLED=false",
    );
    return;
  }
  const intervalMs = Number(
    process.env.HEARTBEAT_INTERVAL_MS ?? FIFTEEN_MIN_MS,
  );
  // Boot probe populates cached state so the first /api/healthz hit
  // after startup returns real data instead of null.
  void runHeartbeat().catch((err) =>
    logger.error({ err }, "[Heartbeat] boot run crashed"),
  );
  heartbeatTimer = setInterval(() => {
    void runHeartbeat().catch((err) =>
      logger.error({ err }, "[Heartbeat] interval run crashed"),
    );
  }, intervalMs);
  logger.info({ intervalMs }, "[Heartbeat] Scheduled");
}

export function stopHeartbeatJob(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    logger.info("[Heartbeat] Job stopped");
  }
}
