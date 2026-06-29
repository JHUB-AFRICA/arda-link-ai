import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';

// Mock the callTokens lib so the route test doesn't need a real DB.
const mintMock = vi.fn();
const checkMock = vi.fn();

vi.mock('../src/lib/callTokens', () => ({
  mintToken: (...args: unknown[]) => mintMock(...args),
  checkToken: (...args: unknown[]) => checkMock(...args),
  TOKEN_TTL_SECONDS: 600,
  TokenCapacityError: class extends Error {},
  RateLimitError: class extends Error {},
  ConcurrencyError: class extends Error {},
  BudgetExceededError: class extends Error {},
  PublicTalkDisabledError: class extends Error {},
  PhoneDailyLimitError: class extends Error {},
  IpDailyLimitError: class extends Error {},
  UnsupportedRegionError: class extends Error {},
}));

vi.mock('../src/lib/originGuard', () => ({
  requireTrustedOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createApp } from '../src/app';

const JWT_SECRET = 'route-test-secret-32-chars-min';
function mintJwt(claims: object, secret = JWT_SECRET): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = (o: object): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const headerB64 = enc(header);
  const payloadB64 = enc(claims);
  const sig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  return `${headerB64}.${payloadB64}.${sig}`;
}

describe('POST /api/call-tokens', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.TENANT_ATTESTATION_SECRET = 'route-test-attestation-secret';
    mintMock.mockReset();
    checkMock.mockReset();
  });
  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.TENANT_ATTESTATION_SECRET;
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(createApp()).post('/api/call-tokens').send({ phone: '+254700000000' });
    expect(res.status).toBe(401);
  });

  it('mints a token for an authenticated tenant', async () => {
    mintMock.mockResolvedValue({
      token: 'token-abc-123',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const token = mintJwt({ sub: 'op-1', tenant_id: 'bula-pesa' });
    const res = await request(createApp())
      .post('/api/call-tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+254700000000' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('token-abc-123');
    expect(mintMock).toHaveBeenCalledOnce();
  });

  it('propagates tenant_id into the mintToken call', async () => {
    mintMock.mockResolvedValue({ token: 't', expiresAt: new Date().toISOString() });
    const token = mintJwt({ sub: 'op-2', tenant_id: 'merti' });
    await request(createApp())
      .post('/api/call-tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+254700000003' });
    const call = mintMock.mock.calls[0]?.[0] as { tenantId?: string };
    expect(call?.tenantId).toBe('merti');
  });
});