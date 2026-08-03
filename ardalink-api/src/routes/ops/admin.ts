/**
 * Ops admin panel — the operator data-management console's backend.
 *
 * This file grows across the console's build-out:
 *   Phase 1 (this commit): GET /api/ops/audit-log — read the audit trail.
 *   Phase 2: water-node / species-ring-radii edit proxy to the engine.
 *   Phase 3: ground-truth correction endpoints.
 *
 * All routes here are tenant-gated via the standard Bearer middleware
 * (same as every other ops route) — no separate auth mechanism. Every
 * write endpoint added in later phases must call recordAudit()
 * (src/lib/adminAudit.ts) — no exceptions, per migration 0008's header.
 */

import { Router, type IRouter } from "express";
import { desc, eq, and } from "drizzle-orm";
import { db, adminAuditLogTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../../lib/adminAudit.js";
import {
  fetchAdminWaterNodes,
  updateAdminWaterNode,
  verifyAdminWaterNode,
  unverifyAdminWaterNode,
  deleteAdminWaterNode,
  fetchAdminSpeciesRingRadii,
  updateAdminSpeciesRingRadius,
} from "../../lib/engine.js";
import {
  recentGroundTruthCalls,
  correctionsForCallIds,
  insertGroundTruthCorrection,
  CORRECTABLE_GROUND_TRUTH_FIELDS,
  type CorrectableGroundTruthField,
} from "../../lib/supabase/index.js";

const router: IRouter = Router();

function actorFrom(req: { tenant?: { sub: string; tenant_id: string } }): {
  actorSub: string;
  tenantId: string;
} {
  return {
    actorSub: req.tenant?.sub ?? "unknown",
    tenantId: req.tenant?.tenant_id ?? "unknown",
  };
}

router.get("/ops/audit-log", async (req, res): Promise<void> => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const resource = typeof req.query.resource === "string" ? req.query.resource : undefined;
  const actorSub = typeof req.query.actorSub === "string" ? req.query.actorSub : undefined;

  try {
    const conditions = [];
    if (resource) conditions.push(eq(adminAuditLogTable.resource, resource));
    if (actorSub) conditions.push(eq(adminAuditLogTable.actorSub, actorSub));

    const rows = await db
      .select()
      .from(adminAuditLogTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(adminAuditLogTable.createdAt))
      .limit(limit);

    res.json({ count: rows.length, entries: rows });
  } catch (err) {
    logger.error({ err }, "[OpsAdmin] audit-log read failed");
    res.status(500).json({ error: "audit_log_read_failed" });
  }
});

// ── Water sources (engine-owned, proxied) ───────────────────────────────

router.get("/ops/water-nodes", async (req, res): Promise<void> => {
  const { tenantId } = actorFrom(req);
  const nodes = await fetchAdminWaterNodes(tenantId);
  if (nodes === null) {
    res.status(502).json({ error: "engine_unreachable" });
    return;
  }
  res.json({ count: nodes.length, waterNodes: nodes });
});

router.patch("/ops/water-nodes/:wpdxId", async (req, res): Promise<void> => {
  const { actorSub, tenantId } = actorFrom(req);
  const wpdxId = req.params.wpdxId as string;
  const before = (await fetchAdminWaterNodes(tenantId))?.find((n) => n.wpdxId === wpdxId) ?? null;

  const updated = await updateAdminWaterNode(wpdxId, req.body ?? {}, tenantId);
  if (updated === null) {
    res.status(502).json({ error: "engine_unreachable_or_not_found" });
    return;
  }
  void recordAudit({
    actorSub,
    tenantId,
    resource: "water_node",
    resourceId: wpdxId,
    action: "update",
    before,
    after: updated,
    reason: typeof req.body?.reason === "string" ? req.body.reason : null,
  });
  res.json({ waterNode: updated });
});

router.post("/ops/water-nodes/:wpdxId/verify", async (req, res): Promise<void> => {
  const { actorSub, tenantId } = actorFrom(req);
  const wpdxId = req.params.wpdxId as string;
  const updated = await verifyAdminWaterNode(wpdxId, tenantId);
  if (updated === null) {
    res.status(502).json({ error: "engine_unreachable_or_not_found" });
    return;
  }
  void recordAudit({
    actorSub,
    tenantId,
    resource: "water_node",
    resourceId: wpdxId,
    action: "verify",
    after: updated,
    reason: typeof req.body?.reason === "string" ? req.body.reason : null,
  });
  res.json({ waterNode: updated });
});

router.post("/ops/water-nodes/:wpdxId/unverify", async (req, res): Promise<void> => {
  const { actorSub, tenantId } = actorFrom(req);
  const wpdxId = req.params.wpdxId as string;
  const updated = await unverifyAdminWaterNode(wpdxId, tenantId);
  if (updated === null) {
    res.status(502).json({ error: "engine_unreachable_or_not_found" });
    return;
  }
  void recordAudit({
    actorSub,
    tenantId,
    resource: "water_node",
    resourceId: wpdxId,
    action: "verify",
    after: updated,
    reason: typeof req.body?.reason === "string" ? req.body.reason : "unverified",
  });
  res.json({ waterNode: updated });
});

router.delete("/ops/water-nodes/:wpdxId", async (req, res): Promise<void> => {
  const { actorSub, tenantId } = actorFrom(req);
  const wpdxId = req.params.wpdxId as string;
  const before = (await fetchAdminWaterNodes(tenantId))?.find((n) => n.wpdxId === wpdxId) ?? null;
  const updated = await deleteAdminWaterNode(wpdxId, tenantId);
  if (updated === null) {
    res.status(502).json({ error: "engine_unreachable_or_not_found" });
    return;
  }
  void recordAudit({
    actorSub,
    tenantId,
    resource: "water_node",
    resourceId: wpdxId,
    action: "delete",
    before,
    after: updated,
    reason: typeof req.body?.reason === "string" ? req.body.reason : null,
  });
  res.json({ waterNode: updated });
});

// ── Species ring radii (engine-owned, proxied) ──────────────────────────

router.get("/ops/species-ring-radii", async (req, res): Promise<void> => {
  const { tenantId } = actorFrom(req);
  const radii = await fetchAdminSpeciesRingRadii(tenantId);
  if (radii === null) {
    res.status(502).json({ error: "engine_unreachable" });
    return;
  }
  res.json({ count: radii.length, speciesRingRadii: radii });
});

router.patch(
  "/ops/species-ring-radii/:wardId/:speciesGroup",
  async (req, res): Promise<void> => {
    const { actorSub, tenantId } = actorFrom(req);
    const { wardId, speciesGroup } = req.params as { wardId: string; speciesGroup: string };
    const radiusKm = Number(req.body?.radiusKm);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
      res.status(400).json({ error: "invalid_radius_km" });
      return;
    }
    if (speciesGroup !== "cattle" && speciesGroup !== "shoat" && speciesGroup !== "camel") {
      res.status(400).json({ error: "invalid_species_group" });
      return;
    }
    const updated = await updateAdminSpeciesRingRadius(wardId, speciesGroup, radiusKm, tenantId);
    if (updated === null) {
      res.status(502).json({ error: "engine_unreachable" });
      return;
    }
    void recordAudit({
      actorSub,
      tenantId,
      resource: "species_ring_radii",
      resourceId: `${wardId}/${speciesGroup}`,
      action: "update",
      after: updated,
      reason: typeof req.body?.reason === "string" ? req.body.reason : null,
    });
    res.json({ speciesRingRadius: updated });
  },
);

// ── Ground-truth audit/correction (Supabase-owned, additive layer) ──────
// ground_truth_calls itself is never mutated — see migration 0009's
// header. These endpoints read it + a separate corrections table, and
// write only to the corrections table.

router.get("/ops/ground-truth/recent", async (req, res): Promise<void> => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const calls = await recentGroundTruthCalls(limit);
  if (calls === null) {
    res.json({ ready: false, reason: "supabase_not_configured", calls: [] });
    return;
  }
  const callIds = calls.map((c) => c.call_id);
  const corrections = (await correctionsForCallIds(callIds)) ?? [];
  const correctionsByCall = new Map<string, typeof corrections>();
  for (const c of corrections) {
    const existing = correctionsByCall.get(c.call_id) ?? [];
    existing.push(c);
    correctionsByCall.set(c.call_id, existing);
  }
  res.json({
    ready: true,
    count: calls.length,
    calls: calls.map((c) => ({
      ...c,
      corrections: correctionsByCall.get(c.call_id) ?? [],
    })),
  });
});

router.post("/ops/ground-truth/:callId/correct", async (req, res): Promise<void> => {
  const { actorSub, tenantId } = actorFrom(req);
  const callId = req.params.callId as string;
  const { field, correctedValue, originalValue, reason } = req.body ?? {};

  if (!CORRECTABLE_GROUND_TRUTH_FIELDS.includes(field)) {
    res.status(400).json({
      error: "invalid_field",
      validFields: CORRECTABLE_GROUND_TRUTH_FIELDS,
    });
    return;
  }
  if (typeof correctedValue !== "string" || !correctedValue.trim()) {
    res.status(400).json({ error: "missing_corrected_value" });
    return;
  }
  if (typeof reason !== "string" || !reason.trim()) {
    res.status(400).json({ error: "reason_required" });
    return;
  }

  const correction = await insertGroundTruthCorrection({
    call_id: callId,
    corrected_by: actorSub,
    field: field as CorrectableGroundTruthField,
    original_value: typeof originalValue === "string" ? originalValue : null,
    corrected_value: correctedValue,
    reason,
  });
  if (correction === null) {
    res.status(502).json({ error: "supabase_write_failed" });
    return;
  }
  void recordAudit({
    actorSub,
    tenantId,
    resource: "ground_truth_correction",
    resourceId: callId,
    action: "correct",
    before: { field, value: originalValue ?? null },
    after: { field, value: correctedValue },
    reason,
  });
  res.json({ correction });
});

export default router;
