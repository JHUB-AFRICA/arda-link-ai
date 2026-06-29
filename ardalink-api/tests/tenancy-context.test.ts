import { describe, it, expect } from 'vitest';

import { TenantContextError, withTenantContext } from '../src/lib/tenancy-context';

describe('withTenantContext', () => {
  it('rejects an empty tenant id with TenantContextError', async () => {
    await expect(withTenantContext('', async () => undefined)).rejects.toBeInstanceOf(
      TenantContextError,
    );
  });

  it('error message names the missing tenant', async () => {
    await expect(withTenantContext('', async () => undefined)).rejects.toThrow(/tenantId/);
  });
});