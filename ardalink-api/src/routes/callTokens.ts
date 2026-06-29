import { Router, type IRouter } from "express";
import {
  mintToken,
  checkToken,
  TOKEN_TTL_SECONDS,
  TokenCapacityError,
  RateLimitError,
  ConcurrencyError,
  BudgetExceededError,
  PublicTalkDisabledError,
  PhoneDailyLimitError,
  IpDailyLimitError,
  UnsupportedRegionError,
} from "../lib/callTokens.js";
import { requireTrustedOrigin } from "../lib/originGuard.js";

const router: IRouter = Router();

// Minting is the sensitive operation — gate it behind a trusted-origin check
// so a random internet client cannot mint tokens and burn Azure Realtime
// credits via the browser-voice WS. Reading a token's status is harmless
// (status alone reveals nothing usable) so it stays open for the recipient
// page, which may be loaded on a phone where Origin handling varies.
router.post("/call-tokens", requireTrustedOrigin, async (req, res) => {
  const body = (req.body ?? {}) as { phone?: unknown };
  const phone =
    typeof body.phone === "string" && body.phone.trim().length > 0
      ? body.phone.trim()
      : undefined;

  try {
    const tenantId = req.tenant?.tenant_id ?? "default";
    const { token, expiresAt } = await mintToken({
      phone,
      ip: req.ip ?? null,
      tenantId,
    });
    req.log.info(
      {
        token: token.slice(0, 8) + "…",
        ttlSec: TOKEN_TTL_SECONDS,
        hasPhone: phone != null,
      },
      "[CallTokens] Minted",
    );
    res.json({ token, expiresAt, ttlSeconds: TOKEN_TTL_SECONDS });
  } catch (err) {
    if (err instanceof RateLimitError) {
      req.log.warn(
        { retryAfterSeconds: err.retryAfterSeconds },
        "[CallTokens] Mint rejected — per-phone cooldown",
      );
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
      res.status(429).json({
        error: "rate_limited",
        message: err.message,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      return;
    }
    if (err instanceof ConcurrencyError) {
      req.log.warn("[CallTokens] Mint rejected — concurrency cap");
      res.status(429).json({ error: "busy", message: err.message });
      return;
    }
    if (err instanceof PublicTalkDisabledError) {
      req.log.warn(
        "[CallTokens] Mint rejected — public talk disabled (kill switch)",
      );
      res.status(503).json({ error: "service_disabled", message: err.message });
      return;
    }
    if (err instanceof BudgetExceededError) {
      req.log.warn(
        { resetsAt: err.resetsAt },
        "[CallTokens] Mint rejected — daily budget exceeded",
      );
      res.status(503).json({
        error: "daily_budget_exceeded",
        message: err.message,
        resetsAt: err.resetsAt,
      });
      return;
    }
    if (err instanceof IpDailyLimitError) {
      req.log.warn(
        { limit: err.limit, resetsAt: err.resetsAt, ip: req.ip },
        "[CallTokens] Mint rejected — per-IP daily limit reached",
      );
      res.status(429).json({
        error: "ip_daily_limit_reached",
        message: err.message,
        limit: err.limit,
        resetsAt: err.resetsAt,
      });
      return;
    }
    if (err instanceof PhoneDailyLimitError) {
      req.log.warn(
        { limit: err.limit, resetsAt: err.resetsAt },
        "[CallTokens] Mint rejected — per-phone daily limit reached",
      );
      res.status(429).json({
        error: "phone_daily_limit_reached",
        message: err.message,
        limit: err.limit,
        resetsAt: err.resetsAt,
      });
      return;
    }
    if (err instanceof UnsupportedRegionError) {
      req.log.warn(
        "[CallTokens] Mint rejected — unsupported region (non-+254)",
      );
      res.status(400).json({
        error: "unsupported_region",
        message: err.message,
      });
      return;
    }
    if (err instanceof TokenCapacityError) {
      req.log.warn("[CallTokens] Mint rejected — capacity reached");
      res.status(429).json({ error: "capacity_reached", message: err.message });
      return;
    }
    if (err instanceof Error && /phone/i.test(err.message)) {
      res.status(400).json({ error: "invalid_phone", message: err.message });
      return;
    }
    throw err;
  }
});

router.get("/call-tokens/:token", (req, res) => {
  const status = checkToken(req.params.token);
  res.json({ status });
});

export default router;
