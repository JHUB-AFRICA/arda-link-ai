import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { db, adminUsersTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST }).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const JWT_SECRET = process.env.JWT_SECRET ?? "";
if (JWT_SECRET.length < 32) {
  logger.warn({ length: JWT_SECRET.length }, "JWT_SECRET is too short (need >=32 bytes) - login will fail");
}

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function mintJwt(claims: { sub: string; tenant_id: string; role: string; exp: number }): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

const loginBodySchema = z.object({
  email: z.string().email().or(z.string().min(3)),
  password: z.string().min(1),
});

router.post("/auth/login", async (req, res) => {
  if (JWT_SECRET.length < 32) {
    res.status(503).json({ error: "auth not configured" });
    return;
  }
  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { email, password } = parsed.data;

  let user: typeof adminUsersTable.$inferSelect | undefined;
  try {
    const rows = await db.select().from(adminUsersTable).where(eq(adminUsersTable.email, email.toLowerCase())).limit(1);
    user = rows[0];
  } catch (e) {
    req.log.error({ err: e }, "login: db error");
    res.status(500).json({ error: "login failed" });
    return;
  }

  const ok = user
    ? verifyPassword(password, user.passwordHash)
    : (scryptSync(password, "decoy-salt", SCRYPT_KEYLEN, { N: SCRYPT_COST }), false);

  if (!user || !ok) {
    req.log.info({ email, found: !!user }, "login: invalid credentials");
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const token = mintJwt({ sub: user.email, tenant_id: user.tenantId, role: user.role, exp });

  try {
    await db.update(adminUsersTable).set({ lastLoginAt: new Date() }).where(eq(adminUsersTable.id, user.id));
  } catch (e) {
    req.log.warn({ err: e }, "login: failed to update lastLoginAt");
  }

  req.log.info({ email: user.email, tenant_id: user.tenantId, role: user.role }, "login: success");
  res.json({
    token,
    tenant_id: user.tenantId,
    display_name: user.displayName,
    role: user.role,
    expires_at: new Date(exp * 1000).toISOString(),
  });
});

router.post("/auth/logout", (_req, res) => {
  res.json({ status: "logged_out" });
});

router.get("/auth/me", async (req, res) => {
  const auth = req.header("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "no token" });
    return;
  }
  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    res.status(401).json({ error: "malformed token" });
    return;
  }
  const expected = createHmac("sha256", JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[2], "base64url");
  } catch {
    res.status(401).json({ error: "bad signature" });
    return;
  }
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    res.status(401).json({ error: "bad signature" });
    return;
  }
  let claims: { sub: string; tenant_id: string; role: string; exp: number };
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    res.status(401).json({ error: "malformed payload" });
    return;
  }
  if (claims.exp * 1000 < Date.now()) {
    res.status(401).json({ error: "token expired" });
    return;
  }
  res.json({
    email: claims.sub,
    tenant_id: claims.tenant_id,
    role: claims.role,
    expires_at: new Date(claims.exp * 1000).toISOString(),
  });
});

export default router;
