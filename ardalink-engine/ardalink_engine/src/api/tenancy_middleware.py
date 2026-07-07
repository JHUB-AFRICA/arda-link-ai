"""FastAPI middleware — tenant attestation.

Reads the `X-Tenant-ID` and `X-Tenant-Sig` headers from every incoming
request. When both are present, verifies the HMAC-SHA256 attestation
against ``TENANT_ATTESTATION_SECRET`` and stores the tenant id on
``request.state.tenant_id`` for route handlers.

Behaviour:

* If ``TENANT_ATTESTATION_SECRET`` is unset (local dev) — attestation is
  a no-op. A bare ``X-Tenant-ID`` header still populates
  ``request.state.tenant_id``, but nothing is rejected.
* If the secret is set and ``X-Tenant-ID`` is present but the signature
  is missing or invalid — respond ``401 tenant_attestation_failed``.
* If neither header is present — pass through. Routes fall back to the
  ``tenant_id`` query parameter for backward compatibility.

Route handlers should call :func:`resolve_tenant_id` to get the effective
tenant id (header takes precedence over query param). DB queries that
touch ``gis_engine`` tables must wrap the connection in
:func:`ardalink_engine.tenancy.set_tenant` so RLS policies fire.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from ...tenancy import _tenant_attestation_secret, verify_tenant_attestation
from ..logging_config import get_logger

logger = get_logger("ardalink.api.tenancy_middleware")


class TenantAttestationMiddleware(BaseHTTPMiddleware):
    """Verify HMAC-SHA256 attestation on ``X-Tenant-ID`` when secret is set."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        tenant_id = request.headers.get("X-Tenant-ID", "").strip()
        attestation = request.headers.get("X-Tenant-Sig", "").strip()
        secret_configured = bool(_tenant_attestation_secret())

        if tenant_id:
            if secret_configured and not attestation:
                return JSONResponse(
                    status_code=401,
                    content={
                        "error": "tenant_attestation_missing",
                        "message": "X-Tenant-Sig header required when TENANT_ATTESTATION_SECRET is configured.",
                    },
                )
            if secret_configured and not verify_tenant_attestation(tenant_id, attestation):
                logger.warning("Rejected request with invalid tenant attestation for %s", tenant_id)
                return JSONResponse(
                    status_code=401,
                    content={
                        "error": "tenant_attestation_invalid",
                        "message": "X-Tenant-Sig does not match the expected HMAC for X-Tenant-ID.",
                    },
                )
            # Either the attestation verified or the secret is unset (dev).
            request.state.tenant_id = tenant_id

        return await call_next(request)


def resolve_tenant_id(request: Request, fallback: str | None = None) -> str | None:
    """Return the effective tenant id for a request.

    Order of precedence:
      1. ``request.state.tenant_id`` — set by :class:`TenantAttestationMiddleware`
         from a verified ``X-Tenant-ID`` header.
      2. ``fallback`` — usually the ``tenant_id`` query parameter, kept for
         backward compatibility with unauthenticated dev requests.

    Returns ``None`` only if neither source has a value. Callers should treat
    ``None`` as a client error.
    """
    tenant_id = getattr(request.state, "tenant_id", None)
    return tenant_id or fallback
