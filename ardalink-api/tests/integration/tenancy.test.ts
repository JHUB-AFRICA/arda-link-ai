/**
 * Multi-tenant isolation: writes from tenant A must not be visible to tenant B.
 *
 * Requires a running Docker daemon. Marked `integration`; CI lane runs
 * these only on the integration track.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startPostgres,
  stopPostgres,
  setTenant,
  seedTenant,
  type IntegrationEnv,
} from './setup';

let env: IntegrationEnv;

beforeAll(async () => {
  env = await startPostgres();
  await seedTenant(env.db, 'bula-pesa', 'Bula Pesa', 'Isiolo');
  await seedTenant(env.db, 'garbatulla', 'Garbatulla', 'Isiolo');
}, 120000);

afterAll(async () => {
  if (env) await stopPostgres(env);
}, 30000);

describe('Multi-tenant row isolation', () => {
  it('RLS prevents cross-tenant reads', async () => {
    // Insert one row per tenant in a single connection (superuser-bypassed)
    // to set up test data, then verify scoped reads.
    const client = await import('pg').then((m) => new m.Client({ connectionString: env.databaseUrl }));
    await client.connect();
    try {
      await client.query(
        `INSERT INTO public.ground_truth_reports
           (tenant_id, phone, month, action_tag, report_data, created_at, updated_at)
         VALUES
           ('bula-pesa', '+254700000001', '2026-01', 'no_action', '{}', now(), now()),
           ('garbatulla', '+254700000002', '2026-01', 'no_action', '{}', now(), now())`,
      );
    } finally {
      await client.end();
    }

    // Tenant A sees only its own row
    await setTenant(env.db, 'bula-pesa');
    const aRows = await env.db.execute(
      'SELECT count(*)::int AS n FROM public.ground_truth_reports',
    );
    expect((aRows as unknown as { rows: { n: number }[] }).rows[0].n).toBe(1);

    // Tenant B sees only its own row
    await setTenant(env.db, 'garbatulla');
    const bRows = await env.db.execute(
      'SELECT count(*)::int AS n FROM public.ground_truth_reports',
    );
    expect((bRows as unknown as { rows: { n: number }[] }).rows[0].n).toBe(1);
  });
});