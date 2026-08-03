"""Grazing advisory endpoint — species-specific piosphere rings.

A "ring" is just a circle (water point + radius) — there is no polygon or
geometry stored anywhere in this schema (no PostGIS is in use). Ring
membership is computed on read via haversine distance between the herder's
GPS and the nearest ``water_nodes`` row, compared against that ward's
``species_ring_radii`` for the herder's livestock species group.

One endpoint:

* ``GET /api/v1/grazing/advisory`` — nearest water point, distance, whether
  the herder's species can reach it, and the live VCI for that ring.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from ..db.client import db_client
from ..geo.wards import WARDS, haversine_km
from ..logging_config import get_logger
from ..pipeline.gee import GEEInitError, GEENotConfigured
from ..pipeline.satellite import fetch_vegetation_index_for_ring
from .tenancy_middleware import resolve_tenant_id

logger = get_logger("ardalink.api.grazing")

router = APIRouter(prefix="/api/v1/grazing", tags=["grazing"])

VALID_SPECIES_GROUPS = ("cattle", "shoat", "camel")

# Fallback radius (km) used only if a ward has no species_ring_radii row yet
# (e.g. a ward outside the 5 seeded pilot wards). Conservative middle value —
# not meant to be authoritative, just keeps the endpoint from 500ing.
_DEFAULT_RADIUS_KM = 8.0


class NearestWaterNode(BaseModel):
    name: str
    distance_km: float
    direction: str
    functional_status: str


class GrazingAdvisory(BaseModel):
    """Species-aware grazing advisory for a herder's current location."""

    nearest_water_node: NearestWaterNode | None
    species_group: str
    radius_km: float
    in_ring: bool
    vci: float | None
    ndvi_now: float | None
    data_sources: dict[str, str]


def _require_tenant(tenant_id: str | None) -> str:
    """Return a non-empty tenant id, or raise 400. Mirrors baseline.py's
    helper of the same name — RLS isn't in play here (water_nodes and
    species_ring_radii are shared reference data, not per-tenant), this is
    just for consistent attribution/logging across engine endpoints."""
    if not tenant_id:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "missing_tenant",
                "message": "Provide tenant_id via X-Tenant-ID header or query param.",
            },
        )
    return tenant_id


def _validate_species_group(species_group: str) -> str:
    if species_group not in VALID_SPECIES_GROUPS:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_species_group",
                "valid_species_groups": list(VALID_SPECIES_GROUPS),
                "got": species_group,
            },
        )
    return species_group


def _nearest_ward_id(lat: float, lon: float) -> str:
    """Nearest ward by centroid distance — used only to look up which
    ward's species_ring_radii config applies. Approximate by design (ward
    boundaries aren't polygons anywhere in this codebase either)."""
    from ..geo.wards import NAME_TO_WARDCODE

    nearest_name = min(
        WARDS, key=lambda name: haversine_km(lat, lon, WARDS[name].latitude, WARDS[name].longitude)
    )
    return NAME_TO_WARDCODE[nearest_name]


def _bearing_compass(from_lat: float, from_lon: float, to_lat: float, to_lon: float) -> str:
    """8-point compass direction from one point to another (e.g. "N", "SE").
    Distinct from geo.wards.reported_quadrant, which is relative to the
    fixed county centroid — this is relative to the herder's own position,
    which is what "nearest water: 2.1km N" actually needs."""
    import math

    d_lat = to_lat - from_lat
    d_lon = to_lon - from_lon
    angle = (math.degrees(math.atan2(d_lon, d_lat)) + 360) % 360
    directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    return directions[round(angle / 45) % 8]


def _radius_for(ward_id: str, species_group: str) -> float:
    row = db_client.fetch_one(
        f'''SELECT radius_km FROM "{db_client.schema}".species_ring_radii
            WHERE ward_id = %s AND species_group = %s''',
        (ward_id, species_group),
    )
    if row is None:
        logger.warning(
            "No species_ring_radii row for ward=%s species=%s — using default %.1fkm",
            ward_id, species_group, _DEFAULT_RADIUS_KM,
        )
        return _DEFAULT_RADIUS_KM
    return row["radius_km"]


@router.get("/advisory", response_model=GrazingAdvisory)
def get_grazing_advisory(
    request: Request,
    lat: float = Query(..., description="Herder's current latitude"),
    lon: float = Query(..., description="Herder's current longitude"),
    species_group: str = Query(..., description="One of: cattle, shoat, camel"),
    tenant_id: str | None = Query(
        None,
        description="Tenant id. Prefer the X-Tenant-ID header; this query param is a dev fallback.",
    ),
) -> GrazingAdvisory:
    """Return the nearest water point and a species-aware grazing advisory.

    HTTP 503 when GEE is not configured/unreachable. HTTP 200 with
    ``nearest_water_node: null`` when no water_nodes rows exist at all
    (empty-table-safe, matching baseline.py's own no-baseline-yet handling)
    — not an error, just "no water data imported for this area yet".
    """
    _require_tenant(resolve_tenant_id(request, tenant_id))
    _validate_species_group(species_group)

    # Only operator-verified, non-deleted points can ever be the answer —
    # this is what stops a fabricated seed row (or one an operator has
    # rejected) from anchoring a real herder-facing advisory. See the
    # admin console (admin_water.py) for how a point gets verified.
    nodes = db_client.fetch_all(
        f'''SELECT name, latitude, longitude, functional_status FROM "{db_client.schema}".water_nodes
            WHERE verified = true AND deleted_at IS NULL'''
    )
    if not nodes:
        return GrazingAdvisory(
            nearest_water_node=None,
            species_group=species_group,
            radius_km=_DEFAULT_RADIUS_KM,
            in_ring=False,
            vci=None,
            ndvi_now=None,
            data_sources={"water": "none_verified", "vegetation": "not_queried"},
        )

    nearest = min(nodes, key=lambda n: haversine_km(lat, lon, n["latitude"], n["longitude"]))
    distance_km = round(haversine_km(lat, lon, nearest["latitude"], nearest["longitude"]), 2)
    direction = _bearing_compass(lat, lon, nearest["latitude"], nearest["longitude"])

    ward_id = _nearest_ward_id(lat, lon)
    radius_km = _radius_for(ward_id, species_group)
    in_ring = distance_km <= radius_km

    try:
        vci_result = fetch_vegetation_index_for_ring(
            nearest["latitude"],
            nearest["longitude"],
            radius_km,
            cache_key=f"{nearest['name']}:{species_group}",
        )
        vci = vci_result["vci"]
        ndvi_now = vci_result["ndvi_now"]
        gee_status = "live"
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
            detail={"error": "gee_init_failed", "message": f"Earth Engine initialization failed: {exc}"},
        ) from exc

    return GrazingAdvisory(
        nearest_water_node=NearestWaterNode(
            name=nearest["name"],
            distance_km=distance_km,
            direction=direction,
            functional_status=nearest["functional_status"],
        ),
        species_group=species_group,
        radius_km=radius_km,
        in_ring=in_ring,
        vci=vci,
        ndvi_now=ndvi_now,
        data_sources={"water": "water_nodes", "vegetation": gee_status},
    )
