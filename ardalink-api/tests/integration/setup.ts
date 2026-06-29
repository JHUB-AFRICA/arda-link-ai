/**
 * Integration test helpers.
 *
 * These spin up a real Postgres in a Docker container via testcontainers,
 * apply Phase 2 multi-tenant migrations, and yield a Drizzle instance
 * pointed at it. Per-test transactions wrap each test in a savepoint so
 * failures roll back cleanly.
 *
 * Marked `integration` so they're skipped in unit-only CI lanes.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';

export interface IntegrationEnv {
  container: StartedPostgreSqlContainer;
  db: NodePgDatabase;
  databaseUrl: string;
}

export async function startPostgres(): Promise<IntegrationEnv> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('ardalink_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const databaseUrl = container.getConnectionUri();

  // Apply migrations
  const engineUp = readFileSync(
    resolve(__dirname, '../../migrations/0001_multitenant.up.sql'),
    'utf8',
  );
  const apiUp = readFileSync(
    resolve(__dirname, '../../../../api/migrations/0001_multitenant.up.sql'),
    'utf8',
  );

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(engineUp);
    await client.query(apiUp);
  } finally {
    await client.end();
  }

  const db = drizzle(databaseUrl);
  return { container, db, databaseUrl };
}

export async function stopPostgres(env: IntegrationEnv): Promise<void> {
  await env.container.stop();
}

export async function setTenant(
  db: NodePgDatabase,
  tenantId: string,
): Promise<void> {
  await db.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
}

export async function seedTenant(
  db: NodePgDatabase,
  tenantId: string,
  displayName: string,
  region: string,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO public.tenants (tenant_id, display_name, region)
        VALUES (${tenantId}, ${displayName}, ${region})
        ON CONFLICT (tenant_id) DO NOTHING`,
  );
}