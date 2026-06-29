import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createHmac, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const TEST_EMAIL = "auth-test@ardalink.test";
const TEST_PASSWORD = "test-password-123";
const TEST_TENANT = "bula-pesa";

function hashForTest(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64, { N: 16384 }).toString("hex");
  return `${salt}:${hash}`;
}

const TEST_HASH = hashForTest(TEST_PASSWORD);

// Mutable mock state — tests set this per-case
let currentUser: {
  id: number;
  email: string;
  passwordHash: string;
  tenantId: string;
  displayName: string;
  role: string;
  createdAt: Date;
  lastLoginAt: Date | null;
} | null = null;

function setMockUser(email: string = TEST_EMAIL) {
  currentUser = {
    id: 1,
    email,
    passwordHash: TEST_HASH,
    tenantId: TEST_TENANT,
    displayName: "Auth Test User",
    role: "operator",
    createdAt: new Date(),
    lastLoginAt: null,
  };
}

vi.mock("../src/lib/tenancy-context.js", () => ({
  withTenantContext: async <T>(_tenant: string, fn: (tx: unknown) => Promise<T>) => fn({}),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(currentUser ? [currentUser] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  },
  adminUsersTable: { email: { name: "email" } },
}));

import { createApp } from "../src/app";

const SECRET = "auth-test-secret-32-bytes-1234567890";

describe("POST /api/auth/login", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });
  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it("returns 200 + JWT for valid credentials", async () => {
    setMockUser();
    const res = await request(createApp())
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");
    expect(res.body.tenant_id).toBe(TEST_TENANT);
    expect(res.body.display_name).toBe("Auth Test User");
    expect(res.body.role).toBe("operator");
    expect(res.body.token.split(".")).toHaveLength(3);
  });

  it("returns 401 for wrong password", async () => {
    setMockUser();
    const res = await request(createApp())
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid credentials" });
  });

  it("returns 401 for unknown email (no enumeration)", async () => {
    currentUser = null;
    const res = await request(createApp())
      .post("/api/auth/login")
      .send({ email: "nobody@ardalink.test", password: "anything" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid credentials" });
  });

  it("returns 400 for malformed body", async () => {
    const res = await request(createApp())
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL });
    expect(res.status).toBe(400);
  });

  it("GET /api/auth/me returns claims with a valid token", async () => {
    setMockUser();
    const login = await request(createApp())
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const res = await request(createApp())
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(TEST_EMAIL);
    expect(res.body.tenant_id).toBe(TEST_TENANT);
    expect(res.body.role).toBe("operator");
  });

  it("GET /api/auth/me rejects requests without a token", async () => {
    const res = await request(createApp()).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/me rejects expired tokens", async () => {
    const header = { alg: "HS256", typ: "JWT" };
    const enc = (o: object): string =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const headerB64 = enc(header);
    const payloadB64 = enc({
      sub: TEST_EMAIL,
      tenant_id: TEST_TENANT,
      role: "operator",
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const sig = createHmac("sha256", SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    const expired = `${headerB64}.${payloadB64}.${sig}`;
    const res = await request(createApp())
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });
});

describe("password hashing helpers", () => {
  it("scrypt hash is verified in constant time", () => {
    const stored = hashForTest("hunter2");
    const ok = (() => {
      const [salt, hash] = stored.split(":");
      const expected = Buffer.from(hash, "hex");
      const actual = scryptSync("hunter2", salt, 64, { N: 16384 });
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    })();
    expect(ok).toBe(true);
  });

  it("wrong password fails verification", () => {
    const stored = hashForTest("hunter2");
    const ok = (() => {
      const [salt, hash] = stored.split(":");
      const expected = Buffer.from(hash, "hex");
      const actual = scryptSync("hunter3", salt, 64, { N: 16384 });
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    })();
    expect(ok).toBe(false);
  });
});
