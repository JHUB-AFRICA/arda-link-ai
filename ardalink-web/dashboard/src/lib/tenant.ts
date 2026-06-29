/**
 * Browser-side tenant context.
 *
 * The dashboard reads tenant info from a short-lived JWT held in memory
 * (never localStorage). This module exposes:
 *
 *   - `setTenantContext(claims)` — call after login or token mint
 *   - `getTenantContext()`       — synchronous access from any component
 *   - `tenantHeaders()`          — for fetch calls that go straight to
 *                                  ardalink-engine (bypassing ardalink-api)
 *
 * UI guards in components should call `getTenantContext()` and hide
 * tenant-inappropriate affordances. Server-side enforcement is in
 * ardalink-api + ardalink-engine — never trust the browser alone.
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
  return { "X-Client-Tenant-ID": ctx.tenantId };
}

export function hasFlag(flag: string): boolean {
  return Boolean(getTenantContext()?.flags?.[flag]);
}
