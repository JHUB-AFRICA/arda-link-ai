import { useEffect, useState, useCallback } from "react";
import { LoginPage, type LoginSuccess } from "./LoginPage";

const STORAGE_KEYS = {
  token: "ardalink.jwt",
  email: "ardalink.email",
  tenant: "ardalink.tenant",
  displayName: "ardalink.display_name",
  role: "ardalink.role",
  expiresAt: "ardalink.expires_at",
} as const;

export interface SessionInfo {
  token: string;
  email: string;
  tenant_id: string;
  display_name: string;
  role: string;
  expires_at: string;
}

function readSession(): SessionInfo | null {
  const token = window.localStorage.getItem(STORAGE_KEYS.token);
  if (!token) return null;
  const email = window.localStorage.getItem(STORAGE_KEYS.email) ?? "";
  const tenant_id = window.localStorage.getItem(STORAGE_KEYS.tenant) ?? "";
  const display_name = window.localStorage.getItem(STORAGE_KEYS.displayName) ?? "";
  const role = window.localStorage.getItem(STORAGE_KEYS.role) ?? "viewer";
  const expires_at = window.localStorage.getItem(STORAGE_KEYS.expiresAt) ?? "";
  return { token, email, tenant_id, display_name, role, expires_at };
}

function clearSession(): void {
  for (const k of Object.values(STORAGE_KEYS)) {
    window.localStorage.removeItem(k);
  }
}

function tokenExpired(expiresAt: string): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

/**
 * Clears the session and best-effort POSTs /api/auth/logout. Exported
 * so the UserMenu in the top bar can call it.
 */
export function performLogout(): void {
  clearSession();
  try {
    fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  } catch {
    /* ignore network errors */
  }
}

interface AuthGateProps {
  children: (session: SessionInfo) => React.ReactNode;
}

/**
 * AuthGate — wraps the dashboard. Reads a JWT from localStorage (or
 * from `?token=` / `#token=` URL params). If a valid session exists,
 * renders the dashboard via the children render-prop. Otherwise
 * shows the LoginPage.
 */
export function AuthGate({ children }: AuthGateProps) {
  const [session, setSession] = useState<SessionInfo | null>(() => {
    if (typeof window === "undefined") return null;
    const s = readSession();
    if (s && tokenExpired(s.expires_at)) {
      clearSession();
      return null;
    }
    return s;
  });

  const handleLogout = useCallback(() => {
    performLogout();
    setSession(null);
  }, []);

  // Cross-tab login/logout sync. We register a single storage listener
  // for the lifetime of the gate; the listener lives outside React's
  // render path so it never causes "hooks order changed" warnings.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === STORAGE_KEYS.token) {
        const s = readSession();
        if (s && !tokenExpired(s.expires_at)) {
          setSession(s);
        } else {
          if (s) clearSession();
          setSession(null);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Listen for the in-page logout event fired by UserMenu. Always
  // registered; the handler is a no-op when already logged out.
  useEffect(() => {
    const onForceLogout = () => handleLogout();
    window.addEventListener("ardalink:logout", onForceLogout);
    return () => window.removeEventListener("ardalink:logout", onForceLogout);
  }, [handleLogout]);

  const handleLogin = useCallback((info: LoginSuccess) => {
    const s: SessionInfo = {
      token: info.token,
      email: info.email,
      tenant_id: info.tenant_id,
      display_name: info.display_name ?? "",
      role: info.role,
      expires_at: info.expires_at,
    };
    setSession(s);
  }, []);

  if (!session) {
    return (
      <LoginPage
        onSuccess={handleLogin}
        initialEmail={
          typeof window !== "undefined"
            ? (window.localStorage.getItem("ardalink.last_email") ?? "")
            : ""
        }
      />
    );
  }
  return <>{children(session)}</>;
}

export default AuthGate;
