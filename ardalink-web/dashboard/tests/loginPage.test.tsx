/**
 * LoginPage behaviour tests.
 *
 * We mock fetch so the test runs without the api up. The page must:
 *   - show the email + password inputs
 *   - submit a JSON POST to /api/auth/login
 *   - surface an inline error on 401
 *   - persist the JWT + tenant + role + display_name + expires_at on success
 *   - populate the demo-account chips on click
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { LoginPage } from '../src/components/LoginPage';

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
let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;
const onSuccess = vi.fn();

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
    },
    writable: true,
    configurable: true,
  });
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  onSuccess.mockReset();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockJsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('LoginPage', () => {
  it('renders the email + password inputs and submit button', () => {
    render(<LoginPage onSuccess={onSuccess} />);
    expect(screen.getByTestId('login-email')).toBeTruthy();
    expect(screen.getByTestId('login-password')).toBeTruthy();
    expect(screen.getByTestId('login-submit')).toBeTruthy();
  });

  it('renders demo-account chips', () => {
    render(<LoginPage onSuccess={onSuccess} />);
    expect(screen.getByTestId('demo-bula-pesa@ardalink.test')).toBeTruthy();
    expect(screen.getByTestId('demo-admin@ardalink.test')).toBeTruthy();
  });

  it('fills the form when a demo chip is clicked', () => {
    render(<LoginPage onSuccess={onSuccess} />);
    fireEvent.click(screen.getByTestId('demo-bula-pesa@ardalink.test'));
    const email = screen.getByTestId('login-email') as HTMLInputElement;
    const password = screen.getByTestId('login-password') as HTMLInputElement;
    expect(email.value).toBe('bula-pesa@ardalink.test');
    expect(password.value).toBe('bula-pesa');
  });

  it('rejects an empty submit with an inline error', async () => {
    const utils = render(<LoginPage onSuccess={onSuccess} />);
    await act(async () => {
      fireEvent.click(utils.getByTestId('login-submit'));
    });
    expect(utils.getByTestId('login-error').textContent).toMatch(/required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 401 as "Email or password is incorrect"', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(401, { error: 'invalid credentials' }));
    render(<LoginPage onSuccess={onSuccess} />);
    fireEvent.change(screen.getByTestId('login-email'), {
      target: { value: 'bad@ardalink.test' },
    });
    fireEvent.change(screen.getByTestId('login-password'), {
      target: { value: 'wrong' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-submit'));
    });
    expect(screen.getByTestId('login-error').textContent).toMatch(
      /incorrect/i,
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('persists the JWT + tenant + role + display_name + expires_at on success', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(200, {
        token: 'jwt.tok.en',
        email: 'bula-pesa@ardalink.test',
        tenant_id: 'bula-pesa',
        display_name: 'Bula Pesa Operator',
        role: 'operator',
        expires_at: '2026-12-31T00:00:00Z',
      }),
    );
    render(<LoginPage onSuccess={onSuccess} />);
    fireEvent.change(screen.getByTestId('login-email'), {
      target: { value: 'bula-pesa@ardalink.test' },
    });
    fireEvent.change(screen.getByTestId('login-password'), {
      target: { value: 'bula-pesa' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-submit'));
    });
    expect(stub.getItem('ardalink.jwt')).toBe('jwt.tok.en');
    expect(stub.getItem('ardalink.tenant')).toBe('bula-pesa');
    expect(stub.getItem('ardalink.email')).toBe('bula-pesa@ardalink.test');
    expect(stub.getItem('ardalink.display_name')).toBe('Bula Pesa Operator');
    expect(stub.getItem('ardalink.role')).toBe('operator');
    expect(stub.getItem('ardalink.expires_at')).toBe('2026-12-31T00:00:00Z');
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
