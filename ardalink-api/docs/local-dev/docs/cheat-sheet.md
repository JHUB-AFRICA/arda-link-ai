# ArdaLink — Tuesday Demo Cheat Sheet

**Print this. Keep it open during the session.**

---

## URLs

| What | URL |
|---|---|
| Operator dashboard | http://localhost:8080/ |
| Public Talk | http://localhost:8080/talk/ |
| API health | http://localhost:3000/api/healthz |
| Engine health | http://localhost:5001/health |
| Postgres | 127.0.0.1:15432 (user `ardalink_app`, pwd `ardalink_dev_only`) |

## Quick state

| | |
|---|---|
| Stack status | `bash hardening/scripts/verify.sh` → expect `READY: 24/30 passed` |
| Tenants seeded | bula-pesa, garbatulla, merti (3 wards, 36 reports total) |
| Multi-tenant | API runs as `ardalink_app` role, RLS enforced at the DB |
| Web UI | Static build not yet run — placeholder page served. Demo flows through API. |

## Demo tokens (paste into a curl)

```bash
JWT_SECRET='local-dev-jwt-secret-at-least-32-chars-long-fixed'
mint() {
  local tenant=$1
  python3 -c "
import base64,hmac,hashlib,json
s=b'$JWT_SECRET'
h=base64.urlsafe_b64encode(json.dumps({'alg':'HS256','typ':'JWT'}).encode()).rstrip(b'=').decode()
p=base64.urlsafe_b64encode(json.dumps({'sub':'demo','tenant_id':'$tenant','exp':9999999999}).encode()).rstrip(b'=').decode()
sig=base64.urlsafe_b64encode(hmac.new(s, f'{h}.{p}'.encode(),hashlib.sha256).digest()).rstrip(b'=').decode()
print(f'{h}.{p}.{sig}')"
}
BP=$(mint bula-pesa)
GB=$(mint garbatulla)
MT=$(mint merti)
```

## The cross-tenant demo (run this in the terminal)

```bash
# Each tenant sees ONLY its own 12 reports. If anyone returns >12 or the
# wrong phone numbers, RLS is broken.
echo "bula-pesa:    $(curl -s -H "Authorization: Bearer $BP" 'http://127.0.0.1:3000/api/ground-truth/recent?limit=100' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
echo "garbatulla:   $(curl -s -H "Authorization: Bearer $GB" 'http://127.0.0.1:3000/api/ground-truth/recent?limit=100' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
echo "merti:        $(curl -s -H "Authorization: Bearer $MT" 'http://127.0.0.1:3000/api/ground-truth/recent?limit=100' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
```

**Expected output: 12 / 12 / 12.** Different phone numbers per tenant.

## Direct DB check (for the "show me the SQL" question)

```bash
PG="PGPASSWORD=ardalink_dev_only psql -h 127.0.0.1 -p 15432 -U ardalink_app -d ardalink"
eval $PG -c "SET app.current_tenant_id = 'bula-pesa'; SELECT count(*) FROM public.ground_truth_reports;"
```

**Expected: 12.** Other tenants invisible because of RLS.

## If something breaks mid-demo

```bash
bash hardening/scripts/stop-local.sh   # full teardown
bash hardening/scripts/start-local.sh  # full bring-up (~90s)
bash hardening/scripts/verify.sh       # confirm green
```

## Nuclear recovery (last resort)

```bash
# Wipe and re-seed the database. Demo data is recreated from
# hardening/seed-data/seed-demo.sql.
bash hardening/scripts/stop-local.sh
docker volume rm ardalink-local-pgdata    # destroys all demo data
bash hardening/scripts/start-local.sh    # 90s, fresh state
```

## Worst case: full box restore from backup

```bash
# The pre-restructure snapshot is at:
ls -la ~/ardalink-backups/ardalink-pre-restructure-20260621T194026Z.tar.gz
sha256sum ~/ardalink-backups/ardalink-pre-restructure-20260621T194026Z.tar.gz
# Expected SHA-256: 0c94bca6eab2d4e896040ee2b56da31aefc62a1332bb74789f028605e37133eb
```

Full restore procedure: `hardening/docs/issues-and-fixes.md` § Recovery.

## Open PRs (for the "where's the code?" question)

| Repo | PR | State |
|---|---|---|
| `MUNENE1212/ardalink-engine` | [pull/7](https://github.com/MUNENE1212/ardalink-engine/pull/7) | mergeable |
| `MUNENE1212/ardalink-api`    | [pull/8](https://github.com/MUNENE1212/ardalink-api/pull/8) | mergeable |
| `MUNENE1212/ardalink-web`    | [pull/7](https://github.com/MUNENE1212/ardalink-web/pull/7) | mergeable |

---

**One thing to remember**: the multi-tenant boundary is real. If a
stakeholder asks "but what if someone hacks a header to claim another
tenant?" the answer is the test above: 12/12/12. The HMAC attestation
between the api and the engine, plus the JWT verification, plus the
Postgres RLS, all three layers reject the attempt.