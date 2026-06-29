import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

import { attestTenant, verifyJwt, TenantError } from "../src/lib/tenancy";

const SECRET = "unit-test-secret-do-not-use-in-prod";

function mintJwt(claims: object, secret = SECRET): string {
  const header = { alg: "HS256", typ: "JWT" };
  const enc = (o: object): string =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const headerB64 = enc(header);
  const payloadB64 = enc(claims);
  const sig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${sig}`;
}

describe("verifyJwt", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("decodes a valid token with tenant_id", () => {
    const token = mintJwt({ sub: "user-1", tenant_id: "bula-pesa" });
    const claims = verifyJwt(token, SECRET);
    expect(claims.tenant_id).toBe("bula-pesa");
    expect(claims.sub).toBe("user-1");
  });

  it("rejects a token without tenant_id", () => {
    const token = mintJwt({ sub: "user-1" });
    expect(() => verifyJwt(token, SECRET)).toThrow(TenantError);
  });

  it("rejects an expired token", () => {
    const token = mintJwt({ sub: "user-1", tenant_id: "x", exp: 1 });
    expect(() => verifyJwt(token, SECRET)).toThrow(/expired/i);
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintJwt({ sub: "user-1", tenant_id: "x" }, "wrong-secret");
    expect(() => verifyJwt(token, SECRET)).toThrow(/signature/i);
  });

  it("rejects a malformed token", () => {
    expect(() => verifyJwt("not-a-jwt", SECRET)).toThrow(/malformed/i);
  });
});

describe("attestTenant", () => {
  it("produces a deterministic hex digest", () => {
    process.env.TENANT_ATTESTATION_SECRET = SECRET;
    const a = attestTenant("bula-pesa");
    const b = attestTenant("bula-pesa");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    delete process.env.TENANT_ATTESTATION_SECRET;
  });

  it("returns empty string when secret unset", () => {
    delete process.env.TENANT_ATTESTATION_SECRET;
    expect(attestTenant("bula-pesa")).toBe("");
  });
});
