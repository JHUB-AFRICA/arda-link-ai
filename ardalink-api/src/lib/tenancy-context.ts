/**
 * Per-request tenant context binding for Drizzle queries.
 *
 * Every API request must run inside a Postgres transaction where the
 * session variable `app.current_tenant_id` is set. RLS policies on
 * every operational table then filter rows to that tenant only.
 *
 * Usage:
 *
 *   import { withTenantContext } from '../lib/tenancy-context';
 *
 *   app.get('/api/ground-truth/recent', async (req, res) => {
 *     const tenantId = req.tenant!.tenant_id;
 *     const rows = await withTenantContext(tenantId, async (tx) => {
 *       return tx.select().from(groundTruthReportsTable).limit(20);
 *     });
 *     res.json(rows);
 *   });
 *
 * Failure mode: if `tenantId` is empty, the helper throws. A connection
 * that escapes the `withTenantContext` block is released; the next
 * request gets a fresh pool member with no `app.current_tenant_id`
 * set, so unscoped queries on scoped tables return zero rows.
 */

import { sql } from 'drizzle-orm';
import { db } from '@workspace/db';

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Allowlist tenant IDs before inlining them into a SET LOCAL statement.
 * SET does not accept parameter placeholders in Postgres, so we must
 * build the SQL string ourselves. Without this allowlist, a forged JWT
 * claiming an attacker-controlled tenant_id could inject arbitrary SQL.
 *
 * Allowlist: lowercase alphanumerics and dashes, 1-64 chars.
 */
export function safeTenantId(raw: string): string {
  if (typeof raw !== 'string' || !/^[a-z0-9-]{1,64}$/.test(raw)) {
    throw new TenantContextError(
      `tenant_id failed allowlist (must match /^[a-z0-9-]{1,64}$/): ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new TenantContextError('tenantId is required for withTenantContext');
  }
  const safe = safeTenantId(tenantId);
  return db.transaction(async (tx) => {
    // The sql.raw call is intentional and tightly scoped: SET LOCAL does
    // not accept parameter placeholders in Postgres. The tenantId has
    // already passed the safeTenantId() allowlist above, so the only
    // characters interpolated here are [a-z0-9-]{1,64}.
    await tx.execute(sql.raw(`SET LOCAL app.current_tenant_id = '${safe}'`));
    return fn(tx);
  });
}