/**
 * Multi-tenant utilities.
 *
 * Three responsibilities:
 *   1. Verify a JWT (HS256 with shared secret) and extract the `tenant_id` claim.
 *   2. Mint the HMAC-SHA256 attestation that ardalink-engine validates
 *      before trusting the forwarded `X-Tenant-ID` header.
 *   3. Resolve feature flags for a tenant.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface TenantClaims {
  sub: string;
  tenant_id: string;
  scope?: string[];
  iat?: number;
  exp?: number;
}

const TENANT_ATTESTATION_SECRET = (): string =>
  process.env.TENANT_ATTESTATION_SECRET ?? "";

export class TenantError extends Error {
  constructor(
    message: string,
    readonly status: number = 401,
  ) {
    super(message);
    this.name = "TenantError";
  }
}

/**
 * Verify a JWT (HS256 only — production should use a real IdP).
 * Returns the decoded claims, or throws `TenantError`.
 *
 * Expected payload: { sub, tenant_id, scope?, iat?, exp? }
 */
export function verifyJwt(token: string, secret: string): TenantClaims {
  if (!secret) {
    throw new TenantError("JWT secret not configured", 500);
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TenantError("Malformed JWT");
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(
    Buffer.from(headerB64, "base64url").toString("utf8"),
  ) as {
    alg: string;
  };
  if (header.alg !== "HS256") {
    throw new TenantError("Unsupported JWT alg");
  }
  const expected = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const provided = Buffer.from(sigB64, "base64url");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new TenantError("Bad JWT signature");
  }
  const claims = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8"),
  ) as TenantClaims;
  if (!claims.tenant_id) {
    throw new TenantError("JWT missing tenant_id claim");
  }
  if (claims.exp && claims.exp * 1000 < Date.now()) {
    throw new TenantError("JWT expired");
  }
  return claims;
}

/**
 * Compute HMAC-SHA256 attestation for a tenant id. ardalink-engine verifies
 * the same value when `TENANT_ATTESTATION_SECRET` is set.
 */
export function attestTenant(tenantId: string): string {
  const secret = TENANT_ATTESTATION_SECRET();
  if (!secret) {
    return "";
  }
  return createHmac("sha256", secret).update(tenantId).digest("hex");
}

/**
 * Build the headers this service attaches when forwarding a request to
 * ardalink-engine (or any other downstream service that shares the secret).
 */
export function tenantForwardHeaders(tenantId: string): {
  "X-Tenant-ID": string;
  "X-Tenant-Sig": string;
} {
  return {
    "X-Tenant-ID": tenantId,
    "X-Tenant-Sig": attestTenant(tenantId),
  };
}
