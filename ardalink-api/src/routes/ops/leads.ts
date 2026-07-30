/**
 * Ops leads panel — read + verify/decline actions for pastoralist_leads.
 *
 * Endpoints (all tenant-gated via the standard Bearer middleware):
 *   GET  /api/ops/leads            → paginated leads with filters
 *   POST /api/ops/leads/:id/verify → promote lead to pastoralists +
 *                                    flip status='verified' and set
 *                                    promoted_pastoralist_id
 *   POST /api/ops/leads/:id/decline → status='declined'
 *   POST /api/ops/leads/:id/note   → append/set the ops note
 *
 * Design rules:
 *   - Never mutates ground_truth_calls or ground_truth_reports.
 *   - Verify creates a new pastoralists row from the lead's captured
 *     fields; the lead row stays for audit + link.
 *   - Optimistic response: we return the updated lead shape from the
 *     Supabase representation so the dashboard can update in-place.
 *   - Never blocks on the SMS welcome — it's dispatched async by the
 *     verify handler and any failure is logged, not fatal.
 */

import { Router, type IRouter } from "express";
import { logger } from "../../lib/logger.js";
import {
  isSupabaseConfigured,
  recentLeads,
  setLeadStatus,
  upsertPastoralist,
  type SbPastoralistLead,
} from "../../lib/supabase/index.js";
import { sendSmsViaAt } from "../../lib/africastalking.js";

const router: IRouter = Router();

router.get("/ops/leads", async (req, res): Promise<void> => {
  if (!isSupabaseConfigured()) {
    res.json({ ready: false, reason: "supabase_not_configured", leads: [] });
    return;
  }
  const limit = Math.min(
    Math.max(Number(req.query.limit) || 50, 1),
    200,
  );
  const includeInactive =
    String(req.query.includeInactive ?? "false").toLowerCase() === "true";
  const rows = await recentLeads(limit, { includeInactive });
  res.json({
    ready: true,
    count: rows?.length ?? 0,
    leads: rows ?? [],
  });
});

interface VerifyBody {
  verifiedBy?: string;
  note?: string;
}

router.post(
  "/ops/leads/:leadId/verify",
  async (req, res): Promise<void> => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: "supabase_not_configured" });
      return;
    }
    const leadId = req.params.leadId;
    const body = (req.body ?? {}) as VerifyBody;
    const opsUser =
      req.tenant?.tenant_id
        ? `${req.tenant.tenant_id}`
        : body.verifiedBy || "ops";

    // Fetch the lead first so we can copy its fields into pastoralists.
    const url = `${(process.env.SUPABASE_URL ?? "").replace(/\/$/, "")}/rest/v1/pastoralist_leads?lead_id=eq.${encodeURIComponent(leadId)}&select=*&limit=1`;
    const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
    let lead: SbPastoralistLead | null = null;
    try {
      const r = await fetch(url, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5_000),
      });
      const rows = (await r.json()) as SbPastoralistLead[];
      lead = rows[0] ?? null;
    } catch (err) {
      logger.warn({ err: String(err), leadId }, "[ops/leads] verify: lead lookup failed");
    }
    if (!lead) {
      res.status(404).json({ error: "lead_not_found" });
      return;
    }

    // Create the verified pastoralists row. upsertPastoralist merges
    // on phone_number so a repeat verify is idempotent.
    const promoted = await upsertPastoralist({
      phone_number: lead.phone_number,
      full_name: lead.full_name,
      preferred_language: lead.preferred_language,
      ward_id: lead.ward_id,
      location_text: lead.location_text,
      herd_size: lead.herd_size,
    });
    if (!promoted) {
      res.status(500).json({ error: "promote_failed" });
      return;
    }

    // Update the lead row — mark verified + link back to the promoted
    // pastoralist. Direct PATCH so we can update several fields atomically.
    try {
      const patchUrl = `${(process.env.SUPABASE_URL ?? "").replace(/\/$/, "")}/rest/v1/pastoralist_leads?lead_id=eq.${encodeURIComponent(leadId)}`;
      const patch = await fetch(patchUrl, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          status: "verified",
          verified_at: new Date().toISOString(),
          verified_by: opsUser,
          promoted_pastoralist_id: promoted.pastoralist_id,
          notes: body.note ?? lead.notes,
          updated_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!patch.ok) {
        const body = await patch.text().catch(() => "");
        logger.warn(
          { status: patch.status, body: body.slice(0, 300) },
          "[ops/leads] verify: PATCH non-2xx",
        );
      }
    } catch (err) {
      logger.warn({ err: String(err), leadId }, "[ops/leads] verify: PATCH crashed");
    }

    // Fire a welcome SMS in the lead's chosen language. Fire-and-forget.
    const welcome =
      lead.preferred_language === "en"
        ? `Welcome to ArdaLink${lead.full_name ? " " + lead.full_name.split(" ")[0] : ""}. You are verified. Text BULA for a brief, MALISHO for water, STOP to opt out.`
        : `Karibu ArdaLink${lead.full_name ? " " + lead.full_name.split(" ")[0] : ""}. Umethibitishwa. Tuma BULA kwa habari, MALISHO kwa maji, STOP kutoka.`;
    void sendSmsViaAt(lead.phone_number, welcome).catch((err) =>
      logger.warn({ err, phone: lead?.phone_number }, "[ops/leads] verify: welcome SMS failed"),
    );

    res.json({
      ok: true,
      lead_id: leadId,
      promoted_pastoralist_id: promoted.pastoralist_id,
    });
  },
);

router.post(
  "/ops/leads/:leadId/decline",
  async (req, res): Promise<void> => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: "supabase_not_configured" });
      return;
    }
    const leadId = req.params.leadId;
    // Look up phone so we can flip via setLeadStatus (which needs phone).
    const url = `${(process.env.SUPABASE_URL ?? "").replace(/\/$/, "")}/rest/v1/pastoralist_leads?lead_id=eq.${encodeURIComponent(leadId)}&select=phone_number&limit=1`;
    const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
    let phone: string | null = null;
    try {
      const r = await fetch(url, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5_000),
      });
      const rows = (await r.json()) as { phone_number: string }[];
      phone = rows[0]?.phone_number ?? null;
    } catch (err) {
      logger.warn({ err: String(err), leadId }, "[ops/leads] decline: lookup failed");
    }
    if (!phone) {
      res.status(404).json({ error: "lead_not_found" });
      return;
    }
    const ok = await setLeadStatus(phone, "declined");
    res.json({ ok, lead_id: leadId, status: ok ? "declined" : "error" });
  },
);

export default router;
