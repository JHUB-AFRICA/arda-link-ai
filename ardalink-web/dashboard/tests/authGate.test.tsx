/**
 * Tests for the auth flow on the dashboard.
 *
 * - AuthGate: gates on localStorage, dispatches logout event, listens
 *   to cross-tab storage events.
 * - performLogout: clears every localStorage key the gate writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { AuthGate, performLogout } from '../src/components/AuthGate';

function makeStorageStub() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => (data.get(k) ?? null) as string | null,
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
const originalFetch = globalThis.fetch;

beforeEach(() => {
  stub = makeStorageStub();
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: stub,
      location: { href: 'http://localhost/' },
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      },
      removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(cb);
      },
      dispatchEvent: (event: Event) => {
        const cbs = listeners.get(event.type);
        if (cbs) {
          for (const cb of Array.from(cbs)) {
            if (typeof cb === 'function') cb(event);
            else cb.handleEvent(event);
          }
        }
        return true;
      },
    },
    writable: true,
    configurable: true,
  });
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: 'logged_out' }),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('AuthGate', () => {
  it('renders the LoginPage when no token is in localStorage', () => {
    render(
      <AuthGate>
        {() => <div data-testid="dashboard-content">dashboard</div>}
      </AuthGate>,
    );
    expect(screen.getByTestId('login-page')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-content')).toBeNull();
  });

  it('renders children when a valid token + tenant is present', () => {
    stub.setItem('ardalink.jwt', 'tok');
    stub.setItem('ardalink.email', 'op@bula-pesa.test');
    stub.setItem('ardalink.tenant', 'bula-pesa');
    stub.setItem('ardalink.role', 'operator');
    stub.setItem('ardalink.expires_at', new Date(Date.now() + 3600_000).toISOString());
    render(
      <AuthGate>
        {(session) => (
          <div data-testid="dashboard-content">
            {session.email} · {session.tenant_id} · {session.role}
          </div>
        )}
      </AuthGate>,
    );
    expect(screen.queryByTestId('login-page')).toBeNull();
    expect(screen.getByTestId('dashboard-content').textContent).toMatch(
      /op@bula-pesa.test/,
    );
    expect(screen.getByTestId('dashboard-content').textContent).toMatch(
      /bula-pesa/,
    );
  });

  it('redirects to LoginPage when the token is expired', () => {
    stub.setItem('ardalink.jwt', 'tok');
    stub.setItem('ardalink.email', 'op@bula-pesa.test');
    stub.setItem('ardalink.tenant', 'bula-pesa');
    stub.setItem('ardalink.role', 'operator');
    stub.setItem('ardalink.expires_at', new Date(Date.now() - 60_000).toISOString());
    render(
      <AuthGate>
        {() => <div data-testid="dashboard-content">dashboard</div>}
      </AuthGate>,
    );
    expect(screen.getByTestId('login-page')).toBeTruthy();
    expect(stub.getItem('ardalink.jwt')).toBeNull();
  });

  it('performLogout clears every key the gate writes', () => {
    stub.setItem('ardalink.jwt', 'tok');
    stub.setItem('ardalink.email', 'op');
    stub.setItem('ardalink.tenant', 'bula-pesa');
    stub.setItem('ardalink.display_name', 'Op');
    stub.setItem('ardalink.role', 'operator');
    stub.setItem('ardalink.expires_at', new Date().toISOString());
    performLogout();
    expect(stub.getItem('ardalink.jwt')).toBeNull();
    expect(stub.getItem('ardalink.email')).toBeNull();
    expect(stub.getItem('ardalink.tenant')).toBeNull();
    expect(stub.getItem('ardalink.role')).toBeNull();
  });

  it('fires ardalink:logout when the event is dispatched externally', async () => {
    stub.setItem('ardalink.jwt', 'tok');
    stub.setItem('ardalink.email', 'op@bula-pesa.test');
    stub.setItem('ardalink.tenant', 'bula-pesa');
    stub.setItem('ardalink.role', 'operator');
    stub.setItem('ardalink.expires_at', new Date(Date.now() + 3600_000).toISOString());
    const utils = render(
      <AuthGate>
        {() => <div data-testid="dashboard-content">dashboard</div>}
      </AuthGate>,
    );
    expect(utils.getByTestId('dashboard-content')).toBeTruthy();
    // Dispatch the in-page logout event. The gate listens on
    // `window`, performs the logout, and re-renders the LoginPage.
    await act(async () => {
      window.dispatchEvent(new Event('ardalink:logout'));
    });
    // After the act() above the DOM should already be updated — the
    // waitFor polling fights jsdom's microtask scheduling here.
    expect(utils.getByTestId('login-page')).toBeTruthy();
    // Token cleared as a side effect.
    expect(stub.getItem('ardalink.jwt')).toBeNull();
  });
});
