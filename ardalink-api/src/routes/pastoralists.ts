import { Router, type IRouter, type Request } from "express";
import { eq } from "drizzle-orm";
import { db, pastoralistsTable } from "@workspace/db";
import {
  CreatePastoralistBody,
  DeletePastoralistParams,
} from "@workspace/api-zod";
import { withTenantContext } from "../lib/tenancy-context.js";

function requireTenant(req: Request): string {
  const tenantId = req.tenant?.tenant_id;
  if (!tenantId) {
    throw new Error("tenant_id missing from request context");
  }
  return tenantId;
}

const router: IRouter = Router();

/**
 * GET /api/pastoralists
 * List all registered pastoralists in the caller's tenant.
 * RLS is enforced via withTenantContext so only the caller's rows are visible.
 */
router.get("/pastoralists", async (req, res): Promise<void> => {
  try {
    const tenantId = requireTenant(req);
    const rows = await withTenantContext(tenantId, (tx) =>
      tx
        .select()
        .from(pastoralistsTable)
        .orderBy(pastoralistsTable.createdAt),
    );
    res.json(rows);
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to list pastoralists");
    res.status(500).json({ error: "Failed to list pastoralists" });
  }
});

/**
 * POST /api/pastoralists
 * Register a new pastoralist herder. tenant_id is bound from the JWT
 * claim, never the request body, so a caller can never insert into a
 * different tenant's data.
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

  const {
    name,
    phone,
    location = "",
    cattle = 0,
    goats = 0,
    camels = 0,
    waterSource = "Unknown",
    alertsEnabled = true,
  } = parsed.data;

  try {
    const [row] = await withTenantContext(tenantId, (tx) =>
      tx
        .insert(pastoralistsTable)
        .values({
          tenantId,
          name,
          phone,
          location,
          cattle,
          goats,
          camels,
          waterSource,
          alertsEnabled,
        })
        .returning(),
    );

    req.log.info(
      { id: row!.id, name: row!.name, phone: row!.phone, tenantId },
      "Pastoralist registered",
    );
    res.status(201).json(row);
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to register pastoralist");
    res.status(500).json({ error: "Failed to register pastoralist" });
  }
});

/**
 * DELETE /api/pastoralists/:id
 * Remove a pastoralist from the registry. Scoped to the caller's tenant
 * via RLS — a caller cannot delete rows belonging to other tenants.
 */
router.delete("/pastoralists/:id", async (req, res): Promise<void> => {
  const parsed = DeletePastoralistParams.safeParse({
    id: Number(req.params.id),
  });
  if (!parsed.success) {
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

  try {
    const deleted = await withTenantContext(tenantId, (tx) =>
      tx
        .delete(pastoralistsTable)
        .where(eq(pastoralistsTable.id, parsed.data.id))
        .returning(),
    );

    if (deleted.length === 0) {
      res.status(404).json({ error: "Pastoralist not found" });
      return;
    }

    req.log.info(
      { id: parsed.data.id, tenantId },
      "Pastoralist removed",
    );
    res.json({ status: "deleted" });
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to delete pastoralist");
    res.status(500).json({ error: "Failed to delete pastoralist" });
  }
});

export default router;