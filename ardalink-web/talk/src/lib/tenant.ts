/**
 * Browser-side tenant context for the Talk app.
 *
 * Independent copy (not a re-export from dashboard) so the Talk app
 * has no compile-time dependency on the dashboard package layout.
 */

export interface TenantContext {
  tenantId: string;
  displayName?: string;
  region?: string;
  flags?: Record<string, boolean>;
  exp: number;
}

let current: TenantContext | null = null;

export function setTenantContext(ctx: TenantContext | null): void {
  current = ctx;
}

export function getTenantContext(): TenantContext | null {
  if (!current) return null;
  if (current.exp * 1000 < Date.now()) {
    current = null;
    return null;
  }
  return current;
}

export function tenantHeaders(): Record<string, string> {
  const ctx = getTenantContext();
  if (!ctx) return {};
  return { 'X-Client-Tenant-ID': ctx.tenantId };
}

export function hasFlag(flag: string): boolean {
  return Boolean(getTenantContext()?.flags?.[flag]);
}