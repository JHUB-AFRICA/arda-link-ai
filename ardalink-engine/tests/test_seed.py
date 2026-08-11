"""Tests for ardalink_engine.src.db.seed.

_build_corridor_rows() has zero coverage from any existing app-level
test (it's only exercised at real startup, inside seed_all()'s DB
lifespan hook) — confirmed live, 2026-08-11 deployment audit: two
misspelled ward-name lookups ("Garba Tulla" instead of "Garbatulla",
"Ngaremara" instead of "Ngare Mara") threw KeyError against the real
WARDS dict and crashed the engine's entire startup on any fresh/empty
database. These are cheap, pure-function tests (no DB needed) so
there's no excuse for this class of bug reaching a live boot again.
"""

from __future__ import annotations

from ardalink_engine.src.db.seed import _build_corridor_rows
from ardalink_engine.src.geo.wards import WARDS


def test_build_corridor_rows_does_not_raise() -> None:
    # The real, live-observed failure mode: a bad ward-name lookup
    # inside line() raises KeyError and takes down the whole function.
    _build_corridor_rows()


def test_build_corridor_rows_returns_five_corridors() -> None:
    rows = _build_corridor_rows()
    assert len(rows) == 5


def test_every_corridor_geometry_is_built_from_real_wards() -> None:
    # Each row's third element is the GeoJSON LineString produced by
    # line(*wards) — if any ward name in that call didn't match a
    # WARDS key, _build_corridor_rows() would have already raised
    # before reaching this point. This test additionally locks in the
    # coordinate count matching the number of wards each corridor
    # names, so a future edit can't silently drop a leg.
    import json

    expected_leg_counts = {
        "LC-ISL-N1": 3,
        "LC-ISL-E1": 3,
        "LC-ISL-S1": 3,
        "LC-ISL-C1": 3,
        "LC-ISL-W1": 3,
    }
    for corridor_id, _name, geometry_json, *_rest in _build_corridor_rows():
        geometry = json.loads(geometry_json)
        assert geometry["type"] == "LineString"
        assert len(geometry["coordinates"]) == expected_leg_counts[corridor_id]


def test_corridor_ward_names_are_real_wards_keys() -> None:
    # Documents exactly which real ward names the corridor data is
    # supposed to reference, spelled the way WARDS actually keys them
    # — "Garbatulla" (one word) and "Ngare Mara" (with a space), not
    # the "Garba Tulla" / "Ngaremara" variants that used to be here.
    assert "Garbatulla" in WARDS
    assert "Garba Tulla" not in WARDS
    assert "Ngare Mara" in WARDS
    assert "Ngaremara" not in WARDS
