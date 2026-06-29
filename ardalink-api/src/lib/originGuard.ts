import type { Request, Response, NextFunction } from "express";

/**
 * Returns true if the supplied Origin header value is one of our trusted
 * surfaces (the dashboard served from this Repl, localhost during dev, or
 * the deployed `.replit.app` domain). Empty / missing Origin is REJECTED —
 * legitimate browsers always include Origin on cross-origin fetches and on
 * WebSocket upgrades, so an empty Origin almost always means a non-browser
 * client (curl, server-to-server script) which we treat as untrusted to
 * prevent Azure Realtime credit abuse.
 */
export function isTrustedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname.endsWith(".replit.dev")) return true;
    if (hostname.endsWith(".replit.app")) return true;
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    if (devDomain && hostname === devDomain) return true;
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
