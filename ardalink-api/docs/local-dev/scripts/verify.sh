#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# verify.sh — One-command pre-flight check for the local stack.
#
# Reads POSTGRES_PASSWORD and JWT_SECRET from .env (or env vars).
# No secrets are written or persisted by this script.
# -----------------------------------------------------------------------------
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="${REPO_ROOT:-$(dirname "$(dirname "$PUBLIC_DIR")")/..}"

# Load .env if present
if [ -f "$PUBLIC_DIR/.env" ]; then
  set -a; . "$PUBLIC_DIR/.env"; set +a
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0
pass()  { PASS=$((PASS+1)); printf "  ${GREEN}✓${NC} %s\n" "$1"; }
fail()  { FAIL=$((FAIL+1)); printf "  ${RED}✗${NC} %s\n" "$1"; }
warn()  { WARN=$((WARN+1)); printf "  ${YELLOW}!${NC} %s\n" "$1"; }
header(){ printf "\n${BOLD}${BLUE}== %s ==${NC}\n" "$1"; }
need()  { command -v "$1" >/dev/null 2>&1; }

POSTGRES_PORT="${POSTGRES_PORT:-15432}"
JWT_SECRET="${JWT_SECRET:-local-dev-jwt-secret-at-least-32-chars-long-fixed}"

# ---------------------------------------------------------------------------
header "Tools"
# ---------------------------------------------------------------------------
for tool in docker pnpm uv psql curl jq; do
  if need "$tool"; then pass "$tool installed"; else fail "$tool NOT installed"; fi
done

# ---------------------------------------------------------------------------
header "Ports"
# ---------------------------------------------------------------------------
check_port() {
  local port=$1 label=$2
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    warn "$label (port $port) is occupied (may be our own service)"
  else
    pass "$label (port $port) is free"
  fi
}
check_port 3000  "ardalink-api"
check_port 5001  "ardalink-engine"
check_port $POSTGRES_PORT "postgres (host)"
check_port 6379  "redis"
check_port 8080  "ardalink-web"

# ---------------------------------------------------------------------------
header "Docker"
# ---------------------------------------------------------------------------
if need docker; then
  if docker info >/dev/null 2>&1; then pass "docker daemon reachable"; else fail "docker daemon NOT reachable"; fi
fi

# ---------------------------------------------------------------------------
header "Services"
# ---------------------------------------------------------------------------
check_http() {
  local url=$1 label=$2 want_status=$3
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" 2>/dev/null || echo "000")
  if [ "$code" = "$want_status" ]; then pass "$label ($url) → $code"; else fail "$label ($url) → expected $want_status got $code"; fi
}
check_post() {
  local url=$1 label=$2 want_status=$3
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "sessionId=verify" "$url" 2>/dev/null || echo "000")
  if [ "$code" = "$want_status" ]; then pass "$label ($url) POST → $code"; else fail "$label ($url) POST → expected $want_status got $code"; fi
}
check_http "http://localhost:3000/api/healthz" "ardalink-api healthz" 200
check_http "http://localhost:5001/health"        "ardalink-engine health" 200
check_http "http://localhost:8080/"               "ardalink-web root"     200
check_http "http://localhost:8080/talk/"          "ardalink-web talk"     200

# Public-by-contract endpoints — must NOT return 401 (which would
# indicate the tenant middleware accidentally locked them behind
# auth).
check_http "http://localhost:3000/api/public-talk/status" "public-talk status (public)" 200
# Africa's Talking webhooks — POST, no auth. Anything except 401 means
# the path is reachable from AT. Empty bodies are accepted for all
# four (the route handlers default phone numbers to +254711082200).
check_post "http://localhost:3000/api/voice-callback"  "voice-callback (public, AT)" 200
check_post "http://localhost:3000/api/voice-events"    "voice-events (public, AT)"   200
check_post "http://localhost:3000/api/ussd-callback"   "ussd-callback (public, AT)"  200
check_post "http://localhost:3000/api/sms-callback"    "sms-callback (public, AT)"   200
check_http "http://localhost:3000/api/call-tokens/zzz-noauth-lookups-allowed" "call-tokens lookup (public)" 200

# Full AT webhook contract — drives the same flow the sandbox simulator
# does, but checks the response bodies are the AT-spec shapes
# (<Stream> XML, CON/END, single-segment SMS).
header "AT sandbox webhook contract"
ussd_reply=$(curl -s -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "sessionId=verify-ussd&serviceCode=*123*8%23&phoneNumber=%2B254711082200&text=" \
  http://localhost:3000/api/ussd-callback)
if echo "$ussd_reply" | grep -q "^CON " && echo "$ussd_reply" | grep -q "Bula Pesa"; then
  pass "USSD home menu returns CON + menu"
else
  fail "USSD home menu shape wrong: $(echo "$ussd_reply" | head -1 | cut -c1-80)"
fi
sms_reply=$(curl -s -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "from=%2B254711082200&to=%2B254711082200&text=STOP&id=verify-sms" \
  http://localhost:3000/api/sms-callback)
if [ -z "$sms_reply" ]; then
  pass "SMS STOP returns empty body (no auto-reply)"
else
  fail "SMS STOP should return empty, got: $(echo "$sms_reply" | head -c 80)"
fi
voice_reply=$(curl -s -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "destinationNumber=%2B254711082200&sessionId=verify-voice" \
  http://localhost:3000/api/voice-callback)
if echo "$voice_reply" | grep -q "<Response>" && echo "$voice_reply" | grep -q "<Stream"; then
  pass "Voice callback returns <Response><Stream/></Response>"
else
  fail "Voice callback XML shape wrong: $(echo "$voice_reply" | head -c 80)"
fi

# ---------------------------------------------------------------------------
header "Database"
# ---------------------------------------------------------------------------
if need psql; then
  export PGPASSWORD="${POSTGRES_PASSWORD:-ardalink_dev_only}"
  if psql -h 127.0.0.1 -p $POSTGRES_PORT -U ardalink -d ardalink -tAc "SELECT 1" >/dev/null 2>&1; then
    pass "postgres reachable as ardalink"

    if psql -h 127.0.0.1 -p $POSTGRES_PORT -U ardalink -d ardalink -tAc \
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tenants')" \
      | grep -q '^t$'; then
      pass "migrations applied (public.tenants exists)"
    else
      fail "migrations NOT applied (public.tenants missing)"
    fi

    tenant_count=$(psql -h 127.0.0.1 -p $POSTGRES_PORT -U ardalink -d ardalink -tAc \
      "SELECT COUNT(*) FROM public.tenants WHERE tenant_id IN ('bula-pesa','garbatulla','merti')" 2>/dev/null | tr -d ' ')
    if [ "$tenant_count" = "3" ]; then
      pass "3 demo tenants seeded"
    else
      fail "demo tenants: expected 3 found $tenant_count"
    fi

    rls_status=$(psql -h 127.0.0.1 -p $POSTGRES_PORT -U ardalink -d ardalink -tAc \
      "SELECT COALESCE(string_agg(c.relname || '=' || c.relrowsecurity::text || '/' || c.relforcerowsecurity::text, ', '), 'none')
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname IN ('ground_truth_reports','pastoralists','satellite_snapshots','climate_snapshots')" 2>/dev/null)
    if echo "$rls_status" | grep -q 'true/true'; then
      pass "RLS enabled+forced on operational tables"
    else
      fail "RLS not fully enabled: $rls_status"
    fi
  else
    fail "postgres NOT reachable (check POSTGRES_PASSWORD)"
  fi
fi

# ---------------------------------------------------------------------------
header "Auth + Multi-tenant"
# ---------------------------------------------------------------------------
if need curl; then
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/api/whoami)
  if [ "$code" = "401" ]; then pass "/api/whoami rejects unauthenticated (401)"; else fail "/api/whoami: expected 401 got $code"; fi

  if [ -n "$JWT_SECRET" ]; then
    TOKEN=$(python3 - <<PY
import base64, hmac, hashlib, json
secret = "$JWT_SECRET".encode()
header = base64.urlsafe_b64encode(json.dumps({"alg":"HS256","typ":"JWT"}).encode()).rstrip(b'=').decode()
payload = base64.urlsafe_b64encode(json.dumps({"sub":"verify","tenant_id":"bula-pesa","exp":9999999999}).encode()).rstrip(b'=').decode()
sig = base64.urlsafe_b64encode(hmac.new(secret, f"{header}.{payload}".encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
print(f"{header}.{payload}.{sig}")
PY
)
    out=$(curl -s --max-time 3 -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/whoami)
    if echo "$out" | grep -q '"tenant_id":"bula-pesa"'; then
      pass "/api/whoami returns tenant_id with valid token"
    else
      fail "/api/whoami: $out"
    fi

    TOKEN2=$(python3 - <<PY
import base64, hmac, hashlib, json
secret = "$JWT_SECRET".encode()
header = base64.urlsafe_b64encode(json.dumps({"alg":"HS256","typ":"JWT"}).encode()).rstrip(b'=').decode()
payload = base64.urlsafe_b64encode(json.dumps({"sub":"verify","tenant_id":"garbatulla","exp":9999999999}).encode()).rstrip(b'=').decode()
sig = base64.urlsafe_b64encode(hmac.new(secret, f"{header}.{payload}".encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
print(f"{header}.{payload}.{sig}")
PY
)
    out2=$(curl -s --max-time 3 -H "Authorization: Bearer $TOKEN2" http://localhost:3000/api/whoami)
    if echo "$out2" | grep -q '"tenant_id":"garbatulla"'; then
      pass "JWT claim is honored per-request (no upstream tampering)"
    else
      fail "JWT claim not honored: $out2"
    fi

    # RLS isolation
    bp_rows=$(curl -s --max-time 5 -H "Authorization: Bearer $TOKEN" \
      'http://localhost:3000/api/ground-truth/recent?limit=100' \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)' 2>/dev/null)
    gb_rows=$(curl -s --max-time 5 -H "Authorization: Bearer $TOKEN2" \
      'http://localhost:3000/api/ground-truth/recent?limit=100' \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)' 2>/dev/null)
    if [ "$bp_rows" -gt 0 ] && [ "$bp_rows" -eq "$gb_rows" ]; then
      pass "RLS isolation: bula-pesa=$bp_rows rows == garbatulla=$gb_rows rows (no cross-tenant leak)"
    else
      fail "RLS isolation broken: bula-pesa=$bp_rows, garbatulla=$gb_rows"
    fi
  else
    warn "JWT_SECRET not set — skipping token tests"
  fi
fi

# ---------------------------------------------------------------------------
header "Tests"
# ---------------------------------------------------------------------------
run_tests() {
  local name=$1 dir=$2
  if [ -d "$REPO_ROOT/$dir" ]; then
    if (cd "$REPO_ROOT/$dir" && pnpm run test >/dev/null 2>&1); then
      pass "$name tests pass"
    else
      fail "$name tests FAIL"
    fi
  else
    warn "$name repo not found at $dir"
  fi
}
run_tests "ardalink-api" "ardalink-api"
run_tests "ardalink-web" "ardalink-web"
if [ -d "$REPO_ROOT/ardalink-engine" ]; then
  # Ensure dev deps (pytest) are installed before running tests.
  (cd "$REPO_ROOT/ardalink-engine" && uv sync --extra dev >/dev/null 2>&1) || true
  if (cd "$REPO_ROOT/ardalink-engine" && uv run pytest -q >/dev/null 2>&1); then
    pass "ardalink-engine tests pass (pytest)"
  else
    fail "ardalink-engine tests FAIL"
  fi
fi

# ---------------------------------------------------------------------------
header "Summary"
# ---------------------------------------------------------------------------
TOTAL=$((PASS + FAIL + WARN))
if [ "$FAIL" = "0" ]; then
  printf "${GREEN}${BOLD}  READY: %d/%d passed (%d warnings)${NC}\n" "$PASS" "$TOTAL" "$WARN"
  [ "$WARN" != "0" ] && printf "${YELLOW}  Warnings are non-blocking but worth a look.${NC}\n"
  exit 0
else
  printf "${RED}${BOLD}  NOT READY: %d failures, %d warnings${NC}\n" "$FAIL" "$WARN"
  printf "${RED}  Fix the failures above before the demo.${NC}\n"
  exit 1
fi