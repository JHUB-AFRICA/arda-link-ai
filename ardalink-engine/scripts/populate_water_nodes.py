#!/usr/bin/env python3
"""Populate `gis_engine.water_nodes` with real water-point data for the
5 active pilot wards, from two sources:

* **WPDx** (Water Point Data Exchange) — live SODA API pull, same endpoint
  and field set as `ardalink-api/scripts/pull-wpdx.mjs` (which refreshes
  the API's own static snapshot). Note: Isiolo's WPDx coverage is all
  2012-vintage surveys (confirmed via a live pull, not just the stale local
  snapshot) — a fresh pull returns the same rows, the *source* hasn't been
  resurveyed, not just the local copy. This is a real data-quality gap the
  ring feature inherits, not a bug in this script.
* **OpenStreetMap** point-source water (`natural=water`, `man_made=water_well`,
  `amenity=watering_place`) via `src.pipeline.water_sources` — genuinely
  live/current, fills gaps WPDx's 2012 survey doesn't cover.

Explicitly out of scope: `waterway=river/stream` (open LineString ways,
needs new geometry-handling code — see `water_sources.py`'s own docstring).

Idempotent: re-running upserts on `wpdx_id` (`ON CONFLICT ... DO UPDATE`).
WPDx rows keep their real `wpdx_id`; OSM rows get a synthesized
`OSM-{osm_id}` id so they never collide with real WPDx ids.

Usage:

    python -m scripts.populate_water_nodes                # both sources, all 5 wards
    python -m scripts.populate_water_nodes --wpdx-only
    python -m scripts.populate_water_nodes --osm-only
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

logger = logging.getLogger("ardalink.scripts.populate_water_nodes")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")

WPDX_ENDPOINT = "https://data.waterpointdata.org/resource/eqje-vguj.json"
WPDX_COUNTY = "Isiolo"
WPDX_TIMEOUT_SECONDS = 30

# Ported from ardalink-api/src/lib/wpdx.ts's FUNCTIONAL_LABELS/NON_FUNCTIONAL_LABELS —
# keep these two in sync if either changes; don't let the classification
# drift between the Node and Python sides of this system.
FUNCTIONAL_LABELS = {
    "Functional",
    "Functional but needs repair",
    "Functional but not in use",
}
NON_FUNCTIONAL_LABELS = {
    "Non-Functional",
    "Non functional due to dry season",
    "Non-Functional due to dry season",
}


def _status_for(status_clean: str | None) -> str:
    """WPDx status_clean -> this table's functional_status vocabulary."""
    if not status_clean:
        return "unknown"
    if status_clean in FUNCTIONAL_LABELS:
        return "functional"
    if status_clean in NON_FUNCTIONAL_LABELS:
        return "non-functional"
    return "unknown"


def fetch_wpdx_rows() -> list[tuple]:
    """Live WPDx pull scoped to Isiolo county. Returns water_nodes-shaped
    tuples: (wpdx_id, name, lat, lon, water_source_type, functional_status,
    last_verified_date, queue_time_index, source)."""
    params = {
        "clean_adm1": WPDX_COUNTY,
        "$limit": "500",
        "$select": ",".join([
            "wpdx_id", "clean_adm3", "lat_deg", "lon_deg",
            "water_source_clean", "status_clean", "report_date",
        ]),
    }
    resp = requests.get(WPDX_ENDPOINT, params=params, timeout=WPDX_TIMEOUT_SECONDS)
    resp.raise_for_status()
    raw_rows = resp.json()
    logger.info("WPDx: %d rows returned for %s county", len(raw_rows), WPDX_COUNTY)

    rows: list[tuple] = []
    for r in raw_rows:
        wpdx_id = r.get("wpdx_id")
        lat, lon = r.get("lat_deg"), r.get("lon_deg")
        if not wpdx_id or lat is None or lon is None:
            continue
        ward = r.get("clean_adm3") or "Isiolo"
        source_type = r.get("water_source_clean") or "unknown"
        name = f"{ward} {source_type}".strip()
        last_verified = r.get("report_date", "").split("T")[0] or None
        rows.append((
            wpdx_id, name, float(lat), float(lon), source_type,
            _status_for(r.get("status_clean")), last_verified, 3, "wpdx",
        ))
    return rows


def fetch_osm_rows() -> list[tuple]:
    """OSM point-source water via src.pipeline.water_sources. Same tuple
    shape as fetch_wpdx_rows(); functional_status is always 'unknown'
    (OSM tags don't carry a functional/non-functional signal)."""
    from ardalink_engine.src.pipeline.water_sources import fetch_water_source_points

    points = fetch_water_source_points(force=True)
    rows: list[tuple] = []
    for p in points:
        rows.append((
            f"OSM-{p['osm_id']}", p["name"], p["latitude"], p["longitude"],
            p["water_source_type"], "unknown", None, 3, "osm",
        ))
    return rows


def upsert_water_nodes(dsn: str, schema: str, rows: list[tuple]) -> int:
    if not rows:
        return 0
    conn = psycopg2.connect(dsn, options=f"-c search_path={schema}")
    try:
        with conn, conn.cursor() as cur:
            psycopg2.extras.execute_batch(
                cur,
                f'''INSERT INTO "{schema}".water_nodes
                    (wpdx_id, name, latitude, longitude, water_source_type,
                     functional_status, last_verified_date, queue_time_index, source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (wpdx_id) DO UPDATE SET
                        name = EXCLUDED.name,
                        latitude = EXCLUDED.latitude,
                        longitude = EXCLUDED.longitude,
                        water_source_type = EXCLUDED.water_source_type,
                        functional_status = EXCLUDED.functional_status,
                        last_verified_date = EXCLUDED.last_verified_date,
                        source = EXCLUDED.source''',
                rows,
            )
        return len(rows)
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wpdx-only", action="store_true")
    parser.add_argument("--osm-only", action="store_true")
    args = parser.parse_args()

    from ardalink_engine.src.config import settings

    dsn = settings.DATABASE_URL
    schema = settings.DB_SCHEMA
    if not dsn:
        logger.error("DATABASE_URL is not configured")
        sys.exit(1)

    total = 0
    if not args.osm_only:
        try:
            wpdx_rows = fetch_wpdx_rows()
            total += upsert_water_nodes(dsn, schema, wpdx_rows)
            logger.info("Upserted %d WPDx rows", len(wpdx_rows))
        except Exception:
            logger.exception("WPDx import failed")

    if not args.wpdx_only:
        try:
            osm_rows = fetch_osm_rows()
            total += upsert_water_nodes(dsn, schema, osm_rows)
            logger.info("Upserted %d OSM rows", len(osm_rows))
        except Exception:
            logger.exception("OSM import failed")

    logger.info("Done. %d total rows upserted into water_nodes.", total)


if __name__ == "__main__":
    main()
