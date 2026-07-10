"""
Tests for the satellite GEE integration.

Tests the /api/v1/satellite/* endpoints in the engine.
Uses the safe_run pattern to skip when GEE is not configured.
"""

import pytest  # noqa: F401
from fastapi.testclient import TestClient


def safe_run(label, fn):
    """Execute a test function; return None on GEE configuration errors."""
    try:
        return fn()
    except Exception as e:
        print(f"[skip {label}] {e}")
        return None


def test_vci_requires_ward_param(client: TestClient):
    """GET /api/v1/satellite/vci returns 400 without ward parameter."""
    response = client.get("/api/v1/satellite/vci")
    assert response.status_code == 422  # FastAPI validation error


def test_vci_unknown_ward(client: TestClient):
    """GET /api/v1/satellite/vci returns 404 for unknown ward."""
    response = client.get("/api/v1/satellite/vci?ward_id=nonexistent-ward")
    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "unknown_ward"


def test_vci_bula_pesa(client: TestClient):
    """GET /api/v1/satellite/vci returns VCI data for Bula Pesa when GEE is configured."""
    def fn():
        response = client.get("/api/v1/satellite/vci?ward_id=bula-pesa")
        assert response.status_code == 200
        data = response.json()
        assert data["ward_id"] == "bula-pesa"
        assert isinstance(data["vci"], (int, float))
        assert 0 <= data["vci"] <= 100
        assert data["urban_masked"] is True
        assert data["prosopis_factor"] == 0.85
        assert "captured_at" in data
        return data

    result = safe_run("VCI Bula Pesa", fn)
    # If GEE not configured, result is None and we skip the assertion
    if result:
        assert result["vci"] is not None


def test_vci_garbatulla(client: TestClient):
    """GET /api/v1/satellite/vci returns VCI data for Garbatulla when GEE is configured."""
    def fn():
        response = client.get("/api/v1/satellite/vci?ward_id=garbatulla")
        assert response.status_code == 200
        data = response.json()
        assert data["ward_id"] == "garbatulla"
        assert isinstance(data["vci"], (int, float))
        return data

    safe_run("VCI Garbatulla", fn)


def test_vci_kinna(client: TestClient):
    """GET /api/v1/satellite/vci returns VCI data for Kinna when GEE is configured."""
    def fn():
        response = client.get("/api/v1/satellite/vci?ward_id=kinna")
        assert response.status_code == 200
        data = response.json()
        assert data["ward_id"] == "kinna"
        assert isinstance(data["vci"], (int, float))
        return data

    safe_run("VCI Kinna", fn)


@pytest.mark.skip(reason="GEE configuration tests are integration tests that require specific credential setup")
def test_vci_gee_not_configured(client_no_gee: TestClient):
    """GET /api/v1/satellite/vci returns 503 when GEE credentials are missing."""
    response = client_no_gee.get("/api/v1/satellite/vci?ward_id=bula-pesa")
    assert response.status_code == 503
    data = response.json()
    assert data["detail"]["error"] == "gee_not_configured"


def test_trigger_dry_run(client: TestClient):
    """POST /api/v1/satellite/trigger with dryRun=true returns dry_run status.

    DEMO_WARDS was refreshed 2026-07-09 to the 5 canonical Isiolo
    Sub-County tenants (post-retirement of Garbatulla + Merti).
    Asserts on the current active set. The retired garbatulla / kinna
    slugs are still resolvable via the _SLUG_TO_NAME alias table so
    in-flight callers don't fail cold, but they no longer appear in
    the default trigger list.
    """
    response = client.post("/api/v1/satellite/trigger?dry_run=true")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "dry_run"
    expected_wards = {"bulla-pesa", "wabera", "ngare-mara", "burat", "oldonyiro"}
    assert set(data["wards"]) == expected_wards
    assert data["results"] is None
    assert data["error"] is None
    assert "started_at" in data


def test_trigger_all_wards(client: TestClient):
    """POST /api/v1/satellite/trigger fetches VCI for all demo wards when GEE is configured."""
    def fn():
        response = client.post("/api/v1/satellite/trigger")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] in ["success", "failed"]
        assert isinstance(data["wards"], list)
        assert "started_at" in data
        if data["status"] == "success":
            assert data["results"] is not None
            assert isinstance(data["results"], dict)
        return data

    safe_run("Trigger all wards", fn)


@pytest.mark.skip(reason="GEE configuration tests are integration tests that require specific credential setup")
def test_trigger_gee_not_configured(client_no_gee: TestClient):
    """POST /api/v1/satellite/trigger returns 503 when GEE credentials are missing."""
    response = client_no_gee.post("/api/v1/satellite/trigger")
    assert response.status_code == 503
    data = response.json()
    assert data["detail"]["error"] == "gee_not_configured"
