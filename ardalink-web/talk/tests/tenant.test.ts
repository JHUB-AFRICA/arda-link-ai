import { describe, it, expect, beforeEach } from 'vitest';

import {
  getTenantContext,
  hasFlag,
  setTenantContext,
  tenantHeaders,
  type TenantContext,
} from '../src/lib/tenant';

const future = Math.floor(Date.now() / 1000) + 3600;
const ctx: TenantContext = {
  tenantId: 'garbatulla',
  displayName: 'Garbatulla',
  region: 'Isiolo County',
  flags: { voice_outbound: true, ground_truth: true },
  exp: future,
};

describe('talk tenant context (re-exports from dashboard)', () => {
  beforeEach(() => setTenantContext(null));

  it('reads the same module', () => {
    setTenantContext(ctx);
    expect(getTenantContext()?.tenantId).toBe('garbatulla');
    expect(hasFlag('voice_outbound')).toBe(true);
    expect(hasFlag('public_talk')).toBe(false);
    expect(tenantHeaders()).toEqual({ 'X-Client-Tenant-ID': 'garbatulla' });
  });
});