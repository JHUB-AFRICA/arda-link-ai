#!/usr/bin/env python3
"""Write current-month VCI snapshots to Supabase `satellite_indices`.

This is the GEE → Supabase write path for ward-level satellite indices.
Previously this step lived in an ad-hoc Colab notebook; this script
brings it into the repo so it can be run on a schedule, reviewed like
any other code, and called from the engine's API or a CI job.

For each of the 5 canonical Isiolo wards it:
  1. Calls the engine's `fetch_vegetation_index()` to get current
     NDVI and VCI from MODIS via GEE (6 h in-memory cache).
  2. Builds a row for `satellite_indices` with vci_value already set —
     so the hourly VCI backfill job has nothing to patch.
  3. POSTs to Supabase via PostgREST. If a row for this
     (ward_id, period_start) already exists it is updated; if it already
     has vci_value set it is left untouched (idempotent).

ENV vars required (same as the main engine .env):
  GEE_PRIVATE_KEY         service-account JSON key for Earth Engine
  SUPABASE_URL            Supabase project URL
  SUPABASE_SECRET_KEY     service-role secret key

Optional:
  SUPABASE_TIMEOUT_S      HTTP timeout for Supabase calls (default: 15)
  DRY_RUN                 "1" prints what would be posted without writing

Usage:
  # From ardalink-engine/
  python -m scripts.ingest_ward_satellite_indices

  # Dry run:
  DRY_RUN=1 python -m scripts.ingest_ward_satellite_indices
"""

from __future__ import annotations

import logging
import os
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

# Allow running as `python -m scripts.ingest_ward_satellite_indices`
# from the engine root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("requests is not installed — run: pip install requests")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("ardalink.scripts.ingest_ward_satellite_indices")

# ── Ward table ───────────────────────────────────────────────────────────────
# Canonical engine display-name → Supabase ward_id. Must stay in sync with
# ardalink-api/src/lib/wardMapping.ts and Supabase active_wards view.
WARD_NAME_TO_ID: dict[str, str] = {
    "Wabera":     "241",
    "Bulla Pesa": "242",
    "Ngare Mara": "245",
    "Burat":      "246",
    "Oldonyiro":  "247",
}

SUPABASE_TIMEOUT_S = float(os.getenv("SUPABASE_TIMEOUT_S", "15"))
DRY_RUN = os.getenv("DRY_RUN", "0").lower() in ("1", "true", "yes")

SOURCE_COLLECTION = "MODIS/061/MOD13Q1"


def _supabase_headers(key: str) -> dict[str, str]:
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _period_bounds(now: datetime) -> tuple[str, str]:
    """Return (period_start, period_end) strings for the current month."""
    start = f"{now.year:04d}-{now.month:02d}-01"
    end = now.strftime("%Y-%m-%d")
    return start, end


def _existing_row(
    sb_url: str,
    sb_key: str,
    ward_id: str,
    period_start: str,
) -> dict | None:
    """Fetch the existing satellite_indices row for (ward_id, period_start), or None."""
    url = (
        f"{sb_url}/rest/v1/satellite_indices"
        f"?ward_id=eq.{ward_id}"
        f"&period_start=eq.{period_start}"
        f"&select=satellite_index_id,vci_value"
        f"&limit=1"
    )
    try:
        resp = requests.get(url, headers=_supabase_headers(sb_key), timeout=SUPABASE_TIMEOUT_S)
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception as exc:
        logger.warning("Could not check existing row for ward %s / %s: %s", ward_id, period_start, exc)
        return None


def _patch_vci(
    sb_url: str,
    sb_key: str,
    ward_id: str,
    period_start: str,
    ndvi_mean: float | None,
    vci_value: float,
) -> bool:
    """PATCH vci_value (and ndvi_mean) onto an existing satellite_indices row."""
    url = (
        f"{sb_url}/rest/v1/satellite_indices"
        f"?ward_id=eq.{ward_id}"
        f"&period_start=eq.{period_start}"
    )
    body: dict = {"vci_value": vci_value}
    if ndvi_mean is not None:
        body["ndvi_mean"] = ndvi_mean
    try:
        resp = requests.patch(
            url,
            json=body,
            headers={**_supabase_headers(sb_key), "Prefer": "return=minimal"},
            timeout=SUPABASE_TIMEOUT_S,
        )
        resp.raise_for_status()
        return True
    except Exception as exc:
        logger.error("PATCH failed for ward %s: %s", ward_id, exc)
        return False


def _insert_row(
    sb_url: str,
    sb_key: str,
    ward_id: str,
    period_start: str,
    period_end: str,
    calendar_month: int,
    calendar_year: int,
    ndvi_mean: float | None,
    ndvi_min: float | None,
    ndvi_max: float | None,
    vci_value: float,
    prosopis_factor: float,
    run_id: str,
) -> bool:
    """INSERT a new satellite_indices row with vci_value already set."""
    payload = {
        "ward_id": ward_id,
        "period_start": period_start,
        "period_end": period_end,
        "calendar_month": calendar_month,
        "calendar_year": calendar_year,
        "ndvi_mean": ndvi_mean,
        "vci_value": vci_value,
        "prosopis_corrected": True,
        "prosopis_share": round(1.0 - prosopis_factor, 4),
        "source_collection": SOURCE_COLLECTION,
        "run_id": run_id,
    }
    # Only include envelope when GEE returned them (may be None on sparse data).
    if ndvi_min is not None:
        payload["ndvi_min"] = ndvi_min
    if ndvi_max is not None:
        payload["ndvi_max"] = ndvi_max

    try:
        resp = requests.post(
            f"{sb_url}/rest/v1/satellite_indices",
            json=payload,
            headers={**_supabase_headers(sb_key), "Prefer": "return=minimal"},
            timeout=SUPABASE_TIMEOUT_S,
        )
        resp.raise_for_status()
        return True
    except Exception as exc:
        logger.error("INSERT failed for ward %s: %s — body: %s", ward_id, exc, getattr(exc, "response", None) and exc.response.text[:300])
        return False


def main() -> int:
    sb_url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    sb_key = (os.getenv("SUPABASE_SECRET_KEY") or "").strip()
    if not sb_url or not sb_key:
        sys.exit("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.")

    gee_key = os.getenv("GEE_PRIVATE_KEY")
    if not gee_key:
        sys.exit("GEE_PRIVATE_KEY is not set.")

    # Initialise the engine's GEE connection (lazy, thread-safe).
    from ardalink_engine.src.geo.wards import WARDS
    from ardalink_engine.src.pipeline.gee import ensure_initialized
    from ardalink_engine.src.pipeline.satellite import fetch_vegetation_index

    ensure_initialized()

    now = datetime.now(UTC)
    period_start, period_end = _period_bounds(now)
    calendar_month = now.month
    calendar_year = now.year
    run_id = str(uuid.uuid4())

    logger.info(
        "Ingesting ward satellite indices — period %s → %s (run %s%s)",
        period_start, period_end, run_id[:8],
        " [DRY RUN]" if DRY_RUN else "",
    )

    ok = 0
    skipped = 0
    errors = 0

    for ward_name, ward_id in WARD_NAME_TO_ID.items():
        if ward_name not in WARDS:
            logger.warning("Ward '%s' not in engine WARDS — skipping", ward_name)
            continue

        logger.info("[%s] Fetching VCI from GEE …", ward_name)
        try:
            result = fetch_vegetation_index(ward_name)
        except Exception as exc:
            logger.error("[%s] GEE fetch failed: %s", ward_name, exc)
            errors += 1
            continue

        vci = result.get("vci")
        ndvi_now = result.get("ndvi_now")
        ndvi_min = result.get("ndvi_min")
        ndvi_max = result.get("ndvi_max")
        prosopis_factor = result.get("prosopis_factor", 0.85)

        if vci is None:
            logger.warning("[%s] GEE returned null VCI — skipping", ward_name)
            errors += 1
            continue

        logger.info(
            "[%s] ward_id=%s  VCI=%.1f  ndvi_now=%.4f",
            ward_name, ward_id, vci, ndvi_now or 0,
        )

        if DRY_RUN:
            logger.info("[%s] DRY RUN — would write vci_value=%.1f", ward_name, vci)
            ok += 1
            continue

        # Check for existing row — prefer PATCH over INSERT to avoid touching
        # columns managed by the full upsert_satellite_indices RPC.
        existing = _existing_row(sb_url, sb_key, ward_id, period_start)

        if existing is not None:
            if existing.get("vci_value") is not None:
                logger.info("[%s] Row already has vci_value — skipping", ward_name)
                skipped += 1
                continue
            wrote = _patch_vci(sb_url, sb_key, ward_id, period_start, ndvi_now, vci)
            action = "PATCH"
        else:
            wrote = _insert_row(
                sb_url, sb_key,
                ward_id, period_start, period_end,
                calendar_month, calendar_year,
                ndvi_now, ndvi_min, ndvi_max,
                vci, prosopis_factor, run_id,
            )
            action = "INSERT"

        if wrote:
            logger.info("[%s] %s ok — vci_value=%.1f", ward_name, action, vci)
            ok += 1
        else:
            errors += 1

    logger.info(
        "Done: %d written, %d skipped (already had VCI), %d errors",
        ok, skipped, errors,
    )
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
