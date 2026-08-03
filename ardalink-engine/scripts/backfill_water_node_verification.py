#!/usr/bin/env python3
"""One-time backfill: mark already-imported real water_nodes rows verified.

Run ONCE, right after the `verified`/`deleted_at` columns land (schema.py's
_ddl(), idempotent column-existence only) and BEFORE (or in the same deploy
as) grazing.py's query change that filters on `verified = true` — otherwise
advisories briefly return no water points at all.

Deliberately NOT part of ensure_schema()'s always-run idempotent DDL: this
is a data backfill, not a schema migration. Running it on every boot would
silently re-flip verified back to true for a point an operator had
deliberately un-verified through the admin console — a real correctness bug,
not just redundant work.

Marks source IN ('wpdx', 'osm') as verified=true (real, imported data).
Leaves source IS NULL (the 12 fabricated demo/seed rows) verified=false —
an operator can promote any of those to verified through the admin console
if one turns out to correspond to a real point, but they don't get a free
pass just for existing.

Usage:
    python -m scripts.backfill_water_node_verification
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

logger = logging.getLogger("ardalink.scripts.backfill_water_node_verification")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")


def main() -> None:
    from ardalink_engine.src.db.client import DatabaseClient

    client = DatabaseClient()
    # DatabaseClient.connection() commits on clean exit — no explicit commit needed.
    with client.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f'''UPDATE "{client.schema}".water_nodes
                SET verified = true
                WHERE source IN ('wpdx', 'osm') AND verified = false'''
        )
        updated = cur.rowcount

    logger.info("Marked %d wpdx/osm water_nodes rows as verified.", updated)
    logger.info(
        "Fabricated seed rows (source IS NULL) intentionally left "
        "verified=false — promote individually via the admin console if warranted."
    )


if __name__ == "__main__":
    main()
