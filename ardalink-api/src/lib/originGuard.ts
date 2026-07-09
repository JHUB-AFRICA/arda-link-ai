import type { Request, Response, NextFunction } from "express";

/**
 * Suffixes we always trust — the ephemeral tunnel providers we use
 * during pilot demos + the Replit surfaces. Adding a new tunnel
 * provider means one line here (or an env override, below).
 */
const TRUSTED_HOST_SUFFIXES = [
  ".replit.dev",
  ".replit.app",
  ".trycloudflare.com", // Cloudflare Quick Tunnel
  ".ngrok-free.dev", // ngrok free tier (reserved subdomains)
  ".ngrok-free.app",
  ".ngrok.app",
  ".ngrok.io",
  ".lhr.life", // localhost.run
  ".loca.lt", // localtunnel
];

/**
 * Returns true if the supplied Origin header value is one of our trusted
 * surfaces (localhost during dev, the deployed `.replit.app` domain,
 * any of our known ephemeral tunnel providers, or an env-configured
 * allowlist). Empty / missing Origin is REJECTED — legitimate browsers
 * always include Origin on cross-origin fetches and on WebSocket
 * upgrades, so an empty Origin almost always means a non-browser client
 * (curl, server-to-server script) which we treat as untrusted to
 * prevent Azure Realtime credit abuse.
 *
 * Env overrides:
 *   REPLIT_DEV_DOMAIN     — single hostname to trust (legacy)
 *   TRUSTED_ORIGIN_HOSTS  — comma-separated hostnames to trust exactly
 *                           (e.g. "abc.trycloudflare.com,foo.example.com")
 */
export function isTrustedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    for (const suffix of TRUSTED_HOST_SUFFIXES) {
      if (hostname.endsWith(suffix)) return true;
    }
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    if (devDomain && hostname === devDomain) return true;
    const extras = process.env.TRUSTED_ORIGIN_HOSTS;
    if (extras) {
      for (const h of extras.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (hostname === h) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Express middleware that blocks requests from untrusted origins. */
export function requireTrustedOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const origin = req.headers.origin;
  if (!isTrustedOrigin(origin)) {
    req.log.warn({ origin }, "Request rejected — untrusted origin");
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}
