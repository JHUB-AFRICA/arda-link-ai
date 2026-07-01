# ArdaLink Engine — code conventions (addendum)

This is a **service-specific addendum** to the root
[`CONVENTIONS.md`](../../CONVENTIONS.md). Read the root document first —
this file only covers what is unique to the Python 3.12 / FastAPI / async
biophysical-compute service.

---

## 1. Tooling

| Tool | Version | Purpose | Where |
|---|---|---|---|
| Python | 3.12 | Runtime | `pyproject.toml` |
| FastAPI | latest | HTTP framework | `ardalink_engine/main.py` |
| uvicorn | latest | ASGI server | `scripts/` |
| pydantic | v2 | Models + validation | `ardalink_engine/models/` |
| uv | latest | Dependency + venv manager | `pyproject.toml` |
| ruff | latest | Lint + format | `pyproject.toml` |
| pytest | latest | Test runner | `tests/` |
| mypy | latest | Type checker | `pyproject.toml` |

Run before pushing:

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy ardalink_engine
uv run pytest
```

---

## 2. Layering

Source code under `ardalink_engine/src/` is organised in six layers. Imports
must respect the arrows — never upward.

```
api/             ← FastAPI route handlers (HTTP boundary)
   │
   ▼
services/        ← Use-case orchestration (one per use case)
   │
   ▼
core_math/       ← Pure biophysical math (no I/O)
   │
   ▼
pipeline/        ← Data ingestion + scheduling
   │
   ▼
db/              ← SQLAlchemy / Drizzle queries
   │
   ▼
config/          ← Env, secrets (loaded once at boot)
```

`services/` may reach into `core_math/` directly. `pipeline/` may reach into
`core_math/`. Anything else is a layering violation.

---

## 3. File organisation

In addition to the root rules:

- **`api/<resource>.py`** — one `APIRouter` per top-level resource
  (`baseline`, `grid_query`, `satellite`, `assessment`).
- **`services/<use_case>.py`** — one file per use case. A use case is one
  user-visible action (`compute_drought_score`, `plan_journey`).
- **`core_math/<phenomenon>.py`** — pure functions only. If a file in
  `core_math/` imports anything outside its own directory (or `numpy` /
  `scipy`), it is wrong.
- **`pipeline/`** — long-running jobs. Each has a `start()`, `stop()`, and
  `status()` coroutine.

---

## 4. Documentation specifics

### 4.1 NumPy-style docstrings

All public functions and modules use the NumPy docstring format, as shown
in the root document. Section order is fixed:

```
Short summary
Parameters
Returns
Raises (if applicable)
Example (only when usage is non-obvious)
Notes (optional)
References (optional, with URLs)
```

Single-line docstrings (`"""Return x + 1."""`) are only allowed for
genuinely trivial helpers.

### 4.2 Type hints are the contract

Every public function is fully type-hinted, including return types. The
docstring supplements the types — it does not duplicate them. Example:

```py
def compute_drought_score(
    climate: ClimateWindow,
    vegetation: VegetationAnomaly,
    *,
    weights: ScoringWeights | None = None,
) -> DroughtScore:
    """Compute the drought severity score for a ward.

    Parameters
    ----------
    climate : ClimateWindow
        30-day rolling climate window.
    vegetation : VegetationAnomaly
        Vegetation anomaly relative to the per-pixel baseline.
    weights : ScoringWeights | None
        Optional custom weights. Defaults to the per-ward defaults from
        the configuration.

    Returns
    -------
    DroughtScore
        The graded score in the range [0.0, 1.0].
    """
```

If you find yourself wanting to write a long docstring just to explain
parameter shapes, that is a signal the types are wrong — fix the types.

### 4.3 Units in field names

Field names carry units when the type doesn't already encode them:

```py
total_precipitation_mm: float
mean_temperature_c: float
ndvi_delta: float  # dimensionless
```

Don't write `precip` and rely on the docstring to say "millimetres".

---

## 5. Async / error handling

- Route handlers are `async def`. No blocking I/O on the request path.
- Outbound HTTP goes through `httpx.AsyncClient` with a per-call timeout.
- Database access uses the async session factory from `db/session.py`.
- Domain errors are subclasses of `ardalink_engine.errors.DomainError`.
  Routes catch them and translate to HTTP responses in one place
  (`api/error_handlers.py`).

---

## 6. Logging

Use the project logger (`ardalink_engine.logging.get_logger(__name__)`).
Each log line carries structured context:

```py
logger.info("computed drought score", extra={
    "tenant_id": tenant_id,
    "ward": ward,
    "grade": grade,
})
```

Never log full GeoTIFF payloads, raw pastoralist phone numbers, or
credentials.

---

## 7. Testing

- `tests/unit/` — `core_math/` and pure helpers. No fixtures.
- `tests/integration/` — services + db + an ephemeral Postgres via the
  shared test harness.
- `tests/pipeline/` — long-running jobs, with `pytest.mark.slow`.

Every public function in `core_math/` is unit-tested. Every service has at
least one happy-path and one upstream-degraded test.

---

## 8. Reference data

Reference data tables (per-pixel baselines, water points, landmarks) live
under `ardalink_engine/data/` as **typed Parquet or CSV** — not as Python
constants. They are loaded at startup by `pipeline/reference_data.py` and
exposed via `db/reference.py`. Constant tables in source code are a code
smell — extract them.