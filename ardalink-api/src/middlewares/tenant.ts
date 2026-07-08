import type { NextFunction, Request, Response } from "express";

import { TenantError, verifyJwt, type TenantClaims } from "../lib/tenancy.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantClaims;
    }
  }
}

function jwtSecret(): string {
  return process.env.JWT_SECRET ?? "";
}

/**
 * Express middleware that enforces a valid JWT on every request and attaches
 * the decoded `tenant_id` claim to `req.tenant`.
 *
 * Bypass paths (health, docs, login) are listed in `PUBLIC_PATHS` below.
 */
export function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  // /api/demo* — demo simulators (USSD, SMS, Voice) for local testing
  // without Africa's Talking dependency. Safe to expose publicly.
  if (req.path === "/api/demo" || req.path.startsWith("/api/demo/")) {
    return next();
  }
  // /api/call-tokens/:token (GET) — recipient-page status check; harmless
  // lookup, must work on phones where the recipient clicked a shared link
  // and may not have a Bearer token. Minting (POST) still requires both
  // Bearer auth and a trusted origin.
  if (req.method === "GET" && /^\/api\/call-tokens\/[^/]+$/.test(req.path)) {
    return next();
  }
  const secret = jwtSecret();
  if (!secret) {
    res.status(500).json({ error: "JWT_SECRET not configured" });
    return;
  }
  const auth = req.header("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }
  const token = auth.slice(7).trim();
  try {
    const claims = verifyJwt(token, secret);
    req.tenant = claims;
    next();
  } catch (err) {
    const status = err instanceof TenantError ? err.status : 401;
    const message = err instanceof Error ? err.message : "Unauthorized";
    res.status(status).json({ error: message });
  }
}

/**
 * Paths the tenant middleware skips. Anything not on this list requires
 * a valid Bearer JWT whose `tenant_id` claim becomes req.tenant.tenant_id.
 *
 * Public-by-contract (no auth):
 *   /api/healthz                            — liveness probe
 *   /api/auth/login, /auth/logout, /auth/me — login + session inspection
 *   /api/public-talk/status                 — daily-budget banner data; docstring claims
 *                                              safe-to-expose (it only reveals aggregate
 *                                              budget usage, never per-caller data)
 *   /api/voice-callback                     — Africa's Talking webhook; AT can't sign JWTs
 *   /api/voice-events                       — AT call lifecycle events; can't sign JWTs
 *   /api/ussd-callback                      — AT USSD gateway; can't sign JWTs
 *   /api/sms-callback                       — AT inbound SMS; can't sign JWTs
 *   /api/demo/*                             — demo simulators (USSD, SMS, Voice) for local
 *                                              testing without Africa's Talking dependency
 *   /api/call-tokens/:token                 — recipient-page status check; harmless lookup
 *
 * Everything else goes through tenantMiddleware.
 */
const PUBLIC_PATHS = new Set<string>([
  "/api/healthz",
  "/api/docs",
  "/api/redoc",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/public-talk/status",
  "/api/voice-callback",
  "/api/voice-events",
  "/api/ussd-callback",
  "/api/sms-callback",
  "/api/open-data/geo/kenya-counties",
  "/api/open-data/geo/county-presets",
  "/api/open-data/geo/isiolo-wards",
  "/api/open-data/geo/ward-presets",
  "/api/open-data/geo/ward-detail",
  // Speech surfaces: /api/speech/status is diagnostic; /api/speech/token
  // must be reachable from the browser /talk client (which has no bearer);
  // /api/speech/tts is used by the operator dashboard's TTS previews.
  // /api/speech/brief.mp3 is used by AT callbacks that can't sign JWTs.
  "/api/speech/status",
  "/api/speech/token",
  "/api/speech/tts",
  "/api/speech/brief.mp3",
  // Ward geometry — read-only, aggregated across the 5 Isiolo wards.
  // No per-herder data. Kept public so the /talk app can show the map.
  "/api/wards/map",
  // /api/talk/* — the public /talk React app calls these to look up herder
  // context and post recordings. No JWT (public users); in-process rate
  // limit + Speech configuration guard prevent abuse.
  "/api/talk/context",
  "/api/talk/record",
]);
