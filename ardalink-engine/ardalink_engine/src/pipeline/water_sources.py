"""Point-source water locations mapped in OpenStreetMap (pans, wells, ponds).

Sibling to :mod:`src.pipeline.obstacles`, same Overpass/cache pattern, but a
different query and much simpler parsing: these are all OSM **node** elements
(single lat/lon), not ways/relations needing polygon reconstruction.

Deliberately out of scope: ``waterway=river``/``waterway=stream``. Those are
open LineString ways — real support needs new geometry-handling code (a
single "point" doesn't describe a river), and isn't needed for the piosphere
pilot, which only needs point water sources with a clear water_nodes-style
lat/lon. Point tags (``natural=water``, ``man_made=water_well``,
``amenity=watering_place``) cover pans, wells, and boreholes, which is what
the pilot actually needs.
"""

from __future__ import annotations

import time

import requests

from ..config import settings
from ..logging_config import get_logger

logger = get_logger("ardalink.pipeline.water_sources")

_CACHE: dict[str, object] = {"ts": 0.0, "data": None}


def _build_query() -> str:
    s, w, n, e = settings.ISIOLO_BBOX
    return f"""
[out:json][timeout:{int(settings.OVERPASS_TIMEOUT_SECONDS)}];
(
  node["natural"="water"]({s},{w},{n},{e});
  node["man_made"="water_well"]({s},{w},{n},{e});
  node["amenity"="watering_place"]({s},{w},{n},{e});
);
out;
"""


def _parse(elements: list[dict]) -> list[dict]:
    points: list[dict] = []
    for el in elements:
        if el.get("type") != "node" or "lat" not in el or "lon" not in el:
            continue
        tags = el.get("tags", {})
        water_source_type = (
            "water_well" if tags.get("man_made") == "water_well"
            else "watering_place" if tags.get("amenity") == "watering_place"
            else "natural_water"
        )
        points.append({
            "osm_id": el["id"],
            "name": tags.get("name") or f"OSM {water_source_type} {el['id']}",
            "latitude": el["lat"],
            "longitude": el["lon"],
            "water_source_type": water_source_type,
        })
    return points


def fetch_water_source_points(force: bool = False) -> list[dict]:
    """Fetch OSM point-source water locations, using the in-memory cache
    when fresh. Raises on network/HTTP errors — callers should catch and
    degrade (this is an import-time script, not a request-path call, so
    failing loud is preferable to silently importing nothing)."""
    now = time.time()
    cached = _CACHE["data"]
    if (
        not force
        and cached is not None
        and (now - float(_CACHE["ts"])) < settings.OBSTACLE_CACHE_TTL_SECONDS
    ):
        return cached  # type: ignore[return-value]

    query = _build_query()
    resp = requests.post(
        settings.OVERPASS_URL,
        data={"data": query},
        headers={
            "User-Agent": "ArdaLink-Biophysical-Engine/1.0 (Isiolo water-source import)",
            "Accept": "application/json",
        },
        timeout=settings.OVERPASS_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    elements = resp.json().get("elements", [])
    points = _parse(elements)
    _CACHE["data"] = points
    _CACHE["ts"] = now
    logger.info("Fetched %d OSM point-source water locations", len(points))
    return points
