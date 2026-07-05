#!/usr/bin/env python3
"""Resume the baseline grid ingestion from the last successfully written cell.

Detects per-layer the highest cell_id already written and resumes from there,
then runs any layers that have 0 cells written (soil).

Usage:
    cd ardalink-engine
    GEE_PRIVATE_KEY=... DATABASE_URL=... python -m scripts.resume_baseline_ingest

    # Or with the local .env loaded:
    python -m scripts.resume_baseline_ingest
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

# Allow running as `python -m scripts.resume_baseline_ingest` from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("ardalink.scripts.resume_baseline_ingest")

# These must come after dotenv so env vars are available at import time.
from ardalink_engine.src.db.client import db_client  # noqa: E402
from ardalink_engine.src.pipeline.gee import ensure_initialized  # noqa: E402
from ardalink_engine.src.pipeline.grid_ingest import ingest_layer  # noqa: E402


def _last_written_cell(column: str) -> int:
    """Return the highest cell_id that has a non-NULL value for *column*, or -1."""
    schema = db_client.schema
    row = db_client.fetch_one(
        f'SELECT MAX(cell_id) AS m FROM "{schema}".grid_dynamic WHERE {column} IS NOT NULL'
    )
    val = row["m"] if row else None
    return int(val) if val is not None else -1


LAYER_COLUMNS = {
    "climate": "temperature_c",
    "soil": "soil_moisture",
    # Add others here if you need to resume vegetation / protein.
}


def main() -> int:
    ensure_initialized()

    for layer, column in LAYER_COLUMNS.items():
        last_id = _last_written_cell(column)
        if last_id == -1:
            logger.info("Layer '%s': no cells written yet — running from scratch.", layer)
        else:
            logger.info(
                "Layer '%s': resuming from cell_id > %d (last written).", layer, last_id
            )
        result = ingest_layer(layer, start_cell_id=last_id)
        logger.info(
            "Layer '%s' done: %d cells scanned, %d written.",
            layer, result["cells_scanned"], result["cells_written"],
        )

    logger.info("Resume complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
