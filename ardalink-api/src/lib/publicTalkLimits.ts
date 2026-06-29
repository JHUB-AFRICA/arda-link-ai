import { logger } from "./logger.js";

/**
 * Public-talk cost rails: daily call-minute budget + admin kill switch.
 *
 * Goal: bound worst-case Azure Realtime spend per UTC day, and give the
 * operator a panic switch that instantly disables public minting.
 *
 * State is in-memory (resets on server restart, which is conservative —
 * a restart can only LOWER spend, never raise it). If the kill switch is
 * flipped off in code and the process restarts, it comes back on; the
 * operator is expected to flip it again. The daily budget is the binding
 * cost ceiling — the kill switch is for incident response.
 */

const DEFAULT_DAILY_BUDGET_MINUTES = 60;
const DEFAULT_MAX_CALLS_PER_PHONE_PER_DAY = 3;
const DEFAULT_MAX_CALLS_PER_IP_PER_DAY = 3;

const DAILY_BUDGET_MINUTES = (() => {
  const raw = process.env.PUBLIC_TALK_DAILY_BUDGET_MINUTES;
  if (!raw) return DEFAULT_DAILY_BUDGET_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_BUDGET_MINUTES;
  return n;
})();

const MAX_CALLS_PER_PHONE_PER_DAY = (() => {
  const raw = process.env.PUBLIC_TALK_MAX_CALLS_PER_PHONE;
  if (!raw) return DEFAULT_MAX_CALLS_PER_PHONE_PER_DAY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CALLS_PER_PHONE_PER_DAY;
  return Math.floor(n);
})();

const MAX_CALLS_PER_IP_PER_DAY = (() => {
  const raw = process.env.PUBLIC_TALK_MAX_CALLS_PER_IP;
  if (!raw) return DEFAULT_MAX_CALLS_PER_IP_PER_DAY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CALLS_PER_IP_PER_DAY;
  return Math.floor(n);
})();

interface DayBucket {
  /** UTC day key, e.g. "2026-05-25" */
  day: string;
  /** Minutes actually consumed by completed calls today. */
  usedMinutes: number;
  /** Minutes promised to in-flight reservations (mint→close window).
   * Subtracted on settle, then `usedMinutes` is incremented with the
   * actual duration. Holding a reservation against the budget while a
   * call is in flight prevents N concurrent mints from blowing through
   * the cap before any of them settle. */
  reservedMinutes: number;
  callCount: number;
  /** Per-phone call counts for the current UTC day. Reset on rollover.
   * Counted at mint time (reservation) and decremented on release() so
   * unconsumed tokens don't burn the caller's daily allowance. */
  callsByPhone: Map<string, number>;
  /** Per-IP call counts for the current UTC day. Prevents a single
   * machine from rotating fake phone numbers to bypass the per-phone cap
   * and drain the global budget. */
  callsByIp: Map<string, number>;
}

let bucket: DayBucket = {
  day: utcDay(),
  usedMinutes: 0,
  reservedMinutes: 0,
  callCount: 0,
  callsByPhone: new Map(),
  callsByIp: new Map(),
};
let killSwitchEnabled = true;

/** Worst-case minutes one call can burn — must match MAX_CALL_DURATION_MS. */
const MAX_MINUTES_PER_CALL = 6;

function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function nextUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return next;
}

function rolloverIfNeeded(): void {
  const today = utcDay();
  if (bucket.day !== today) {
    logger.info(
      {
        previousDay: bucket.day,
        usedMinutes: bucket.usedMinutes,
        reservedMinutes: bucket.reservedMinutes,
        calls: bucket.callCount,
      },
      "[PublicTalkLimits] Daily bucket rollover",
    );
    // Carry forward any in-flight reservations into the new day so calls
    // straddling UTC midnight still settle against a real reservation.
    // Per-phone counts reset hard at midnight UTC — that's the whole point
    // of the cap.
    const carryover = bucket.reservedMinutes;
    bucket = {
      day: today,
      usedMinutes: 0,
      reservedMinutes: carryover,
      callCount: 0,
      callsByPhone: new Map(),
      callsByIp: new Map(),
    };
  }
}

export class BudgetExceededError extends Error {
  resetsAt: number;
  constructor(resetsAt: number) {
    super(
      "ArdaLink has reached its daily call limit. Please try again tomorrow.",
    );
    this.name = "BudgetExceededError";
    this.resetsAt = resetsAt;
  }
}

export class PublicTalkDisabledError extends Error {
  constructor() {
    super(
      "ArdaLink public calls are temporarily disabled. Please try again later.",
    );
    this.name = "PublicTalkDisabledError";
  }
}

export class PhoneDailyLimitError extends Error {
  resetsAt: number;
  limit: number;
  constructor(limit: number, resetsAt: number) {
    super(
      `You've reached today's call limit (${limit} calls). Please try again tomorrow.`,
    );
    this.name = "PhoneDailyLimitError";
    this.limit = limit;
    this.resetsAt = resetsAt;
  }
}

export class IpDailyLimitError extends Error {
  resetsAt: number;
  limit: number;
  constructor(limit: number, resetsAt: number) {
    super(
      `Too many calls from this device today (${limit}). Please try again tomorrow.`,
    );
    this.name = "IpDailyLimitError";
    this.limit = limit;
    this.resetsAt = resetsAt;
  }
}

export class UnsupportedRegionError extends Error {
  constructor() {
    super("ArdaLink is currently available only for Kenyan numbers (+254).");
    this.name = "UnsupportedRegionError";
  }
}

/**
 * Reserve `MAX_MINUTES_PER_CALL` of budget for a public call at MINT time.
 * Returns a `BudgetReservation` whose `settle(actual)` is called on WS close
 * (replaces the reservation with the real duration) and whose `release()`
 * is called on mint failure / token expiry (gives the budget back).
 *
 * Must be called SYNCHRONOUSLY — no awaits between the check and the
 * increment — so that two concurrent mints cannot both observe spare
 * budget and both pass through. Likewise for the kill switch.
 *
 * Throws `PublicTalkDisabledError` (switch off) or `BudgetExceededError`
 * (no headroom left for one more worst-case call).
 */
export interface BudgetReservation {
  reservedMinutes: number;
  settle(actualMinutes: number, phone: string | null): void;
  release(): void;
}

export function reservePublicCallBudget(
  phone: string | null = null,
  ip: string | null = null,
): BudgetReservation {
  rolloverIfNeeded();
  if (!killSwitchEnabled) {
    throw new PublicTalkDisabledError();
  }

  // Per-phone daily cap — applies only to phone-bound mints. Checked
  // synchronously with the global budget so two concurrent mints from
  // the same number cannot both pass the check before either increments.
  if (phone) {
    const used = bucket.callsByPhone.get(phone) ?? 0;
    if (used >= MAX_CALLS_PER_PHONE_PER_DAY) {
      throw new PhoneDailyLimitError(
        MAX_CALLS_PER_PHONE_PER_DAY,
        nextUtcMidnight(),
      );
    }
  }

  // Per-IP daily cap — prevents one machine from rotating fake phone
  // numbers to bypass the per-phone limit and drain the global budget.
  // Checked synchronously in the same atomic block as phone + global.
  if (ip) {
    const usedIp = bucket.callsByIp.get(ip) ?? 0;
    if (usedIp >= MAX_CALLS_PER_IP_PER_DAY) {
      throw new IpDailyLimitError(MAX_CALLS_PER_IP_PER_DAY, nextUtcMidnight());
    }
  }

  const projected =
    bucket.usedMinutes + bucket.reservedMinutes + MAX_MINUTES_PER_CALL;
  if (projected > DAILY_BUDGET_MINUTES) {
    throw new BudgetExceededError(nextUtcMidnight());
  }

  bucket.reservedMinutes += MAX_MINUTES_PER_CALL;
  if (phone) {
    bucket.callsByPhone.set(phone, (bucket.callsByPhone.get(phone) ?? 0) + 1);
  }
  if (ip) {
    bucket.callsByIp.set(ip, (bucket.callsByIp.get(ip) ?? 0) + 1);
  }
  const heldPhone = phone;
  const heldIp = ip;
  let alreadyClosed = false;
  return {
    reservedMinutes: MAX_MINUTES_PER_CALL,
    settle(actualMinutes: number, phoneArg: string | null): void {
      if (alreadyClosed) return;
      alreadyClosed = true;
      rolloverIfNeeded();
      bucket.reservedMinutes = Math.max(
        0,
        bucket.reservedMinutes - MAX_MINUTES_PER_CALL,
      );
      // Per-phone count stays — this call happened, it should burn the
      // caller's allowance.
      if (!Number.isFinite(actualMinutes) || actualMinutes <= 0) {
        bucket.callCount += 1;
        return;
      }
      const clamped = Math.min(actualMinutes, MAX_MINUTES_PER_CALL + 1); // tiny slack for timer jitter
      bucket.usedMinutes += clamped;
      bucket.callCount += 1;
      logger.info(
        {
          phone: phoneArg,
          actualMinutes: clamped,
          usedMinutesToday: bucket.usedMinutes,
          reservedMinutesToday: bucket.reservedMinutes,
          budgetMinutes: DAILY_BUDGET_MINUTES,
          callsToday: bucket.callCount,
          callsForPhoneToday: heldPhone
            ? (bucket.callsByPhone.get(heldPhone) ?? 0)
            : null,
        },
        "[PublicTalkLimits] Settled call minutes",
      );
    },
    release(): void {
      if (alreadyClosed) return;
      alreadyClosed = true;
      rolloverIfNeeded();
      bucket.reservedMinutes = Math.max(
        0,
        bucket.reservedMinutes - MAX_MINUTES_PER_CALL,
      );
      // Token expired unused → give the caller's daily allowance back
      // (so a flaky network doesn't lock them out for the rest of the day).
      if (heldPhone) {
        const cur = bucket.callsByPhone.get(heldPhone) ?? 0;
        if (cur <= 1) bucket.callsByPhone.delete(heldPhone);
        else bucket.callsByPhone.set(heldPhone, cur - 1);
      }
      if (heldIp) {
        const curIp = bucket.callsByIp.get(heldIp) ?? 0;
        if (curIp <= 1) bucket.callsByIp.delete(heldIp);
        else bucket.callsByIp.set(heldIp, curIp - 1);
      }
      logger.info(
        { reservedMinutesToday: bucket.reservedMinutes },
        "[PublicTalkLimits] Released reservation (mint failed or token expired)",
      );
    },
  };
}

/** How many calls this phone has already made today (UTC). */
export function getPhoneCallsToday(phone: string): number {
  rolloverIfNeeded();
  return bucket.callsByPhone.get(phone) ?? 0;
}

export const PUBLIC_TALK_MAX_CALLS_PER_PHONE = MAX_CALLS_PER_PHONE_PER_DAY;
export const PUBLIC_TALK_MAX_CALLS_PER_IP = MAX_CALLS_PER_IP_PER_DAY;

export interface PublicTalkStatus {
  enabled: boolean;
  dailyBudgetMinutes: number;
  usedMinutesToday: number;
  reservedMinutesToday: number;
  remainingMinutes: number;
  callsToday: number;
  resetsAt: number;
  day: string;
}

export function getPublicTalkStatus(): PublicTalkStatus {
  rolloverIfNeeded();
  const committed = bucket.usedMinutes + bucket.reservedMinutes;
  return {
    enabled: killSwitchEnabled,
    dailyBudgetMinutes: DAILY_BUDGET_MINUTES,
    usedMinutesToday: Math.round(bucket.usedMinutes * 100) / 100,
    reservedMinutesToday: Math.round(bucket.reservedMinutes * 100) / 100,
    remainingMinutes: Math.max(0, DAILY_BUDGET_MINUTES - committed),
    callsToday: bucket.callCount,
    resetsAt: nextUtcMidnight(),
    day: bucket.day,
  };
}

export function setPublicTalkEnabled(enabled: boolean): PublicTalkStatus {
  killSwitchEnabled = !!enabled;
  logger.warn(
    { enabled: killSwitchEnabled },
    "[PublicTalkLimits] Kill switch toggled",
  );
  return getPublicTalkStatus();
}
