/**
 * Supabase HTTP client primitives for ArdaLink.
 *
 * Supabase is the **source of truth** for reference data (wards,
 * satellite_indices, weather_data, ward_neighbors, ward_cells) AND
 * operational data (pastoralists, ground_truth_calls) — with our local
 * Postgres kept as a resilient backup mirror. Reads try Supabase first
 * and fall back to local; writes go to Supabase primary + local backup.
 *
 * The connection is HTTP-only (PostgREST via `${SUPABASE_URL}/rest/v1/`)
 * so we don't need to open a second Postgres pool. The service-role /
 * secret key must never reach the browser — every call goes through
 * ardalink-api.
 *
 * This module holds only the shared plumbing (fetch/get/insert +
 * caching + timeouts) that every domain module in `src/lib/supabase/`
 * builds on. Domain-specific reads/writes live in sibling files —
 * see `index.ts` for the full re-export surface.
 */

import { logger } from "../logger.js";

// Two-tier timeouts. USSD sessions have a ~10 s AT budget end-to-end
// and voice openers must return before AT plays the "no key received"
// fallback, so herder-facing paths use a tight `interactive` timeout
// and fall through to the local mirror without blocking the response.
// Backend jobs (dashboards, schedulers, sync workers) use the longer
// `batch` timeout since a few extra seconds don't hurt them.
const TIMEOUT_INTERACTIVE_MS = parseInt(
  process.env.SUPABASE_TIMEOUT_INTERACTIVE_MS ?? "2500",
  10,
);
const TIMEOUT_BATCH_MS = parseInt(
  process.env.SUPABASE_TIMEOUT_BATCH_MS ?? "8000",
  10,
);

const CACHE_TTL_MS = parseInt(
  process.env.SUPABASE_CACHE_TTL_MS ?? "60000",
  10,
);

export type SupabaseMode = "interactive" | "batch";
const DEFAULT_MODE: SupabaseMode = "interactive";

interface SupabaseCfg {
  base: string;
  key: string;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

function cfg(): SupabaseCfg {
  const base = (process.env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!base || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SECRET_KEY must be set to use the Supabase client",
    );
  }
  return { base, key };
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

export async function sbFetch(
  path: string,
  init: RequestInit & { sbMode?: SupabaseMode } = {},
): Promise<Response> {
  const { base, key } = cfg();
  const url = `${base}/rest/v1/${path.replace(/^\/+/, "")}`;
  const mode = init.sbMode ?? DEFAULT_MODE;
  const timeoutMs =
    mode === "batch" ? TIMEOUT_BATCH_MS : TIMEOUT_INTERACTIVE_MS;
  return fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

/**
 * GET helper. When `cache=true` the response is memoised for
 * `CACHE_TTL_MS`. Returns `null` on 5xx / network failure so callers
 * can fall back to the local Postgres mirror.
 */
export async function sbGet<T>(
  path: string,
  opts: { cache?: boolean; mode?: SupabaseMode } = {},
): Promise<T[] | null> {
  if (opts.cache) {
    const hit = cache.get(path);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T[];
  }
  try {
    const res = await sbFetch(path, { sbMode: opts.mode });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, path, body: body.slice(0, 200) },
        "[Supabase] GET non-2xx — falling back",
      );
      return null;
    }
    const data = (await res.json()) as T[];
    if (opts.cache) {
      cache.set(path, { value: data, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return data;
  } catch (err) {
    logger.warn({ err, path }, "[Supabase] GET failed — falling back");
    return null;
  }
}

/**
 * POST an insert. Uses `Prefer: return=representation` so we get the
 * inserted row back. Returns `null` on failure so callers can log and
 * carry on with the local write.
 */
export async function sbInsert<T>(
  table: string,
  row: Record<string, unknown>,
  opts: { mode?: SupabaseMode } = {},
): Promise<T | null> {
  try {
    const res = await sbFetch(table, {
      method: "POST",
      body: JSON.stringify(row),
      headers: { Prefer: "return=representation" },
      sbMode: opts.mode,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, table, body: body.slice(0, 300) },
        "[Supabase] INSERT non-2xx — local backup still saved",
      );
      return null;
    }
    const rows = (await res.json()) as T[];
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err, table }, "[Supabase] INSERT failed");
    return null;
  }
}

export function clearSupabaseCache(): void {
  cache.clear();
}
