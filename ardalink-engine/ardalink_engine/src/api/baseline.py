"""Baseline grid endpoints — the replacement for Azure Cosmos DB.

The baseline is per-ward, per-month percentile envelopes (NDVI / NDRE /
Red-edge). Two granularities are exposed:

* ``/api/v1/baseline/aggregate``  — small (~240 rows: 10 wards × 12
  months × 6 metrics). Used by the operator dashboard.
* ``/api/v1/baseline/pixel``      — sparse per-pixel grid. Optional;
  falls back to the aggregate when missing.

Both endpoints return HTTP 200 with ``{"available": false, ...}``
when no row exists for the requested (tenant, ward, month). They do
NOT return 503: an empty baseline is a normal state, not a failure.
The API contract is "tell me what you have; if nothing, say so."

Source of truth: ``gis_engine.baseline_aggregate`` (and optionally
``gis_engine.baseline_pixel``). Populated by
``ardalink-engine/scripts/populate_baseline.py``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..db.client import db_client
from ..logging_config import get_logger

logger = get_logger("ardalink.api.baseline")

router = APIRouter(prefix="/api/v1/baseline", tags=["baseline"])

VALID_BANDS = ("ndvi", "ndre", "red_edge")
VALID_TENANTS = ("isiolo",)  # single tenant for now


class BaselineAggregateRow(BaseModel):
    tenant_id: str
    ward_id: str
    ward_name: str
    month: int
    ndvi_p50: float | None = None
    ndvi_p5: float | None = None
    ndre_p50: float | None = None
    ndre_p5: float | None = None
    red_edge_p50: float | None = None
    red_edge_p5: float | None = None
    source: str
    window_label: str | None = None
    pixel_count: int | None = None
    computed_at: str


class BaselineAggregateResponse(BaseModel):
    available: bool
    tenant_id: str
    ward_id: str
    month: int
    row: BaselineAggregateRow | None = None


class BaselinePixelCell(BaseModel):
    row_idx: int
    col_idx: int
    value: float


class BaselinePixelResponse(BaseModel):
    available: bool
    tenant_id: str
    ward_id: str
    month: int
    band: str
    pixel_count: int
    cells: list[BaselinePixelCell]


def _validate_tenant(tenant_id: str) -> str:
    if tenant_id not in VALID_TENANTS:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_tenant",
                "valid_tenants": list(VALID_TENANTS),
            },
        )
    return tenant_id


def _validate_month(month: int) -> int:
    if month < 1 or month > 12:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_month",
                "message": "month must be 1..12 (inclusive)",
                "got": month,
            },
        )
    return month


def _validate_band(band: str) -> str:
    if band not in VALID_BANDS:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_band",
                "valid_bands": list(VALID_BANDS),
                "got": band,
            },
        )
    return band


def _resolve_ward_id(ward_id: str) -> str:
    """Accept either an IEBC wardcode (e.g. '242') or a ward name (e.g. 'Bulla Pesa').
    Returns the IEBC wardcode. Falls back to the input if no match.
    """
    # Try as wardcode first (exact match in WARDS keys are NAMES, not codes).
    # So we actually need to map name → wardcode, but we don't store wardcode
    # in WARDS. For now, accept the input as-is and let the SQL no-op handle
    # misses. Callers that want name resolution should pass ward_id directly.
    return ward_id


@router.get("/aggregate", response_model=BaselineAggregateResponse)
def get_baseline_aggregate(
    tenant_id: str = Query("isiolo", description="Tenant id (only 'isiolo' supported today)"),
    ward_id: str | None = Query(None, description="Ward id (IEBC wardcode). Optional if ward_name is given."),
    ward_name: str | None = Query(None, description="Ward display name (e.g. 'Bulla Pesa'); resolves to wardcode"),
    month: int = Query(..., description="Calendar month 1..12"),
) -> BaselineAggregateResponse:
    """Return the per-ward, per-month aggregate baseline.

    HTTP 200 with ``{"available": false, ...}`` when no row exists.
    HTTP 4xx only for malformed input (bad tenant / month / no ward identifier).
    """
    _validate_tenant(tenant_id)
    _validate_month(month)

    if not ward_id and not ward_name:
        raise HTTPException(
            status_code=400,
            detail={"error": "missing_ward", "message": "Provide ward_id OR ward_name"},
        )

    resolved_ward_id = ward_id or ""
    if ward_name:
        from ..geo.wards import NAME_TO_WARDCODE
        resolved_ward_id = NAME_TO_WARDCODE.get(ward_name, ward_id or "")

    with db_client.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT tenant_id, ward_id, ward_name, month,
                   ndvi_p50, ndvi_p5,
                   ndre_p50, ndre_p5,
                   red_edge_p50, red_edge_p5,
                   source, window_label, pixel_count, computed_at
              FROM "{db_client.schema}".baseline_aggregate
             WHERE tenant_id = %s AND ward_id = %s AND month = %s
            """,
            (tenant_id, resolved_ward_id, month),
        )
        row = cur.fetchone()

    if row is None:
        return BaselineAggregateResponse(
            available=False,
            tenant_id=tenant_id,
            ward_id=resolved_ward_id,
            month=month,
            row=None,
        )

    return BaselineAggregateResponse(
        available=True,
        tenant_id=row[0],
        ward_id=row[1],
        month=row[3],
        row=BaselineAggregateRow(
            tenant_id=row[0],
            ward_id=row[1],
            ward_name=row[2],
            month=row[3],
            ndvi_p50=row[4],
            ndvi_p5=row[5],
            ndre_p50=row[6],
            ndre_p5=row[7],
            red_edge_p50=row[8],
            red_edge_p5=row[9],
            source=row[10],
            window_label=row[11],
            pixel_count=row[12],
            computed_at=row[13].isoformat() if row[13] else "",
        ),
    )


@router.get("/pixel", response_model=BaselinePixelResponse)
def get_baseline_pixel(
    tenant_id: str = Query("isiolo"),
    ward_id: str | None = Query(None, description="Ward id (IEBC wardcode). Optional if ward_name is given."),
    ward_name: str | None = Query(None, description="Ward display name; resolves to wardcode"),
    month: int = Query(..., description="Calendar month 1..12"),
    band: str = Query("ndvi", description="One of: ndvi, ndre, red_edge"),
) -> BaselinePixelResponse:
    """Return the per-pixel, per-band baseline grid for one (ward, month).

    Sparse representation: only cells that have a stored value appear in
    the response. Empty grid returns ``available=false``.
    """
    _validate_tenant(tenant_id)
    _validate_month(month)
    band = _validate_band(band)

    if not ward_id and not ward_name:
        raise HTTPException(
            status_code=400,
            detail={"error": "missing_ward", "message": "Provide ward_id OR ward_name"},
        )

    resolved_ward_id = ward_id or ""
    if ward_name:
        from ..geo.wards import NAME_TO_WARDCODE
        resolved_ward_id = NAME_TO_WARDCODE.get(ward_name, ward_id or "")

    with db_client.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT row_idx, col_idx, value
              FROM "{db_client.schema}".baseline_pixel
             WHERE tenant_id = %s AND ward_id = %s AND month = %s AND band = %s
             ORDER BY row_idx, col_idx
            """,
            (tenant_id, resolved_ward_id, month, band),
        )
        cells = cur.fetchall()

    if not cells:
        return BaselinePixelResponse(
            available=False,
            tenant_id=tenant_id,
            ward_id=resolved_ward_id,
            month=month,
            band=band,
            pixel_count=0,
            cells=[],
        )

    return BaselinePixelResponse(
        available=True,
        tenant_id=tenant_id,
        ward_id=resolved_ward_id,
        month=month,
        band=band,
        pixel_count=len(cells),
        cells=[BaselinePixelCell(row_idx=r, col_idx=c, value=v) for r, c, v in cells],
    )
