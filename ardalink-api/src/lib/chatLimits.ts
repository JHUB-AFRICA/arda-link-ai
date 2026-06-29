import { logger } from "./logger.js";

/**
 * Public /talk text-chat rate limits.
 *
 * Separate from the voice-call budget — text chat is far cheaper, so we use
 * its own counters. In-memory, UTC-day buckets, resets on restart (which can
 * only LOWER spend, never raise it).
 *
 * Two layers per IP:
 *   - short cooldown (~3s) to stop rapid hammering
 *   - daily cap (~30 messages) to bound worst-case spend
 *
 * Admin /api/chat is untouched. Only /api/talk-chat passes through here.
 */

const DEFAULT_MAX_MSGS_PER_IP_PER_DAY = 30;
const DEFAULT_PER_IP_COOLDOWN_MS = 3_000;
const MAX_MESSAGE_LENGTH = 500;

const MAX_MSGS_PER_IP_PER_DAY = (() => {
  const raw = process.env.TALK_CHAT_MAX_MSGS_PER_IP;
  if (!raw) return DEFAULT_MAX_MSGS_PER_IP_PER_DAY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_MSGS_PER_IP_PER_DAY;
  return Math.floor(n);
})();

const PER_IP_COOLDOWN_MS = (() => {
  const raw = process.env.TALK_CHAT_PER_IP_COOLDOWN_MS;
  if (!raw) return DEFAULT_PER_IP_COOLDOWN_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PER_IP_COOLDOWN_MS;
  return n;
})();

interface DayBucket {
  day: string;
  msgsByIp: Map<string, number>;
  lastMsgAtByIp: Map<string, number>;
}

let bucket: DayBucket = {
  day: utcDay(),
  msgsByIp: new Map(),
  lastMsgAtByIp: new Map(),
};

function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function nextUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

function rolloverIfNeeded(): void {
  const today = utcDay();
  if (bucket.day !== today) {
    logger.info(
      { previousDay: bucket.day },
      "[ChatLimits] Daily bucket rollover",
    );
    bucket = {
      day: today,
      msgsByIp: new Map(),
      lastMsgAtByIp: new Map(),
    };
  }
}

export type ChatLimitOutcome =
  | { ok: true }
  | { ok: false; reason: "cooldown"; retryAfterSeconds: number }
  | { ok: false; reason: "daily_cap"; limit: number; resetsAt: number }
  | { ok: false; reason: "message_too_long"; maxLength: number }
  | { ok: false; reason: "message_empty" };

export function checkAndRecordTalkChat(
  ip: string | null,
  message: string,
): ChatLimitOutcome {
  const trimmed = (message ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "message_empty" };
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      reason: "message_too_long",
      maxLength: MAX_MESSAGE_LENGTH,
    };
  }

  rolloverIfNeeded();

  // No IP available (curl, unknown proxy) — fall back to a single shared
  // "anonymous" bucket so we still have *some* ceiling. Better than allowing
  // unbounded use.
  const key = ip ?? "__anon__";
  const now = Date.now();

  const lastAt = bucket.lastMsgAtByIp.get(key) ?? 0;
  const since = now - lastAt;
  if (since < PER_IP_COOLDOWN_MS) {
    return {
      ok: false,
      reason: "cooldown",
      retryAfterSeconds: Math.ceil((PER_IP_COOLDOWN_MS - since) / 1000),
    };
  }

  const used = bucket.msgsByIp.get(key) ?? 0;
  if (used >= MAX_MSGS_PER_IP_PER_DAY) {
    return {
      ok: false,
      reason: "daily_cap",
      limit: MAX_MSGS_PER_IP_PER_DAY,
      resetsAt: nextUtcMidnight(),
    };
  }

  bucket.msgsByIp.set(key, used + 1);
  bucket.lastMsgAtByIp.set(key, now);
  return { ok: true };
}

export const TALK_CHAT_MAX_MSGS_PER_IP = MAX_MSGS_PER_IP_PER_DAY;
export const TALK_CHAT_MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;

export function getTalkChatRemaining(ip: string | null): number {
  rolloverIfNeeded();
  const key = ip ?? "__anon__";
  const used = bucket.msgsByIp.get(key) ?? 0;
  return Math.max(0, MAX_MSGS_PER_IP_PER_DAY - used);
}
