import { Router, type IRouter } from "express";
import {
  getPublicTalkStatus,
  setPublicTalkEnabled,
} from "../lib/publicTalkLimits.js";
import { requireTrustedOrigin } from "../lib/originGuard.js";

const router: IRouter = Router();

/**
 * Public-talk status (cost rails). Safe to expose unauthenticated —
 * it reveals only aggregate budget usage, never per-caller data. The
 * talk app reads this to show "service paused / daily limit reached"
 * banners; the dashboard reads it to render the usage card.
 */
router.get("/public-talk/status", (_req, res) => {
  res.json(getPublicTalkStatus());
});

/**
 * Kill switch. Trusted-origin only — the dashboard is the only surface
 * that should flip this. Public talk app cannot disable / re-enable.
 */
router.post("/public-talk/switch", requireTrustedOrigin, (req, res) => {
  const body = (req.body ?? {}) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({
      error: "invalid_body",
      message: "Expected { enabled: boolean }",
    });
    return;
  }
  const status = setPublicTalkEnabled(body.enabled);
  req.log.warn(
    { enabled: status.enabled },
    "[PublicTalk] Kill switch toggled via API",
  );
  res.json(status);
});

export default router;
