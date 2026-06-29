import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2, LogIn, ShieldCheck } from "lucide-react";
import {
  setToken as apiSetToken,
} from "@workspace/api-client-react";

export interface LoginSuccess {
  token: string;
  email: string;
  tenant_id: string;
  display_name?: string | null;
  role: string;
  expires_at: string;
}

interface LoginPageProps {
  /**
   * Called when login succeeds. The page has already written the JWT
   * and tenant_id to localStorage before this fires, so the parent can
   * just re-render.
   */
  onSuccess: (info: LoginSuccess) => void;
  /**
   * Pre-fill the email field (e.g. when arriving via a shared link
   * or after a previous session). Optional.
   */
  initialEmail?: string;
}

/**
 * LoginPage — full-page sign-in form for the operator dashboard.
 *
 * Posts to /api/auth/login. On success it writes the JWT, email,
 * tenant_id, display_name, role, and expires_at to localStorage under
 * the keys used by the api-client-react hook helpers, then calls
 * onSuccess so the parent (AuthGate) can swap to the dashboard.
 *
 * Failure modes shown inline:
 *   - 401 invalid credentials → "Email or password is incorrect."
 *   - 503 auth not configured → "Server is missing JWT_SECRET."
 *   - 400 invalid body → field-level errors (zod message).
 *   - network/other → generic error with the response body.
 */
export function LoginPage({ onSuccess, initialEmail = "" }: LoginPageProps) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Allow Escape to clear the form. SSR-safe — only attach on the
  // client side, and tolerate environments without addEventListener.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) {
        setEmail("");
        setPassword("");
        setError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submitting]);

  const submit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (submitting) return;
      if (!email.trim() || !password) {
        setError("Email and password are required.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) {
            setError("Email or password is incorrect.");
          } else if (res.status === 503) {
            setError("Server is missing JWT_SECRET — auth not configured.");
          } else if (res.status === 400) {
            setError(
              typeof body.error === "string"
                ? body.error
                : "Invalid request. Check the email and password format.",
            );
          } else {
            setError(
              typeof body.error === "string"
                ? body.error
                : `Login failed (HTTP ${res.status}).`,
            );
          }
          return;
        }
        const info: LoginSuccess = {
          token: String(body.token),
          email: String(body.email ?? email.trim()),
          tenant_id: String(body.tenant_id),
          display_name: body.display_name ?? null,
          role: String(body.role ?? "viewer"),
          expires_at: String(body.expires_at ?? ""),
        };
        // Persist to the keys the api-client-react hooks read.
        apiSetToken(info.token);
        window.localStorage.setItem("ardalink.email", info.email);
        window.localStorage.setItem("ardalink.tenant", info.tenant_id);
        window.localStorage.setItem(
          "ardalink.display_name",
          info.display_name ?? "",
        );
        window.localStorage.setItem("ardalink.role", info.role);
        window.localStorage.setItem("ardalink.expires_at", info.expires_at);
        onSuccess(info);
      } catch (err: unknown) {
        setError(
          err instanceof Error
            ? `Network error: ${err.message}`
            : "Network error — could not reach the API.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [email, password, submitting, onSuccess],
  );

  return (
    <div
      data-testid="login-page"
      className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-gray-950 via-gray-900 to-amber-950/30"
    >
      <Card className="w-full max-w-md bg-gray-900/80 border-amber-700/40 backdrop-blur shadow-2xl shadow-amber-950/40">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-amber-600/20 border border-amber-700/40 flex items-center justify-center mb-2">
            <ShieldCheck className="w-7 h-7 text-amber-400" />
          </div>
          <CardTitle className="text-2xl text-white tracking-tight">
            ArdaLink Operator
          </CardTitle>
          <CardDescription className="text-gray-400">
            Sign in with your operator credentials.
            <br />
            <span className="text-xs text-gray-500">
              Multi-tenant · Isiolo County, Kenya
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={submit}
            className="space-y-4"
            aria-label="Sign in"
            data-testid="login-form"
          >
            <div className="space-y-2">
              <Label htmlFor="email" className="text-gray-300">
                Email
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="bula-pesa@ardalink.test"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className="bg-gray-950 border-gray-700 text-white placeholder:text-gray-600"
                data-testid="login-email"
                aria-required="true"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-gray-300">
                Password
              </Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="bg-gray-950 border-gray-700 text-white placeholder:text-gray-600"
                data-testid="login-password"
                aria-required="true"
              />
            </div>

            {error && (
              <div
                role="alert"
                data-testid="login-error"
                className="flex items-start gap-2 p-3 rounded-md bg-red-950/40 border border-red-800/60 text-red-200 text-sm"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="leading-snug">{error}</span>
              </div>
            )}

            <Button
              type="submit"
              disabled={submitting}
              className="w-full bg-amber-600 hover:bg-amber-700 text-white font-semibold"
              data-testid="login-submit"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4 mr-2" />
                  Sign in
                </>
              )}
            </Button>
          </form>

          <DemoCredentials onPick={(e, p) => { setEmail(e); setPassword(p); setError(null); }} />
        </CardContent>
      </Card>
    </div>
  );
}

function DemoCredentials({
  onPick,
}: {
  onPick: (email: string, password: string) => void;
}) {
  // The four seeded admin accounts documented in the Makefile `make login`
  // target. Surfacing them as one-click chips makes the Tuesday demo flow
  // snappy — click "Bula Pesa operator", land on the dashboard.
  const accounts = [
    { label: "Bula Pesa operator", email: "bula-pesa@ardalink.test", password: "bula-pesa" },
    { label: "Garbatulla operator", email: "garbatulla@ardalink.test", password: "garbatulla" },
    { label: "Merti operator", email: "merti@ardalink.test", password: "merti" },
    { label: "Admin (all wards)", email: "admin@ardalink.test", password: "admin-secret-2024" },
  ];
  return (
    <div className="mt-6 pt-4 border-t border-gray-800">
      <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 font-semibold">
        Demo accounts — click to fill
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {accounts.map((a) => (
          <button
            key={a.email}
            type="button"
            data-testid={`demo-${a.email}`}
            onClick={() => onPick(a.email, a.password)}
            className="text-left text-[11px] px-2 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-amber-300 transition-colors"
          >
            <span className="font-semibold">{a.label}</span>
            <span className="block text-gray-500 font-mono text-[10px] truncate">
              {a.email}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default LoginPage;
