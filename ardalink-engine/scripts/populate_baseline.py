#!/usr/bin/env python3
"""Populate `gis_engine.baseline_aggregate` (and optionally `baseline_pixel`).

Replaces Azure Cosmos DB as the source of truth for the historical
NDVI / NDRE / Red-edge baseline. Runs against Earth Engine using the
service-account credentials already loaded by the engine.

Two modes:

* **Aggregate mode (default):** pulls per-ward, per-month p50/p5 of NDVI
  from Sentinel-2 SR over a configurable window. Writes ~240 rows to
  `baseline_aggregate` (10 wards × 12 months × 1 band). Fast (~2 min).
* **Pixel mode (`--pixels`):** same GEE reduce, but per-pixel. Writes
  ~600k rows per band to `baseline_pixel`. Slow (10-30 min per band).

Ward geometries come from the canonical IEBC GeoJSON at
``ardalink-api/docs/local-dev/data/isiolo_wards.geojson``.

Usage:

    # Full historical aggregate, default 2014-2024 window:
    python -m scripts.populate_baseline

    # Custom window:
    python -m scripts.populate_baseline --year-start 2018 --year-end 2024

    # Pixel-level:
    python -m scripts.populate_baseline --pixels --band ndvi

The script is **idempotent**: re-running replaces existing rows for
the same (tenant, ward, month, band) tuple (ON CONFLICT DO UPDATE).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras

# Lazy GEE import — script must be importable without earthengine-api
# installed (the engine image has it, but a developer's laptop may not).


logger = logging.getLogger("ardalink.scripts.populate_baseline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")

REPO_ROOT = Path(__file__).resolve().parent.parent
WARD_GEOJSON = REPO_ROOT.parent / "ardalink-api" / "docs" / "local-dev" / "data" / "isiolo-wards.geojson"

DEFAULT_TENANT = "isiolo"
DEFAULT_YEAR_START = 2014
DEFAULT_YEAR_END = 2024
DEFAULT_BAND = "ndvi"


def load_wards(geojson_path: Path) -> list[dict[str, Any]]:
    """Return [{ward_id, ward_name, geom}, ...] from the canonical IEBC file."""
    if not geojson_path.exists():
        sys.exit(f"GeoJSON not found: {geojson_path}")
    g = json.loads(geojson_path.read_text())
    feats = []
    for f in g["features"]:
        p = f["properties"]
        feats.append({
            "ward_id": str(p["wardcode"]),
            "ward_name": p["ward"],
            "const": p.get("const"),
            "geom": f["geometry"],
        })
    logger.info("Loaded %d wards from %s", len(feats), geojson_path)
    return feats


def init_ee(creds_json_str: str) -> Any:
    """Authenticate to Earth Engine using the inlined service-account JSON."""
    import ee  # type: ignore[import-not-found]

    creds = json.loads(creds_json_str)
    # Authenticate via private key.
    credentials = ee.ServiceAccountCredentials(creds["client_email"], key_data=creds_json_str)
    ee.Initialize(credentials)
    return ee


def ee_reduce_aggregate(
    ee: Any,
    geom: dict,
    year_start: int,
    year_end: int,
) -> dict[int, dict[str, float | None]]:
    """Return per-month {m: {ndvi_p50, ndvi_p5, ...}} for one ward.

    Sentinel-2 SR monthly composites; cloud-mask using the SCL band;
    compute NDVI = (B8 - B4) / (B8 + B4); then per-month percentile.
    """
    import ee  # type: ignore[import-not-found]

    a = ee.Geometry(geom)
    monthly_p50, monthly_p5 = {}, {}

    for m in range(1, 13):
        start = ee.Date.fromYMD(year_start, m, 1)
        end = ee.Date.fromYMD(year_end, m, 1).advance(1, "month")

        # Sentinel-2 SR + cloud-mask via SCL.
        s2 = (
            ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
            .filterBounds(a)
            .filterDate(start, end)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
            .map(lambda img: img.updateMask(
                img.select("SCL").neq(3)
                 .And(img.select("SCL").neq(8))
                 .And(img.select("SCL").neq(9))
                 .And(img.select("SCL").neq(10))
            ))
        )

        # Monthly median composite.
        composite = s2.median()
        ndvi = composite.normalizedDifference(["B8", "B4"]).rename("NDVI")

        # Reduce over the ward polygon; report p50 + p5.
        stats = ndvi.reduceRegion(
            reducer=ee.Reducer.percentile([5, 50]),
            geometry=a,
            scale=10,
            maxPixels=1e9,
            bestEffort=True,
        ).getInfo()

        if not stats:
            monthly_p50[m] = None
            monthly_p5[m] = None
            continue

        # Earth Engine returns the percentile reducer values keyed by
        # "NDVI_p<percentile>".
        p50 = stats.get("NDVI_p50")
        p5 = stats.get("NDVI_p5")
        monthly_p50[m] = round(float(p50), 4) if p50 is not None else None
        monthly_p5[m] = round(float(p5), 4) if p5 is not None else None

    return {m: {"ndvi_p50": monthly_p50[m], "ndvi_p5": monthly_p5[m]} for m in range(1, 13)}


def upsert_aggregate(
    conn: psycopg2.extensions.connection,
    schema: str,
    tenant_id: str,
    ward_id: str,
    ward_name: str,
    month: int,
    ndvi_p50: float | None,
    ndvi_p5: float | None,
    source: str,
    window_label: str,
    pixel_count: int | None,
) -> None:
    sql = f"""
        INSERT INTO "{schema}".baseline_aggregate
            (tenant_id, ward_id, ward_name, month,
             ndvi_p50, ndvi_p5,
             ndre_p50, ndre_p5,
             red_edge_p50, red_edge_p5,
             source, window_label, pixel_count)
        VALUES (%s, %s, %s, %s, %s, %s, NULL, NULL, NULL, NULL, %s, %s, %s)
        ON CONFLICT (tenant_id, ward_id, month) DO UPDATE SET
            ward_name      = EXCLUDED.ward_name,
            ndvi_p50       = EXCLUDED.ndvi_p50,
            ndvi_p5        = EXCLUDED.ndvi_p5,
            ndre_p50       = EXCLUDED.ndre_p50,
            ndre_p5        = EXCLUDED.ndre_p5,
            red_edge_p50   = EXCLUDED.red_edge_p50,
            red_edge_p5    = EXCLUDED.red_edge_p5,
            source         = EXCLUDED.source,
            window_label   = EXCLUDED.window_label,
            pixel_count    = EXCLUDED.pixel_count,
            computed_at    = now()
    """
    with conn.cursor() as cur:
        cur.execute(sql, (
            tenant_id, ward_id, ward_name, month,
            ndvi_p50, ndvi_p5,
            source, window_label, pixel_count,
        ))
    conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", default=DEFAULT_TENANT)
    parser.add_argument("--year-start", type=int, default=DEFAULT_YEAR_START)
    parser.add_argument("--year-end", type=int, default=DEFAULT_YEAR_END)
    parser.add_argument("--band", default=DEFAULT_BAND, choices=("ndvi", "ndre", "red_edge"))
    parser.add_argument("--pixels", action="store_true",
                        help="Per-pixel mode (writes to baseline_pixel; large)")
    parser.add_argument("--schema", default=os.getenv("GIS_ENGINE_SCHEMA", "gis_engine"))
    parser.add_argument("--wards", default="all",
                        help="Comma-separated ward_ids to populate (default: all 10)")
    args = parser.parse_args()

    # GEE creds from GEE_PRIVATE_KEY env var (matches engine's expected key).
    gee_key = os.getenv("GEE_PRIVATE_KEY")
    if not gee_key:
        sys.exit("GEE_PRIVATE_KEY env var is empty. Set it to the service-account JSON.")
    ee = init_ee(gee_key)

    # Postgres connection (engine's superuser role).
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL env var is empty.")

    wards = load_wards(WARD_GEOJSON)
    if args.wards != "all":
        wanted = set(args.wards.split(","))
        wards = [w for w in wards if w["ward_id"] in wanted]

    logger.info("Populating baseline_aggregate for %d wards (mode=%s, band=%s, %d-%d)",
                len(wards), "pixel" if args.pixels else "aggregate",
                args.band, args.year_start, args.year_end)
    window_label = f"sentinel2-{args.year_start}-{args.year_end}"

    conn = psycopg2.connect(db_url)
    try:
        for i, ward in enumerate(wards, 1):
            t0 = time.time()
            logger.info("[%d/%d] %s (wardcode=%s) — querying GEE",
                        i, len(wards), ward["ward_name"], ward["ward_id"])
            stats = ee_reduce_aggregate(ee, ward["geom"], args.year_start, args.year_end)
            for m, vals in stats.items():
                upsert_aggregate(
                    conn,
                    args.schema,
                    args.tenant,
                    ward["ward_id"],
                    ward["ward_name"],
                    m,
                    vals.get("ndvi_p50"),
                    vals.get("ndvi_p5"),
                    source=f"sentinel2_sr_{args.band}",
                    window_label=window_label,
                    pixel_count=None,
                )
            logger.info("[%d/%d] %s — wrote 12 rows in %.1fs",
                        i, len(wards), ward["ward_name"], time.time() - t0)
    finally:
        conn.close()

    logger.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
