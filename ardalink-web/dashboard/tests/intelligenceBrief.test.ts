/**
 * Tenant-scoped intelligence brief fetch helper tests.
 *
 * The dashboard's `IntelligenceBrief` component consumes this via
 * React Query. The hook is `useIntelligenceBrief`; the underlying
 * fetcher is `getIntelligenceBrief`. We test the fetcher directly
 * so we don't have to spin up React / DOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  getIntelligenceBrief,
  getIntelligenceBriefQueryKey,
} from '../../packages/api-client-react/src';

describe('intelligence brief query keys', () => {
  it('uses a stable (lang, regenerate) tuple', () => {
    expect(getIntelligenceBriefQueryKey()).toEqual([
      'intelligence',
      'brief',
      'en',
      false,
    ]);
    expect(getIntelligenceBriefQueryKey({ lang: 'sw' })).toEqual([
      'intelligence',
      'brief',
      'sw',
      false,
    ]);
    expect(getIntelligenceBriefQueryKey({ lang: 'en', regenerate: true })).toEqual([
      'intelligence',
      'brief',
      'en',
      true,
    ]);
  });

  it('treats sw and en as distinct cache entries', () => {
    const a = getIntelligenceBriefQueryKey({ lang: 'en' });
    const b = getIntelligenceBriefQueryKey({ lang: 'sw' });
    expect(a).not.toEqual(b);
  });
});

describe('getIntelligenceBrief', () => {
  const originalFetch = globalThis.fetch;

  function makeStorageStub() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => Array.from(data.keys())[i] ?? null,
      get length() {
        return data.size;
      },
    };
  }

  let stub: ReturnType<typeof makeStorageStub>;

  beforeEach(() => {
    stub = makeStorageStub();
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: stub },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as { window?: unknown }).window;
  });

  it('builds the correct query string and forwards the bearer token', async () => {
    stub.setItem('ardalink.jwt', 'fake.jwt.token');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tenant_id: 'bula-pesa',
        lang: 'sw',
        summary: 's',
        actions: ['a'],
        data_sources: ['ground_truth_reports'],
        generated_at: '2026-06-23T00:00:00Z',
        provider: 'z',
        model: 'glm-4.5-flash',
        cached: false,
        tokens: 100,
        latency_ms: 50,
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getIntelligenceBrief({ lang: 'sw' });
    expect(result.lang).toBe('sw');
    expect(result.provider).toBe('z');

    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe('/api/intelligence/brief?lang=sw');
    const headers = (calledInit as { headers: Headers }).headers;
    expect(headers.get('authorization')).toBe('Bearer fake.jwt.token');
  });

  it('appends regenerate=1 when asked', async () => {
    stub.setItem('ardalink.jwt', 'tok');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tenant_id: 'bula-pesa',
        lang: 'en',
        summary: 's',
        actions: ['a', 'b'],
        data_sources: ['ground_truth_reports'],
        generated_at: '2026-06-23T00:00:00Z',
        provider: 'mock',
        model: 'mock',
        cached: true,
        tokens: 0,
        latency_ms: 1,
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getIntelligenceBrief({ lang: 'en', regenerate: true });
    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe(
      '/api/intelligence/brief?lang=en&regenerate=1',
    );
  });

  it('throws on non-2xx with the response body', async () => {
    stub.setItem('ardalink.jwt', 'tok');

    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'Missing Bearer token',
      json: async () => ({ error: 'Missing Bearer token' }),
    })) as unknown as typeof fetch;

    await expect(getIntelligenceBrief()).rejects.toThrow(/401/);
  });

  it('omits the query string when no params are passed', async () => {
    stub.setItem('ardalink.jwt', 'tok');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tenant_id: 'bula-pesa',
        lang: 'en',
        summary: 's',
        actions: ['a', 'b'],
        data_sources: ['ground_truth_reports'],
        generated_at: '2026-06-23T00:00:00Z',
        provider: 'mock',
        model: 'mock',
        cached: false,
        tokens: 0,
        latency_ms: 1,
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getIntelligenceBrief();
    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe('/api/intelligence/brief');
  });
});
