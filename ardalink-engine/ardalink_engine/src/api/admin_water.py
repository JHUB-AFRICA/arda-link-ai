"""Operator data-management console — engine-owned tables.

Water nodes and species-ring-radii are only ever edited through the
operator console. This router is engine-internal: only ardalink-api's
`/api/ops/water-nodes/*` and `/api/ops/species-ring-radii/*` proxy routes
call it (same tenant-attestation trust relationship as `baseline.py`/
`grazing.py` — the dashboard never talks to this service directly).

Audit trail lives on the ardalink-api side (`src/lib/adminAudit.ts`) — the
proxy routes call `recordAudit()` around each of these calls. This router
itself does not write audit rows; it only performs the actual mutation.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..db.client import db_client
from ..logging_config import get_logger
from .grazing import VALID_SPECIES_GROUPS
from .tenancy_middleware import resolve_tenant_id

logger = get_logger("ardalink.api.admin_water")

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def _require_tenant(tenant_id: str | None) -> str:
    """Return a non-empty tenant id, or raise 400. Same small per-router
    helper as baseline.py/grazing.py — not shared cross-module by design,
    matching this codebase's existing convention."""
    if not tenant_id:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "missing_tenant",
                "message": "Provide tenant_id via X-Tenant-ID header or query param.",
            },
        )
    return tenant_id


class WaterNodeUpdate(BaseModel):
    name: str | None = None
    water_source_type: str | None = None
    functional_status: str | None = None
    latitude: float | None = None
    longitude: float | None = None


class WaterNodeRow(BaseModel):
    wpdx_id: str
    name: str
    latitude: float
    longitude: float
    water_source_type: str
    functional_status: str
    source: str | None
    verified: bool
    deleted_at: str | None


def _fetch_water_node(wpdx_id: str) -> dict:
    row = db_client.fetch_one(
        f'SELECT * FROM "{db_client.schema}".water_nodes WHERE wpdx_id = %s',
        (wpdx_id,),
    )
    if row is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "water_node_not_found", "wpdx_id": wpdx_id},
        )
    return row


def _to_water_node_row(row: dict) -> WaterNodeRow:
    """psycopg2 returns a native datetime for deleted_at (or None) — this
    file's response model uses `str | None` (matching this codebase's
    established convention of manually isoformat()-ing timestamps, e.g.
    satellite.py's captured_at, rather than relying on pydantic to coerce
    a datetime into a str field, which it won't do automatically)."""
    deleted_at = row.get("deleted_at")
    return WaterNodeRow(
        wpdx_id=row["wpdx_id"],
        name=row["name"],
        latitude=row["latitude"],
        longitude=row["longitude"],
        water_source_type=row["water_source_type"],
        functional_status=row["functional_status"],
        source=row.get("source"),
        verified=row["verified"],
        deleted_at=deleted_at.isoformat() if deleted_at else None,
    )


@router.get("/water-nodes", response_model=list[WaterNodeRow])
def list_water_nodes(request: Request, tenant_id: str | None = None) -> list[WaterNodeRow]:
    """List every water node (including unverified/deleted) — the console
    needs to see everything, not just what advisories are allowed to use."""
    _require_tenant(resolve_tenant_id(request, tenant_id))
    rows = db_client.fetch_all(f'SELECT * FROM "{db_client.schema}".water_nodes ORDER BY name')
    return [_to_water_node_row(r) for r in rows]


@router.patch("/water-nodes/{wpdx_id}", response_model=WaterNodeRow)
def update_water_node(
    wpdx_id: str, body: WaterNodeUpdate, request: Request, tenant_id: str | None = None,
) -> WaterNodeRow:
    _require_tenant(resolve_tenant_id(request, tenant_id))
    _fetch_water_node(wpdx_id)  # 404s if missing

    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail={"error": "no_fields_to_update"})

    set_clause = ", ".join(f"{col} = %s" for col in updates)
    params = (*updates.values(), wpdx_id)
    db_client.execute(
        f'UPDATE "{db_client.schema}".water_nodes SET {set_clause} WHERE wpdx_id = %s',
        params,
    )
    logger.info("Water node %s updated: %s", wpdx_id, list(updates.keys()))
    return _to_water_node_row(_fetch_water_node(wpdx_id))


@router.post("/water-nodes/{wpdx_id}/verify", response_model=WaterNodeRow)
def verify_water_node(wpdx_id: str, request: Request, tenant_id: str | None = None) -> WaterNodeRow:
    """Mark a water node verified — only verified, non-deleted nodes can
    ever be returned by /api/v1/grazing/advisory (see grazing.py)."""
    _require_tenant(resolve_tenant_id(request, tenant_id))
    _fetch_water_node(wpdx_id)
    db_client.execute(
        f'UPDATE "{db_client.schema}".water_nodes SET verified = true WHERE wpdx_id = %s',
        (wpdx_id,),
    )
    logger.info("Water node %s marked verified", wpdx_id)
    return _to_water_node_row(_fetch_water_node(wpdx_id))


@router.post("/water-nodes/{wpdx_id}/unverify", response_model=WaterNodeRow)
def unverify_water_node(wpdx_id: str, request: Request, tenant_id: str | None = None) -> WaterNodeRow:
    """Reverse of verify — an operator who made a mistake, or new
    information surfaces a point isn't actually real/reliable."""
    _require_tenant(resolve_tenant_id(request, tenant_id))
    _fetch_water_node(wpdx_id)
    db_client.execute(
        f'UPDATE "{db_client.schema}".water_nodes SET verified = false WHERE wpdx_id = %s',
        (wpdx_id,),
    )
    logger.info("Water node %s marked unverified", wpdx_id)
    return _to_water_node_row(_fetch_water_node(wpdx_id))


@router.delete("/water-nodes/{wpdx_id}", response_model=WaterNodeRow)
def delete_water_node(wpdx_id: str, request: Request, tenant_id: str | None = None) -> WaterNodeRow:
    """Soft delete (deleted_at=now()) — never a hard DELETE, so the audit
    trail (and this row itself, for un-delete) survives."""
    _require_tenant(resolve_tenant_id(request, tenant_id))
    _fetch_water_node(wpdx_id)
    db_client.execute(
        f'UPDATE "{db_client.schema}".water_nodes SET deleted_at = now() WHERE wpdx_id = %s',
        (wpdx_id,),
    )
    logger.info("Water node %s soft-deleted", wpdx_id)
    return _to_water_node_row(_fetch_water_node(wpdx_id))


class SpeciesRingRadiusUpdate(BaseModel):
    radius_km: float


class SpeciesRingRadiusRow(BaseModel):
    ward_id: str
    species_group: str
    radius_km: float
    source: str
    updated_at: str


def _to_species_ring_radius_row(row: dict) -> SpeciesRingRadiusRow:
    return SpeciesRingRadiusRow(
        ward_id=row["ward_id"],
        species_group=row["species_group"],
        radius_km=row["radius_km"],
        source=row["source"],
        updated_at=row["updated_at"].isoformat(),
    )


@router.get("/species-ring-radii", response_model=list[SpeciesRingRadiusRow])
def list_species_ring_radii(request: Request, tenant_id: str | None = None) -> list[SpeciesRingRadiusRow]:
    """List every (ward, species) radius row — lets the console show
    current values instead of being a blind write-only tuning form."""
    _require_tenant(resolve_tenant_id(request, tenant_id))
    rows = db_client.fetch_all(
        f'SELECT * FROM "{db_client.schema}".species_ring_radii ORDER BY ward_id, species_group'
    )
    return [_to_species_ring_radius_row(r) for r in rows]


@router.patch("/species-ring-radii/{ward_id}/{species_group}", response_model=SpeciesRingRadiusRow)
def update_species_ring_radius(
    ward_id: str, species_group: str, body: SpeciesRingRadiusUpdate,
    request: Request, tenant_id: str | None = None,
) -> SpeciesRingRadiusRow:
    _require_tenant(resolve_tenant_id(request, tenant_id))
    if species_group not in VALID_SPECIES_GROUPS:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_species_group", "valid_species_groups": list(VALID_SPECIES_GROUPS)},
        )
    db_client.execute(
        f'''INSERT INTO "{db_client.schema}".species_ring_radii (ward_id, species_group, radius_km, source)
            VALUES (%s, %s, %s, 'operator_tuned')
            ON CONFLICT (ward_id, species_group) DO UPDATE SET
                radius_km = EXCLUDED.radius_km, source = 'operator_tuned', updated_at = now()''',
        (ward_id, species_group, body.radius_km),
    )
    row = db_client.fetch_one(
        f'''SELECT * FROM "{db_client.schema}".species_ring_radii
            WHERE ward_id = %s AND species_group = %s''',
        (ward_id, species_group),
    )
    logger.info("species_ring_radii %s/%s set to %.1fkm by operator", ward_id, species_group, body.radius_km)
    return _to_species_ring_radius_row(row)
