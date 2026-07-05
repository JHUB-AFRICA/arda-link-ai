"""Satellite endpoints — live GEE VCI and MODIS NDVI data.

Wraps the existing GEE pipeline in :mod:`src.pipeline.satellite` and exposes
HTTP endpoints for the API to consume.

Two endpoints:

* ``GET /api/v1/satellite/vci``  — live Vegetation Condition Index for one ward
* ``POST /api/v1/satellite/trigger`` — fetch VCI for all demo wards

Both endpoints call into ``src.pipeline.satellite.fetch_vegetation_index``,
which handles GEE initialization, MODIS NDVI aggregation, urban masking,
and the Prosopis juliflora penalty.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..geo.wards import WARDS
from ..logging_config import get_logger
from ..pipeline.gee import GEEInitError, GEENotConfigured

logger = get_logger("ardalink.api.satellite")

router = APIRouter(prefix="/api/v1/satellite", tags=["satellite"])

# Demo wards that are actively supported (slugs that map to WARDS keys)
DEMO_WARDS = ["bula-pesa", "garbatulla", "kinna"]


class VCISnapshot(BaseModel):
    """Live Vegetation Condition Index for a single ward."""

    ward_id: str
    ward_name: str
    vci: float
    ndvi_now: float | None
    ndvi_min: float | None
    ndvi_max: float | None
    urban_masked: bool
    prosopis_factor: float
    image_dates: list[str] | None
    captured_at: str


class TriggerResponse(BaseModel):
    """Response from POST /api/v1/satellite/trigger."""

    status: str
    wards: list[str]
    started_at: str
    results: dict[str, dict] | None
    error: str | None


def _resolve_ward(ward_id: str) -> str:
    """Resolve a ward ID to a normalized ward name.

    Accepts either a slug (e.g. 'bula-pesa') or a display name
    (e.g. 'Bulla Pesa'). Returns the canonical name used in WARDS keys.
    """
    # Direct match
    if ward_id in WARDS:
        return ward_id

    # Try case-insensitive match
    lower = ward_id.lower()
    for key in WARDS:
        if key.lower() == lower:
            return key

    # Try slug-to-display-name conversion (hyphens to spaces, title case)
    if "-" in ward_id:
        converted = ward_id.replace("-", " ").title()
        if converted in WARDS:
            return converted
        # Try case-insensitive after conversion
        for key in WARDS:
            if key.lower() == converted.lower():
                return key

    raise HTTPException(
        status_code=404,
        detail={"error": "unknown_ward", "ward_id": ward_id, "known_wards": list(WARDS.keys())},
    )


@router.get("/vci", response_model=VCISnapshot)
def get_vci(
    ward_id: str = Query(..., description="Ward slug (e.g. 'bula-pesa') or display name"),
) -> VCISnapshot:
    """Return the live Vegetation Condition Index for a single ward.

    Calls ``src.pipeline.satellite.fetch_vegetation_index``, which:
    * Initializes GEE (lazy, thread-safe)
    * Fetches MODIS MOD13Q1 NDVI for the ward
    * Computes VCI = 100 * (NDVI_now - NDVI_min) / (NDVI_max - NDVI_min)
    * Applies urban mask (ESA WorldCover built-up pixels)
    * Applies Prosopis juliflora penalty (0.85 factor)

    Returns HTTP 503 when GEE is not configured.
    """
    try:
        resolved_ward = _resolve_ward(ward_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid_ward", "message": str(exc)}) from exc

    try:
        from ..pipeline.satellite import fetch_vegetation_index

        result = fetch_vegetation_index(resolved_ward)
        ward = WARDS[resolved_ward]

        return VCISnapshot(
            ward_id=resolved_ward,
            ward_name=ward.display_name if hasattr(ward, "display_name") else resolved_ward,
            vci=result["vci"],
            ndvi_now=result["ndvi_now"],
            ndvi_min=result["ndvi_min"],
            ndvi_max=result["ndvi_max"],
            urban_masked=result["urban_masked"],
            prosopis_factor=result["prosopis_factor"],
            image_dates=None,  # GEE doesn't return image dates in the current implementation
            captured_at=datetime.now(UTC).isoformat(),
        )
    except GEENotConfigured as exc:
        logger.error("GEE not configured: %s", exc)
        raise HTTPException(
            status_code=503,
            detail={
                "error": "gee_not_configured",
                "message": "Google Earth Engine credentials are not configured. Set GEE_PRIVATE_KEY and GEE_SERVICE_ACCOUNT.",
            },
        ) from exc
    except GEEInitError as exc:
        logger.error("GEE initialization failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail={
                "error": "gee_init_failed",
                "message": f"Earth Engine initialization failed: {exc}",
            },
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error fetching VCI for ward '%s'", ward_id)
        raise HTTPException(
            status_code=500,
            detail={"error": "internal_error", "message": f"Failed to fetch VCI: {exc}"},
        ) from exc


@router.post("/trigger", response_model=TriggerResponse)
def trigger_all_wards(
    dry_run: bool = Query(False, description="If true, skip actual GEE calls"),
) -> TriggerResponse:
    """Fetch VCI for all demo wards (Bula Pesa, Garbatulla, Kinna).

    Calls ``fetch_vegetation_index`` for each ward in parallel and returns
    the combined results. Use this for scheduled refreshes or manual
    triggering from the operator dashboard.

    Set ``dry_run=true`` to validate the endpoint without making GEE calls.
    """
    started_at = datetime.now(UTC).isoformat()

    if dry_run:
        return TriggerResponse(
            status="dry_run",
            wards=DEMO_WARDS,
            started_at=started_at,
            results=None,
            error=None,
        )

    try:
        from ..pipeline.satellite import fetch_vegetation_index

        results: dict[str, dict] = {}
        errors: dict[str, str] = {}

        for ward_slug in DEMO_WARDS:
            try:
                # Resolve slug to canonical ward name before calling fetch_vegetation_index
                ward_name = _resolve_ward(ward_slug)
                result = fetch_vegetation_index(ward_name)
                results[ward_slug] = result
                logger.info("VCI fetch succeeded for %s: %.1f", ward_slug, result["vci"])
            except HTTPException:
                # Re-raise HTTPExceptions (including unknown_ward) as-is
                raise
            except GEENotConfigured:
                errors[ward_slug] = "GEE not configured"
                raise  # Re-raise so caller sees 503
            except GEEInitError as exc:
                errors[ward_slug] = f"GEE init failed: {exc}"
                raise  # Re-raise so caller sees 503
            except Exception as exc:
                errors[ward_slug] = str(exc)
                logger.warning("VCI fetch failed for %s: %s", ward_slug, exc)

        if not results:
            return TriggerResponse(
                status="failed",
                wards=DEMO_WARDS,
                started_at=started_at,
                results=None,
                error="All wards failed: " + ", ".join(f"{k}={v}" for k, v in errors.items()),
            )

        return TriggerResponse(
            status="success",
            wards=list(results.keys()),
            started_at=started_at,
            results=results,
            error=None if len(results) == len(DEMO_WARDS) else f"Partial failures: {errors}",
        )

    except GEENotConfigured as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "gee_not_configured",
                "message": "Google Earth Engine credentials are not configured.",
            },
        ) from exc
    except GEEInitError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "gee_init_failed",
                "message": f"Earth Engine initialization failed: {exc}",
            },
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error in trigger_all_wards")
        raise HTTPException(
            status_code=500,
            detail={"error": "internal_error", "message": f"Trigger failed: {exc}"},
        ) from exc
