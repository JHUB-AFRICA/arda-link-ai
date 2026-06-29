# ArdaLink — Engineering Walkthrough

**Audience**: engineers joining the team, technical reviewers, anyone
who wants to verify the multi-tenant story from the terminal.

**Time**: 30 minutes if you run every step. 5 minutes if you skim.

**Goal**: by the end you should be able to point at three layers of
the system and say "this is what enforces the tenant boundary".

---

## 1. Start (5 min)

### Prereqs

```bash
# You need:
#   - Docker
#   - Node 24 + pnpm 9
#   - Python 3.12 + uv
#   - PostgreSQL client (psql)
#   - curl, jq, make
```

### Clone the three repos as siblings

```bash
mkdir ardalink && cd ardalink
git clone git@github.com:MUNENE1212/ardalink-engine.git
git clone git@github.com:MUNENE1212/ardalink-api.git
git clone git@github.com:MUNENE1212/ardalink-web.git

# Check out the migration branch (or main, after the PRs merge)
( cd ardalink-engine && git switch migrate/import-legacy )
( cd ardalink-api    && git switch migrate/import-legacy )
( cd ardalink-web    && git switch migrate/import-legacy )
```

### Bring up the local stack

The api is the orchestrator. Its `docs/local-dev/` is the public
single-entrypoint.

```bash
cd ardalink-api/docs/local-dev
make setup    # one-time: copies .env.example to .env
make up       # ~90s
```

You should see:

```
▶ Postgres (Docker)
  ✓ postgres ready
▶ Redis (Docker)
  ✓ redis ready
▶ Migrations + role
  ✓ app role ardalink_app (no BYPASSRLS)
  ✓ 0000_base_schema.up.sql applied
  ✓ 0001_multitenant_gis_engine.up.sql applied
  ✓ 0001_multitenant_public.up.sql applied
▶ Seed demo data
  ✓ demo data seeded
▶ ardalink-engine
  ✓ started
  ✓ engine healthy (after 3s)
▶ ardalink-api
  ✓ started
  ✓ api healthy
▶ ardalink-web (static build)
  ✓ started (serving dashboard + talk on :8080)

Demo tokens (paste in your shell):
bula-pesa     eyJhbGciOiAi...
```

### Confirm

```bash
make ps
# Shows running PIDs and Docker containers

# Health endpoints
curl -s http://127.0.0.1:5001/health
curl -s http://127.0.0.1:3000/api/healthz
```

---

## 2. Navigate (15 min)

Three repos. Each has a single responsibility.

### ardalink-engine — biophysical brain

```
ardalink-engine/
├── ardalink_engine/
│   ├── main.py                  FastAPI entry, lifespan boots DB+seed
│   ├── src/
│   │   ├── api/                 route handlers (assessment, grid_query)
│   │   ├── core_math/           livestock energy + nutrition formulas
│   │   ├── db/                  schema.py, seed.py, client.py
│   │   ├── geo/                 grid math, routing, wards
│   │   ├── pipeline/             GEE ingest, scheduler, obstacles
│   │   ├── ai/                  Azure OpenAI client
│   │   ├── config.py            pydantic-settings env loader
│   │   ├── logging_config.py
│   │   └── tenancy.py            set_tenant() + HMAC attestation
│   └── tests/
│       ├── test_main.py          smoke /health
│       ├── test_tenancy.py       tenant binding + attestation
│       ├── test_energy.py        livestock energy formulas
│       └── test_wards.py         ward registry
```

**Read first**: `ardalink_engine/src/db/schema.py` (the gis_engine DDL)
and `ardalink_engine/tenancy.py` (the tenant binding pattern).

### ardalink-api — voice + intelligence + ground truth

```
ardalink-api/
├── src/
│   ├── index.ts                 Express bootstrap
│   ├── app.ts                   middleware chain, /api/healthz, /api/whoami
│   ├── routes/                  chat, callTokens, groundTruth, intelligence,
│   │                            pastoralists, publicTalk, voice
│   ├── lib/                     openai, voiceStream, voiceStreamBrowser,
│   │                            satellite, climate, predict, memory,
│   │                            callTokens, tenancy, tenancy-context
│   └── middlewares/             tenant (JWT verification)
├── lib/
│   ├── api-spec/                canonical OpenAPI (source of truth)
│   ├── api-zod/                 generated Zod validators
│   ├── api-client-react/        generated React Query hooks (consumed by web)
│   └── db/                      Drizzle ORM (PostgreSQL public schema)
├── docs/
│   ├── 00-EXECUTIVE-INDEX.md    CTO brief
│   ├── 01-ARCHITECTURE.md
│   └── local-dev/               the public single-entrypoint local stack
└── Dockerfile
```

**Read first**: `src/middlewares/tenant.ts` (JWT verification),
`src/lib/tenancy-context.ts` (`withTenantContext` DB helper), and
`src/lib/tenancy.ts` (HMAC attestation).

### ardalink-web — dashboard + Talk app

```
ardalink-web/
├── dashboard/                  React 19 + Vite + Tailwind
│   ├── src/
│   │   ├── components/         CallModal, CostRailsCard, ShareCallLinkButton,
│   │   │                       WardMapLive, ui/ (shadcn)
│   │   ├── pages/              dashboard, call-receiver
│   │   ├── hooks/              use-mobile, use-toast
│   │   └── lib/                browserVoice bridge, tenant context
│   ├── vite.config.ts
│   └── tests/
├── talk/                       public voice + chat app
├── pnpm-workspace.yaml         catalog of shared versions
├── Dockerfile
└── nginx.conf                  static-asset routing + security headers
```

**Read first**: `dashboard/src/lib/tenant.ts` (in-memory context
mirrors the api's JWT claim) and `dashboard/src/components/WardMapLive.tsx`
(the map + grid overlay).

---

## 3. Prove (10 min)

The multi-tenant boundary is enforced at three layers. Each
test below is independent and takes < 5 seconds.

### Layer 1 — JWT (in ardalink-api)

The api refuses anonymous traffic and trusts the JWT claim.

```bash
cd ardalink-api/docs/local-dev
BP=$(make token T=bula-pesa  2>/dev/null)
GB=$(make token T=garbatulla 2>/dev/null)

# 1a. No token → 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/whoami
# Expected: 401

# 1b. Valid token → tenant_id from the claim, not the path
curl -s -H "Authorization: Bearer $BP" http://127.0.0.1:3000/api/whoami
# Expected: {"tenant_id":"bula-pesa","sub":"demo"}

# 1c. Two tokens, same endpoint, different reported tenants
diff <(curl -s -H "Authorization: Bearer $BP" http://127.0.0.1:3000/api/whoami) \
     <(curl -s -H "Authorization: Bearer $GB" http://127.0.0.1:3000/api/whoami)
# Expected: the diff shows tenant_id differs
```

### Layer 2 — HMAC (between api and engine)

The api mints a header `X-Tenant-Sig = HMAC(tenant_id, shared_secret)`
when calling the engine. The engine verifies it before trusting the
tenant id.

Look at the code:

```bash
# Read the api side
cat ardalink-api/src/lib/tenancy.ts | grep -A 8 "tenantForwardHeaders"
```

```typescript
export function tenantForwardHeaders(tenantId: string) {
  return {
    "X-Tenant-ID": tenantId,
    "X-Tenant-Sig": createHmac("sha256", secret)
      .update(tenantId).digest("hex"),
  };
}
```

```bash
# Read the engine side
cat ardalink-engine/ardalink_engine/tenancy.py | grep -A 8 "verify_tenant_attestation"
```

```python
def verify_tenant_attestation(tenant_id, attestation):
    if not secret:
        return bool(tenant_id)        # dev only — attestation disabled
    expected = attest_tenant(tenant_id)
    return hmac.compare_digest(expected, attestation)
```

The shared secret is `TENANT_ATTESTATION_SECRET` in `.env`. If you
set it differently on the api and the engine, the engine will
reject every request from the api (proves the check actually runs).

### Layer 3 — Postgres RLS

The api uses a non-superuser role. RLS policies on every operational
table reject cross-tenant queries at the database kernel.

```bash
PGPASSWORD=ardalink_dev_only psql -h 127.0.0.1 -p 15432 -U ardalink_app -d ardalink
```

In the psql prompt:

```sql
-- Confirm the role is NOT a bypasser
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
  WHERE rolname IN ('ardalink', 'ardalink_app');
-- ardalink      | t | t     (superuser, can bypass)
-- ardalink_app  | f | f     (constrained, RLS applies)

-- Try to see all rows as ardalink_app without setting tenant
SELECT count(*) FROM public.ground_truth_reports;
-- Expected: 0  (RLS denies without a tenant context)

-- Set bula-pesa context, count
SET app.current_tenant_id = 'bula-pesa';
SELECT count(*) FROM public.ground_truth_reports;
-- Expected: 12

-- Switch to garbatulla, count
SET app.current_tenant_id = 'garbatulla';
SELECT count(*) FROM public.ground_truth_reports;
-- Expected: 12  (different rows, same count)

-- Try to forge a tenant via raw SQL
-- (psql itself bypasses the api's allowlist, so to test the actual
--  protection layer you need to send the malicious value THROUGH the
--  api, not through psql)
SET app.current_tenant_id = 'DROP TABLE tenants; --';
-- This succeeds at the psql level — proving that the DB trusts the
-- session variable. The real defence is at the api/engine boundary
-- below.

\q
```

Then in another terminal, test the api's own defence:

```bash
# Source the .env so JWT_SECRET is set
cd ardalink-api/docs/local-dev
set -a; . .env; set +a

# Forge a JWT with a malicious tenant_id claim
SECRET="$JWT_SECRET" python3 -c "
import base64, hmac, hashlib, json
secret = b'$SECRET'
header = base64.urlsafe_b64encode(json.dumps({'alg':'HS256','typ':'JWT'}).encode()).rstrip(b'=').decode()
payload = base64.urlsafe_b64encode(json.dumps({'sub':'attacker','tenant_id':\"bula-pesa'; DROP TABLE tenants; --\",'exp':9999999999}).encode()).rstrip(b'=').decode()
sig = base64.urlsafe_b64encode(hmac.new(secret, f'{header}.{payload}'.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
print(f'{header}.{payload}.{sig}')" > /tmp/forged.txt
TOK=$(head -1 /tmp/forged.txt)

curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:3000/api/ground-truth/recent
# Expected: {"error":"Failed to load ground truth"}

# Confirm the tenants table is still there
PGPASSWORD=ardalink_dev_only psql -h 127.0.0.1 -p 15432 -U ardalink -d ardalink -tAc \
  "SELECT count(*) FROM public.tenants"
# Expected: 3
```

What just happened: the JWT signature is valid (the secret was
correct), so the api accepts the request. The malicious `tenant_id`
claim then reaches `withTenantContext`, which runs it through
`safeTenantId()` in `ardalink-api/src/lib/tenancy-context.ts:14`.
The regex `/^[a-z0-9-]{1,64}$/` rejects the value before it can
be inlined into a `SET LOCAL` SQL statement. The route handler
catches the error and returns 500. The data was never returned.

### Cross-tenant proof (the headline test)

```bash
cd ardalink-api/docs/local-dev

# All three tokens, same query, different results
for tenant in bula-pesa garbatulla merti; do
  TOK=$(make token T=$tenant 2>/dev/null)
  COUNT=$(curl -s -H "Authorization: Bearer $TOK" \
    'http://127.0.0.1:3000/api/ground-truth/recent?limit=100' \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
  echo "$tenant: $COUNT reports visible"
done
# Expected: 12 / 12 / 12 — three different logins, no overlap
```

### Verifying the engine separately

The engine doesn't trust browsers directly. It only answers requests
from the api. You can prove the engine works on its own:

```bash
curl -s http://127.0.0.1:5001/health
# {"status":"ok","service":"ArdaLink Biophysical Data Engine","version":"1.0.0"}

# Direct call (no JWT) — engine answers on its private port
curl -s -X POST http://127.0.0.1:5001/api/v1/conditions \
  -H "Content-Type: application/json" \
  -d '{"latitude": 0.355, "longitude": 37.583}'
# If this returns 404, fine — the route may be gated. The point is
# the engine listens on a separate port and uses its own auth.
```

### Verifying the build artifacts

The Dockerfiles are not run in local-dev (we use the source code
directly), but you can build them to confirm:

```bash
cd ardalink-engine
docker build -t ardalink-engine:test .
# Should complete in < 60s

cd ../ardalink-api
docker build -t ardalink-api:test .
# Should complete in < 90s

cd ../ardalink-web
docker build -t ardalink-web:test .
# Should complete in < 120s
```

If any of these fail, the migration PR has a build issue.

---

## 4. Where to look when something is wrong

| Symptom | First place to look |
|---|---|
| `make verify` fails a port check | Something else is on that port. `ss -tlnp` to see. |
| API returns 401 on a valid token | `JWT_SECRET` differs between api and your shell. Both must read from the same `.env`. |
| API returns 500 on `/api/ground-truth/recent` | `tail -50 /tmp/ardalink-local/api.log`. Usually a RLS or migration drift. |
| Engine won't start | `tail -50 /tmp/ardalink-local/engine.log`. Usually a missing dep (uv sync) or stale `.venv`. |
| Cross-tenant count > 12 for a tenant | `psql` directly: `SELECT tenant_id, count(*) FROM public.ground_truth_reports GROUP BY tenant_id`. If you see > 12 per tenant, the seed ran twice. `TRUNCATE public.ground_truth_reports RESTART IDENTITY` then re-seed. |
| Build fails for a Docker image | The migration branch may not have a `Dockerfile` for that repo yet. Check `ls ardalink-engine/Dockerfile` etc. |
| Stack is wedged after a crash | `make down && make up`. The `stop-local.sh` is aggressive about killing stragglers. |

## 5. Stop (1 min)

```bash
make down     # stop services + remove Docker containers
make clean    # optional: also remove the volumes (deletes all demo data)
```

## 6. What to read next

| Question | Read |
|---|---|
| How does the API work end-to-end? | `ardalink-api/docs/01-ARCHITECTURE.md` |
| What's the security model? | `ardalink-api/docs/04-SECURITY.md` |
| What does the API cost to run? | `ardalink-api/docs/06-COSTS.md` |
| How is the data observed in prod? | `ardalink-api/docs/05-OBSERVABILITY.md` |
| Where's the CTO brief? | `ardalink-api/docs/00-EXECUTIVE-INDEX.md` |
| What was broken and how was it fixed? | `ardalink-internal/docs/issues-and-fixes.md` |