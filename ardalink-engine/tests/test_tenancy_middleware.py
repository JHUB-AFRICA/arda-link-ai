"""Tests for the tenant attestation middleware.

Covers three modes:

* Secret unset (local dev) — any X-Tenant-ID passes through, missing
  header falls back to query param.
* Secret set, valid attestation — request succeeds and the header wins
  over the query param.
* Secret set, missing or invalid attestation — 401.
"""

from __future__ import annotations

import hashlib
import hmac
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


def _sign(secret: str, tenant_id: str) -> str:
    return hmac.new(secret.encode("utf-8"), tenant_id.encode("utf-8"), hashlib.sha256).hexdigest()


@pytest.fixture()
def fake_db_empty():
    """Isolate the DB behind a mock so we don't need Postgres for these tests."""
    mock = MagicMock()
    mock.schema = "gis_engine"
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=cm)
    cm.__exit__ = MagicMock(return_value=False)
    cur = MagicMock()
    cur.fetchone = MagicMock(return_value=None)
    cur.fetchall = MagicMock(return_value=[])
    cm.cursor = MagicMock(
        return_value=MagicMock(
            __enter__=MagicMock(return_value=cur), __exit__=MagicMock(return_value=False)
        )
    )
    mock.connection = MagicMock(return_value=cm)
    with patch("ardalink_engine.src.api.baseline.db_client", mock):
        yield


@pytest.fixture()
def client_with_secret(monkeypatch, fake_db_empty):
    monkeypatch.setenv("TENANT_ATTESTATION_SECRET", "s3cret")
    from ardalink_engine.main import app
    return TestClient(app)


@pytest.fixture()
def client_no_secret(monkeypatch, fake_db_empty):
    monkeypatch.delenv("TENANT_ATTESTATION_SECRET", raising=False)
    from ardalink_engine.main import app
    return TestClient(app)


def test_dev_mode_passes_without_attestation(client_no_secret):
    """When TENANT_ATTESTATION_SECRET is unset, a bare X-Tenant-ID is accepted."""
    res = client_no_secret.get(
        "/api/v1/baseline/aggregate",
        params={"ward_id": "242", "month": "6"},
        headers={"X-Tenant-ID": "isiolo"},
    )
    assert res.status_code == 200
    assert res.json()["tenant_id"] == "isiolo"


def test_secret_set_rejects_missing_attestation(client_with_secret):
    res = client_with_secret.get(
        "/api/v1/baseline/aggregate",
        params={"ward_id": "242", "month": "6"},
        headers={"X-Tenant-ID": "isiolo"},
    )
    assert res.status_code == 401
    assert res.json()["error"] == "tenant_attestation_missing"


def test_secret_set_rejects_bad_attestation(client_with_secret):
    res = client_with_secret.get(
        "/api/v1/baseline/aggregate",
        params={"ward_id": "242", "month": "6"},
        headers={"X-Tenant-ID": "isiolo", "X-Tenant-Sig": "not-a-real-signature"},
    )
    assert res.status_code == 401
    assert res.json()["error"] == "tenant_attestation_invalid"


def test_secret_set_accepts_valid_attestation(client_with_secret):
    tenant = "isiolo"
    res = client_with_secret.get(
        "/api/v1/baseline/aggregate",
        params={"ward_id": "242", "month": "6"},
        headers={"X-Tenant-ID": tenant, "X-Tenant-Sig": _sign("s3cret", tenant)},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["tenant_id"] == tenant


def test_header_beats_query_param(client_no_secret):
    """When both header and query param are set, the header wins."""
    res = client_no_secret.get(
        "/api/v1/baseline/aggregate",
        params={"tenant_id": "query-tenant", "ward_id": "242", "month": "6"},
        headers={"X-Tenant-ID": "header-tenant"},
    )
    assert res.status_code == 200
    assert res.json()["tenant_id"] == "header-tenant"
