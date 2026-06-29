import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pastoralistsTable } from "@workspace/db";
import { logger } from "./logger.js";
import {
  reservePublicCallBudget,
  UnsupportedRegionError,
  type BudgetReservation,
} from "./publicTalkLimits.js";

export {
  BudgetExceededError,
  PublicTalkDisabledError,
  PhoneDailyLimitError,
  IpDailyLimitError,
  UnsupportedRegionError,
} from "./publicTalkLimits.js";

const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_LIVE_TOKENS = 1000;

// Short cooldowns — these exist to stop *rapid-fire* abuse (script
// hammering mint over and over), NOT to punish a normal caller who got
// disconnected and wants to redial. The DAILY caps (3/phone, 3/IP, 60 min
// global) are the real cost ceiling. Long cooldowns just made the UX
// awful for legitimate callers, so we keep them very short.
const PER_PHONE_COOLDOWN_MS = 45 * 1000;
const PER_IP_COOLDOWN_MS = 20 * 1000;
const MAX_PUBLIC_SLOTS = 3;
// Bumped from 5→6 min so the model has a full minute of headroom to
// deliver its closing advice + goodbye without the hard cap chopping it
// mid-sentence. The soft wrap-up nudge fires at T-60s (see voiceStream*).
const MAX_CALL_DURATION_MS = 6 * 60 * 1000;

interface TokenRecord {
  createdAt: number;
  consumedAt: number | null;
  phone: string | null;
  ip: string | null;
  /** True iff this token currently holds a public concurrency slot
   * (pending = minted but not yet consumed). Flipped to false on consume
   * (slot transfers to activePublicSessions) or on TTL cleanup. */
  holdsPendingSlot: boolean;
  /** Daily-budget reservation held by this token (public mints only).
   * Settled with actual duration on session close, or released if the
   * token expires unused. Null for admin tokens. */
  budgetReservation: BudgetReservation | null;
}

const tokens = new Map<string, TokenRecord>();
const lastPublicCallByPhone = new Map<string, number>();
const lastPublicCallByIp = new Map<string, number>();

/**
 * Public concurrency is the SUM of:
 *   - pendingPublicTokens: minted-but-not-yet-consumed phone-bound tokens
 *     (each represents a soon-to-open WS, capacity already promised)
 *   - activePublicSessions: live phone-bound WS bridges
 *
 * We cap their sum so a flash-crowd cannot mint 1000 tokens, all connect
 * simultaneously, and blow past the spend bound. Incrementing pending at
 * mint and transferring to active on consume keeps the slot reserved for
 * the full mint→connect window.
 */
let pendingPublicTokens = 0;
let activePublicSessions = 0;

export type TokenStatus = "valid" | "missing" | "expired" | "consumed";

export class TokenCapacityError extends Error {
  constructor() {
    super("Too many active call links — try again in a moment");
    this.name = "TokenCapacityError";
  }
}

export class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(
      `You can speak with ArdaLink again in ~${Math.ceil(retryAfterSeconds / 60)} minutes.`,
    );
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ConcurrencyError extends Error {
  constructor() {
    super(
      "ArdaLink is busy with other callers right now — please try again in a minute.",
    );
    this.name = "ConcurrencyError";
  }
}

/**
 * Canonicalize a Kenyan / international phone string to strict E.164
 * (`+<digits>`, 8–15 digits after the plus). Throws on invalid input.
 *
 * Accepts forms commonly typed by humans and downstream callers:
 *   "0712 345 678"  → "+254712345678"
 *   "254712345678"  → "+254712345678"
 *   "+254712345678" → "+254712345678"
 *
 * Canonical form is required so per-phone rate-limit, pastoralist upsert,
 * and ground-truth attribution all key on the same string — otherwise
 * "0712..." and "+254712..." would bypass each other's cooldown and create
 * duplicate pastoralist rows.
 */
export function canonicalizePhone(raw: string): string {
  let s = raw.replace(/[^\d+]/g, "");
  if (!s) throw new Error("Phone number is empty");

  if (s.startsWith("+")) {
    // Already E.164-shaped — just validate the digit run.
    const digits = s.slice(1);
    if (!/^\d{8,15}$/.test(digits))
      throw new Error("Phone number is malformed");
    return "+" + digits;
  }

  // Strip any stray '+' signs that weren't leading.
  s = s.replace(/\+/g, "");

  if (s.startsWith("00")) s = s.slice(2); // 00254... → 254...
  if (s.startsWith("0")) s = "254" + s.slice(1); // 0712... → 254712...
  // Bare local-without-leading-zero (e.g. 712345678 — 9 digits) → assume KE.
  if (s.length === 9 && /^[17]/.test(s)) s = "254" + s;

  if (!/^\d{8,15}$/.test(s)) throw new Error("Phone number is malformed");
  return "+" + s;
}

function pruneExpired(): number {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  let live = 0;
  for (const [t, rec] of tokens) {
    const isExpired = rec.createdAt < cutoff;
    const isConsumed = rec.consumedAt != null;

    if (isExpired && !isConsumed) {
      // Unused token timed out. Release slot + budget reservation so the
      // caps don't leak downward.
      if (rec.holdsPendingSlot) {
        rec.holdsPendingSlot = false;
        if (pendingPublicTokens > 0) pendingPublicTokens--;
      }
      if (rec.budgetReservation) {
        rec.budgetReservation.release();
        rec.budgetReservation = null;
      }
      tokens.delete(t);
      continue;
    }

    if (isConsumed) {
      // A consumed token must NOT be evicted until its budget reservation
      // has been settled by the WS close handler — settlement looks it up
      // by token. Once settled (reservation cleared), it's safe to drop.
      // The `consumedAt != null` check in `consumeToken` continues to
      // provide replay protection while the record sits here waiting.
      if (rec.budgetReservation == null) {
        tokens.delete(t);
      }
      // Consumed records do NOT count toward MAX_LIVE_TOKENS — they
      // already used their mint slot and are just waiting to settle.
      continue;
    }

    live++;
  }
  return live;
}

export interface MintOptions {
  phone?: string;
  /** Caller's IP from `req.ip` (Express trust-proxy on). Used for per-IP
   * cooldown + per-IP daily cap so one machine cannot rotate fake phone
   * numbers and drain the global budget. */
  ip?: string | null;
  /** Tenant id from the verified JWT. Required since the pilot expansion. */
  tenantId?: string;
}

export interface MintResult {
  token: string;
  expiresAt: number;
  phone: string | null;
}

/**
 * Mint a call token.
 *
 * Two call modes:
 *   1) Admin / dashboard mint — no phone. Bypasses the public rate limit and
 *      concurrency cap (gated by `requireTrustedOrigin` upstream).
 *   2) Public pastoralist mint — phone supplied. Enforces:
 *        • per-phone cooldown (1 call per 4h) so the same caller cannot
 *          hammer the AI and burn Azure Realtime credit. Applied at *mint*
 *          time using the last *successful* call's timestamp — failed mints
 *          (mic permission denied etc.) do NOT start a new cooldown because
 *          we only record `lastPublicCallByPhone` when the token is actually
 *          consumed (see `consumeToken`).
 *        • combined pending+active concurrency cap on phone-bound tokens —
 *          the slot is reserved here so a flash crowd cannot mint many
 *          tokens, connect simultaneously, and exceed the bound.
 *        • upserts the pastoralist row + bumps `last_contact_at` so future
 *          calls and the admin dashboard see this caller.
 *
 * The phone is stored on the token record so the WS upgrade handler can read
 * it back atomically when the token is consumed and pass it to the voice
 * stream for ground-truth attribution.
 */
export async function mintToken(opts: MintOptions = {}): Promise<MintResult> {
  // Always prune first so we never evict a valid unconsumed token solely to
  // make room — that would silently violate the "single-use within 15 min"
  // contract for already-issued links. Pruning also releases pending public
  // slots held by expired/consumed tokens so the cap doesn't leak.
  const live = pruneExpired();
  if (live >= MAX_LIVE_TOKENS) {
    throw new TokenCapacityError();
  }

  let phone: string | null = null;
  let budgetReservation: BudgetReservation | null = null;

  if (opts.phone) {
    phone = canonicalizePhone(opts.phone);

    // Region gate — ArdaLink is currently Bula Pesa Ward, Isiolo, Kenya.
    // Reject anything that isn't a Kenyan number so the cost rails don't
    // get spent on out-of-area testers. Easy to widen later by adding
    // more prefixes here or making it env-tunable.
    if (!phone.startsWith("+254")) {
      throw new UnsupportedRegionError();
    }

    // ───── ATOMIC GATE ─────
    // All public-mint side-effects (slot increment, budget reservation,
    // cooldown recording) must happen synchronously here — no awaits —
    // so that two concurrent mints cannot both pass the checks before
    // either of them increments the counters. JS single-threadedness
    // makes this block atomic w.r.t. other mints. DB I/O happens AFTER.

    // 1) Per-phone cooldown (no side effect)
    const last = lastPublicCallByPhone.get(phone);
    if (last != null) {
      const elapsed = Date.now() - last;
      if (elapsed < PER_PHONE_COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil(
          (PER_PHONE_COOLDOWN_MS - elapsed) / 1000,
        );
        throw new RateLimitError(retryAfterSeconds);
      }
    }

    // 1b) Per-IP cooldown (no side effect) — same machine cannot churn
    //     through phone numbers faster than this. Independent of phone
    //     cooldown so a single IP genuinely shared by multiple people
    //     (rare but possible) still gets a chance, just throttled.
    if (opts.ip) {
      const lastIp = lastPublicCallByIp.get(opts.ip);
      if (lastIp != null) {
        const elapsedIp = Date.now() - lastIp;
        if (elapsedIp < PER_IP_COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil(
            (PER_IP_COOLDOWN_MS - elapsedIp) / 1000,
          );
          throw new RateLimitError(retryAfterSeconds);
        }
      }
    }

    // 2) Concurrency cap (no side effect)
    if (pendingPublicTokens + activePublicSessions >= MAX_PUBLIC_SLOTS) {
      throw new ConcurrencyError();
    }

    // 3) Reserve daily budget + per-phone + per-IP daily caps + kill switch
    //    (SYNC side effect: increments reservedMinutes and per-phone/per-IP
    //    counts). Throws PublicTalkDisabledError, BudgetExceededError,
    //    PhoneDailyLimitError, or IpDailyLimitError. Released on token
    //    expiry / settled on WS close.
    budgetReservation = reservePublicCallBudget(phone, opts.ip ?? null);

    // 4) Reserve concurrency slot (SYNC side effect). Done now so that
    //    further concurrent mints see the new pending count immediately,
    //    even before our async DB upsert below resolves.
    pendingPublicTokens++;

    // Upsert pastoralist by phone (find-or-create). Anonymous public callers
    // get a placeholder name until they identify themselves on a future call.
    try {
      const existing = await db
        .select()
        .from(pastoralistsTable)
        .where(eq(pastoralistsTable.phone, phone))
        .limit(1);
      if (existing.length === 0) {
        // For anonymous public callers, the tenant_id is unknown at
        // mint time. The pastoralist is registered without a
        // tenant_id; the voice bridge or follow-up call will set it
        // when the herder identifies themselves. Until then, RLS
        // will filter this row out of every tenant's view.
        //
        // NOTE: the schema now requires tenant_id NOT NULL. To
        // preserve the public-talk flow we insert with a sentinel
        // 'unattributed' tenant_id. A future migration should split
        // public pastoralist creation from tenant-scoped registration.
        await db.insert(pastoralistsTable).values({
          tenantId: "unattributed",
          name: `Caller ${phone.slice(-4)}`,
          phone,
          location: "",
          cattle: 0,
          goats: 0,
          camels: 0,
          waterSource: "Unknown",
          alertsEnabled: true,
        });
        logger.info(
          { phone },
          "[CallTokens] New pastoralist registered from public talk page",
        );
      } else {
        await db
          .update(pastoralistsTable)
          .set({ lastContactAt: new Date() })
          .where(eq(pastoralistsTable.phone, phone));
      }
    } catch (err) {
      // Don't block the call if the DB upsert fails — log and continue.
      logger.warn(
        { err, phone },
        "[CallTokens] Pastoralist upsert failed (continuing)",
      );
    }
  }

  const token = randomBytes(16).toString("hex");
  const createdAt = Date.now();
  const holdsPendingSlot = phone != null;
  // Note: pendingPublicTokens was already incremented synchronously above
  // for phone-bound mints (inside the atomic gate). Don't double-count.
  tokens.set(token, {
    createdAt,
    consumedAt: null,
    phone,
    ip: opts.ip ?? null,
    holdsPendingSlot,
    budgetReservation,
  });
  return { token, expiresAt: createdAt + TOKEN_TTL_MS, phone };
}

export function checkToken(token: string | null | undefined): TokenStatus {
  if (!token) return "missing";
  const rec = tokens.get(token);
  if (!rec) return "missing";
  if (Date.now() - rec.createdAt > TOKEN_TTL_MS) return "expired";
  if (rec.consumedAt != null) return "consumed";
  return "valid";
}

export interface ConsumeResult {
  ok: boolean;
  phone: string | null;
}

/**
 * Atomically consume a token. Returns `{ ok: true, phone }` if the token was
 * valid (where `phone` may be null for admin tokens); `{ ok: false, ... }` if
 * missing, expired, or already consumed. Safe to call from concurrent
 * WebSocket upgrade handlers — Node's event loop makes the read-then-write
 * sequence atomic for in-memory state.
 *
 * Side effects on consumption of a phone-bound token:
 *   • starts the per-phone cooldown (records `lastPublicCallByPhone[phone]`),
 *     so failed mints / never-connected tokens do NOT lock the caller out;
 *   • transfers the concurrency slot from `pendingPublicTokens` to
 *     `activePublicSessions` (a release in `registerPublicSessionClosed`).
 */
export function consumeToken(token: string | null | undefined): ConsumeResult {
  if (!token) return { ok: false, phone: null };
  const rec = tokens.get(token);
  if (!rec) return { ok: false, phone: null };
  if (Date.now() - rec.createdAt > TOKEN_TTL_MS)
    return { ok: false, phone: null };
  if (rec.consumedAt != null) return { ok: false, phone: null };
  rec.consumedAt = Date.now();
  if (rec.phone) {
    lastPublicCallByPhone.set(rec.phone, Date.now());
    if (rec.ip) lastPublicCallByIp.set(rec.ip, Date.now());
    if (rec.holdsPendingSlot) {
      rec.holdsPendingSlot = false;
      if (pendingPublicTokens > 0) pendingPublicTokens--;
      activePublicSessions++;
    }
  }
  logger.info(
    {
      token: token.slice(0, 8) + "…",
      hasPhone: rec.phone != null,
      pendingPublicTokens,
      activePublicSessions,
    },
    "[CallTokens] Token consumed",
  );
  return { ok: true, phone: rec.phone };
}

/**
 * Public-session lifecycle. `registerPublicSessionOpen` is a no-op now that
 * the slot is acquired at mint and transferred to active on consume — kept
 * exported for symmetry / forward-compat in case the bridge ever opens
 * outside the consume path.
 */
export function registerPublicSessionOpen(): void {
  // Slot accounting happens in mint + consume; nothing to do here.
}

export function registerPublicSessionClosed(): void {
  if (activePublicSessions > 0) activePublicSessions--;
  logger.info(
    { activePublicSessions, pendingPublicTokens },
    "[CallTokens] Public session closed",
  );
}

/**
 * Settle the budget reservation for a consumed token using the actual call
 * duration. Called from the browser-voice WS close handler. The reservation
 * (worst-case minutes) is replaced with the real elapsed minutes, freeing
 * the unused portion back into the daily budget.
 *
 * Token is looked up by the value we minted — we don't need to keep the
 * reservation alive on the talk-app side. Safe to call once per session;
 * the reservation handle itself is idempotent.
 */
export function settleTokenReservation(
  token: string | null,
  actualMinutes: number,
  phone: string | null,
): void {
  if (!token) return;
  const rec = tokens.get(token);
  if (!rec || !rec.budgetReservation) return;
  rec.budgetReservation.settle(actualMinutes, phone);
  rec.budgetReservation = null;
  // Now that the reservation is settled, drop the consumed record —
  // replay protection no longer needs it and keeping it just leaks memory.
  if (rec.consumedAt != null) {
    tokens.delete(token);
  }
}

export const TOKEN_TTL_SECONDS = TOKEN_TTL_MS / 1000;
export const MAX_CALL_DURATION_SECONDS = MAX_CALL_DURATION_MS / 1000;
export { MAX_CALL_DURATION_MS };
