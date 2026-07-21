#!/usr/bin/env -S npx tsx
/**
 * One-shot CLI wrapper around the runVciBackfill job.
 *
 * Usage:
 *   pnpm --filter ardalink-api run vci-backfill                # default: 5 canonical wards
 *   pnpm --filter ardalink-api run vci-backfill -- --wards=242
 *   pnpm --filter ardalink-api run vci-backfill -- --all       # every ward in Supabase
 *
 * Loads .env.local first so SUPABASE_URL + SUPABASE_SECRET_KEY are
 * available without booting the full API. Underlying job is idempotent
 * — rows with vci_value already set are skipped, so this is safe to
 * re-run at any time.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL = join(HERE, "..", ".env.local");

// Hydrate process.env from .env.local (silent no-op when missing).
try {
  const raw = readFileSync(ENV_LOCAL, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v;
  }
} catch {
  /* .env.local missing — rely on ambient env */
}

if (!process.env["SUPABASE_URL"] || !process.env["SUPABASE_SECRET_KEY"]) {
  console.error(
    "SUPABASE_URL and SUPABASE_SECRET_KEY must be set (via .env.local or ambient env).",
  );
  process.exit(2);
}

// Parse `--key=value` flags. `--all` is a boolean-style shortcut.
const args = new Map<string, string>(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, "").split("="))
    .map(([k, v]) => [k, v ?? "true"] as [string, string]),
);

const opts: { wardIds?: string[] } = args.has("all")
  ? { wardIds: [] } // empty ⇒ no filter
  : args.has("wards")
    ? { wardIds: args.get("wards")!.split(",").map((s) => s.trim()) }
    : {}; // default — canonical wards only

const { runVciBackfill } = await import("../src/jobs/vciBackfillJob.js");

const started = Date.now();
console.log("[VciBackfill] Starting", opts);
const result = await runVciBackfill(opts);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`[VciBackfill] Done in ${elapsed}s:`, result);
process.exit(result.errors > 0 ? 1 : 0);
