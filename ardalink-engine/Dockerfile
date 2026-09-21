# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# ArdaLink Engine — multi-stage build
# Final image: distroless Python 3.13 (satisfies pyproject's requires-python >=3.12;
# distroless has no 3.12-specific tag — debian12 ships 3.11, debian13 ships 3.13)
# -----------------------------------------------------------------------------

# ---- Stage 1: deps via uv ----
FROM python:3.13-slim AS deps
WORKDIR /app
RUN pip install --no-cache-dir uv==0.5.10
COPY pyproject.toml uv.lock README.md ./
COPY ardalink_engine ./ardalink_engine
RUN uv export --no-hashes --frozen > /tmp/requirements.txt && \
    pip install --no-cache-dir -r /tmp/requirements.txt

# ---- Stage 2: runtime ----
FROM gcr.io/distroless/python3-debian13:nonroot AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/usr/local/lib/python3.13/site-packages \
    ARDALINK_HOST=0.0.0.0 \
    ARDALINK_PORT=5001
COPY --from=deps /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY ardalink_engine ./ardalink_engine
USER nonroot
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:5001/health',timeout=2); sys.exit(0 if r.status==200 else 1)"]
ENTRYPOINT ["python", "-m", "ardalink_engine.main"]