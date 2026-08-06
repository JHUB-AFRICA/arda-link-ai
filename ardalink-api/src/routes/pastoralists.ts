import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import {
  isSupabaseConfigured,
  listPastoralistsFull,
  upsertPastoralist,
  updatePastoralistById,
  deletePastoralistById,
  type SbPastoralist,
} from "../lib/supabase/index.js";
import { wardIdForTenant } from "../lib/wardMapping.js";
import { recordAudit } from "../lib/adminAudit.js";

/**
 * Real Supabase `pastoralists` schemas — hand-rolled, not part of the
 * generated @workspace/api-zod package. That package's CreatePastoralistBody/
 * DeletePastoralistParams model the *local Postgres mirror's* shape
 * (integer `id`, separate cattle/goats/camels fields) — a different
 * shape from the real Supabase table (UUID `pastoralist_id`, one
 * `herd_size` total). Regenerating the whole codegen'd package for this
 * one route wasn't worth it; a plain inline schema matching reality is
 * simpler, matching the precedent already set by this file's own
 * UpdatePastoralistBody before this rewrite.
 */
const CreatePastoralistBody = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  location: z.string().optional(),
  herdSize: z.number().min(0).optional(),
  preferredLanguage: z.string().optional(),
});

const UpdatePastoralistBody = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  location: z.string().optional(),
  herdSize: z.number().min(0).optional(),
  preferredLanguage: z.string().optional(),
});

function requireTenant(req: Request): string {
  const tenantId = req.tenant?.tenant_id;
  if (!tenantId) {
    throw new Error("tenant_id missing from request context");
  }
  return tenantId;
}

/** API response shape — camelCase, stable regardless of the Supabase
 * column names underneath, so the frontend isn't coupled to snake_case. */
function toApiShape(row: SbPastoralist) {
  return {
    id: row.pastoralist_id,
    name: row.full_name,
    phone: row.phone_number,
    location: row.location_text,
    herdSize: row.herd_size,
    wardId: row.ward_id,
    preferredLanguage: row.preferred_language,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const router: IRouter = Router();

/**
 * GET /api/pastoralists
 *
 * **Rewritten 2026-08-06**: this used to list the local Postgres
 * mirror's demo-seeded pastoralists (up to 15 fake rows) — completely
 * disconnected from the real Supabase `pastoralists` table every
 * herder-facing channel (voice/USSD/WhatsApp) actually reads from. An
 * operator verifying a lead via the Leads tab wrote a real row here
 * that then never appeared in this list at all. Now reads real data,
 * scoped to the caller's own ward unless they're the admin tenant.
 */
router.get("/pastoralists", async (req, res): Promise<void> => {
  try {
    const tenantId = requireTenant(req);
    if (!isSupabaseConfigured()) {
      res.json([]);
      return;
    }
    const wardId = tenantId === "admin" ? undefined : wardIdForTenant(tenantId);
    const rows = await listPastoralistsFull(wardId);
    res.json((rows ?? []).map(toApiShape));
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to list pastoralists");
    res.status(500).json({ error: "Failed to list pastoralists" });
  }
});

/**
 * POST /api/pastoralists
 * Register a new pastoralist herder directly into real Supabase.
 * ward_id is bound from the JWT's tenant claim, never the request body.
 */
router.post("/pastoralists", async (req, res): Promise<void> => {
  const parsed = CreatePastoralistBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let tenantId: string;
  try {
    tenantId = requireTenant(req);
  } catch (err: unknown) {
    req.log.error({ err }, "tenant_id missing from JWT context");
    res.status(401).json({ error: "Tenant context required" });
    return;
  }

  if (!isSupabaseConfigured()) {
    res.status(503).json({ error: "supabase_not_configured" });
    return;
  }

  const { name, phone, location, herdSize, preferredLanguage } = parsed.data;
  const wardId = tenantId === "admin" ? undefined : wardIdForTenant(tenantId);

  try {
    const row = await upsertPastoralist({
      phone_number: phone,
      full_name: name,
      location_text: location,
      herd_size: herdSize,
      preferred_language: preferredLanguage,
      ward_id: wardId,
    });
    if (!row) {
      res.status(500).json({ error: "Failed to register pastoralist" });
      return;
    }

    void recordAudit({
      actorSub: req.tenant?.sub ?? "unknown",
      tenantId,
      resource: "pastoralist",
      resourceId: row.pastoralist_id,
      action: "create",
      after: row,
    });

    req.log.info(
      { id: row.pastoralist_id, name: row.full_name, phone: row.phone_number, tenantId },
      "Pastoralist registered",
    );
    res.status(201).json(toApiShape(row));
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to register pastoralist");
    res.status(500).json({ error: "Failed to register pastoralist" });
  }
});

/**
 * PATCH /api/pastoralists/:id
 * `:id` is the real Supabase pastoralist_id (UUID) — not the local
 * mirror's integer id, which no longer applies to this route at all.
 */
router.patch("/pastoralists/:id", async (req, res): Promise<void> => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdatePastoralistBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  let tenantId: string;
  try {
    tenantId = requireTenant(req);
  } catch (err: unknown) {
    req.log.error({ err }, "tenant_id missing from JWT context");
    res.status(401).json({ error: "Tenant context required" });
    return;
  }

  if (!isSupabaseConfigured()) {
    res.status(503).json({ error: "supabase_not_configured" });
    return;
  }

  try {
    const { name, phone, location, herdSize, preferredLanguage } = parsed.data;
    const after = await updatePastoralistById(id, {
      full_name: name,
      phone_number: phone,
      location_text: location,
      herd_size: herdSize,
      preferred_language: preferredLanguage,
    });
    if (!after) {
      res.status(404).json({ error: "Pastoralist not found" });
      return;
    }

    void recordAudit({
      actorSub: req.tenant?.sub ?? "unknown",
      tenantId,
      resource: "pastoralist",
      resourceId: id,
      action: "update",
      after,
    });

    req.log.info({ id, tenantId, fields: Object.keys(parsed.data) }, "Pastoralist updated");
    res.json(toApiShape(after));
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to update pastoralist");
    res.status(500).json({ error: "Failed to update pastoralist" });
  }
});

/**
 * DELETE /api/pastoralists/:id
 * `:id` is the real Supabase pastoralist_id (UUID).
 */
router.delete("/pastoralists/:id", async (req, res): Promise<void> => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  let tenantId: string;
  try {
    tenantId = requireTenant(req);
  } catch (err: unknown) {
    req.log.error({ err }, "tenant_id missing from JWT context");
    res.status(401).json({ error: "Tenant context required" });
    return;
  }

  if (!isSupabaseConfigured()) {
    res.status(503).json({ error: "supabase_not_configured" });
    return;
  }

  try {
    const ok = await deletePastoralistById(id);
    if (!ok) {
      res.status(404).json({ error: "Pastoralist not found" });
      return;
    }

    void recordAudit({
      actorSub: req.tenant?.sub ?? "unknown",
      tenantId,
      resource: "pastoralist",
      resourceId: id,
      action: "delete",
    });

    req.log.info({ id, tenantId }, "Pastoralist removed");
    res.json({ status: "deleted" });
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to delete pastoralist");
    res.status(500).json({ error: "Failed to delete pastoralist" });
  }
});

export default router;
