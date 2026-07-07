"""Tests for the baseline API endpoints.

Exercises the per-ward / per-month aggregate and per-pixel grid
endpoints that the api's `engine.ts` client hits. Coverage here is
deliberately focused on the request-validation paths (4xx) and the
happy-path row shape (when a row exists in the DB).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from ardalink_engine.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def fake_db_empty():
    """Mock the engine's db_client so no Postgres connection is needed."""
    mock = MagicMock()
    mock.schema = "gis_engine"
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=cm)
    cm.__exit__ = MagicMock(return_value=False)
    cur = MagicMock()
    cur.fetchone = MagicMock(return_value=None)
    cur.fetchall = MagicMock(return_value=[])
    cm.cursor = MagicMock(return_value=MagicMock(__enter__=MagicMock(return_value=cur),
                                              __exit__=MagicMock(return_value=False)))
    mock.connection = MagicMock(return_value=cm)
    with patch("ardalink_engine.src.api.baseline.db_client", mock):
        yield mock, cur


@pytest.fixture()
def fake_db_with_row():
    """Mock db_client where one baseline_aggregate row exists."""
    mock = MagicMock()
    mock.schema = "gis_engine"
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=cm)
    cm.__exit__ = MagicMock(return_value=False)
    cur = MagicMock()
    cur.fetchone = MagicMock(return_value=(
        "isiolo", "242", "Bulla Pesa", 6,
        0.42, 0.31,
        0.18, 0.10,
        0.025, 0.012,
        "sentinel2_sr_ndvi", "sentinel2-2014-2024", 1284,
        __import__("datetime").datetime(2026, 6, 1, 0, 0, 0),
    ))
    cm.cursor = MagicMock(return_value=MagicMock(__enter__=MagicMock(return_value=cur),
                                              __exit__=MagicMock(return_value=False)))
    mock.connection = MagicMock(return_value=cm)
    with patch("ardalink_engine.src.api.baseline.db_client", mock):
        yield mock, cur


class TestBaselineAggregate:
    def test_returns_200_with_available_false_when_table_empty(self, client, fake_db_empty):
        res = client.get(
            "/api/v1/baseline/aggregate",
            params={"tenant_id": "isiolo", "ward_id": "242", "month": "6"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["available"] is False
        assert body["row"] is None
        assert body["tenant_id"] == "isiolo"
        assert body["ward_id"] == "242"
        assert body["month"] == 6

    def test_returns_200_with_row_when_present(self, client, fake_db_with_row):
        res = client.get(
            "/api/v1/baseline/aggregate",
            params={"tenant_id": "isiolo", "ward_id": "242", "month": "6"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["available"] is True
        assert body["row"]["ward_name"] == "Bulla Pesa"
        assert body["row"]["ndvi_p50"] == pytest.approx(0.42)
        assert body["row"]["ndvi_p5"] == pytest.approx(0.31)
        assert body["row"]["ndre_p50"] == pytest.approx(0.18)
        assert body["row"]["red_edge_p50"] == pytest.approx(0.025)
        assert body["row"]["source"] == "sentinel2_sr_ndvi"
        assert body["row"]["window_label"] == "sentinel2-2014-2024"
        assert body["row"]["pixel_count"] == 1284

    def test_resolves_ward_name_to_wardcode(self, client, fake_db_with_row):
        """Passing ward_name='Bulla Pesa' should resolve to wardcode='242'."""
        res = client.get(
            "/api/v1/baseline/aggregate",
            params={"tenant_id": "isiolo", "ward_name": "Bulla Pesa", "month": "6"},
        )
        # The endpoint passes the resolved code to the SQL query.
        _, cur = fake_db_with_row
        called_sql = cur.execute.call_args[0][0]
        assert "%s AND ward_id = %s AND month = %s" in called_sql
        # The 2nd positional arg passed to execute() is the resolved ward_id.
        passed_args = cur.execute.call_args[0][1]
        assert passed_args[0] == "isiolo"
        assert passed_args[1] == "242"
        assert passed_args[2] == 6
        # The response carries the resolved code.
        body = res.json()
        assert body["ward_id"] == "242"

    def test_returns_400_when_neither_ward_id_nor_ward_name(self, client, fake_db_empty):
        res = client.get(
            "/api/v1/baseline/aggregate",
            params={"tenant_id": "isiolo", "month": "6"},
        )
        assert res.status_code == 400
        assert "missing_ward" in res.json()["detail"]["error"]

    def test_returns_400_when_tenant_missing(self, client, fake_db_empty):
        """Tenant whitelist removed — attestation + RLS handle isolation now.

        The route only requires *some* tenant id (from header or query param).
        Bogus tenants are safe: RLS returns zero rows because the mocked
        session has no matching `app.current_tenant_id`.
        """
        res = client.get(
            "/api/v1/baseline/aggregate",
            params={"ward_id": "242", "month": "6"},
        )
        assert res.status_code == 400
        assert "missing_tenant" in res.json()["detail"]["error"]

    def test_accepts_arbitrary_tenant_and_defers_to_rls(self, client, fake_db_empty):
        """Non-whitelisted tenant is accepted; RLS decides visibility."""
        res = client.get(
            "/api/v1/baseline/aggregate",
            params={"tenant_id": "garfield", "ward_id": "242", "month": "6"},
        )
        assert res.status_code == 200
        assert res.json()["available"] is False

    def test_returns_400_on_invalid_month(self, client, fake_db_empty):
        for bad in (0, 13, -1):
            res = client.get(
                "/api/v1/baseline/aggregate",
                params={"tenant_id": "isiolo", "ward_id": "242", "month": str(bad)},
            )
            assert res.status_code == 400, f"month={bad} should be rejected"
            assert "invalid_month" in res.json()["detail"]["error"]

    @pytest.mark.parametrize("m", [1, 6, 12])
    def test_accepts_valid_months(self, client, fake_db_empty, m):
        res = client.get(
            "/api/v1/baseline/aggregate",
            params={"tenant_id": "isiolo", "ward_id": "242", "month": str(m)},
        )
        assert res.status_code == 200


class TestBaselinePixel:
    def test_returns_200_with_available_false_when_empty(self, client, fake_db_empty):
        res = client.get(
            "/api/v1/baseline/pixel",
            params={"tenant_id": "isiolo", "ward_id": "242", "month": "6", "band": "ndvi"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["available"] is False
        assert body["pixel_count"] == 0
        assert body["cells"] == []

    def test_returns_400_on_invalid_band(self, client, fake_db_empty):
        res = client.get(
            "/api/v1/baseline/pixel",
            params={"tenant_id": "isiolo", "ward_id": "242", "month": "6", "band": "ultraviolet"},
        )
        assert res.status_code == 400
        assert "invalid_band" in res.json()["detail"]["error"]

    def test_accepts_all_three_bands(self, client, fake_db_empty):
        for band in ("ndvi", "ndre", "red_edge"):
            res = client.get(
                "/api/v1/baseline/pixel",
                params={"tenant_id": "isiolo", "ward_id": "242", "month": "6", "band": band},
            )
            assert res.status_code == 200, f"band={band} should be accepted"
            assert res.json()["band"] == band
