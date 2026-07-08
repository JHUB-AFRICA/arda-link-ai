#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# start-local.sh — One-command local stack bring-up.
#
# Public script — no baked secrets. All credentials come from .env
# (gitignored) or environment variables. If .env doesn't exist, a
# safe dev-only default is written automatically and a warning is
# printed.
#
# Idempotent: stops existing stack first, then starts.
# -----------------------------------------------------------------------------
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DIR="$(dirname "$SCRIPT_DIR")"
# REPO_ROOT is the directory that contains the three repos as siblings:
#   ardalink-api/  ardalink-engine/  ardalink-web/
# The Makefile sets this explicitly. Default to looking two dirs up from
# the public folder, which is the canonical layout.
REPO_ROOT="${REPO_ROOT:-$(dirname "$(dirname "$PUBLIC_DIR")")/..}"

# ---------------------------------------------------------------------------
# 0. Load .env (or generate a dev-only one)
# ---------------------------------------------------------------------------
ENV_FILE="$PUBLIC_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  if [ ! -f "$PUBLIC_DIR/.env.example" ]; then
    echo "FATAL: missing $PUBLIC_DIR/.env.example" >&2
    exit 1
  fi
  echo "  ! $ENV_FILE missing — writing dev-only defaults"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ardalink_dev_only}"
  JWT_SECRET="${JWT_SECRET:-local-dev-jwt-secret-at-least-32-chars-long-fixed}"
  TENANT_ATTESTATION_SECRET="${TENANT_ATTESTATION_SECRET:-local-dev-attestation-secret-32-chars-min-fixed}"
  SESSION_SECRET="${SESSION_SECRET:-local-dev-session-secret-32-chars-long-fixed}"
  cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
TENANT_ATTESTATION_SECRET=${TENANT_ATTESTATION_SECRET}
SESSION_SECRET=${SESSION_SECRET}
EOF
  chmod 600 "$ENV_FILE"
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

RUN_DIR=/tmp/ardalink-local
mkdir -p "$RUN_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

step() { printf "\n${BOLD}${BLUE}▶ %s${NC}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
err()  { printf "  ${RED}✗ %s${NC}\n" "$1"; }

# ---------------------------------------------------------------------------
# 1. Stop any previous run
# ---------------------------------------------------------------------------
step "Stopping any previous stack"
for name in api engine web; do
  if [ -f "$RUN_DIR/$name.pid" ]; then
    pid=$(cat "$RUN_DIR/$name.pid")
    kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null && sleep 0.5
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$RUN_DIR/$name.pid"
  fi
done
docker stop ardalink-local-postgres ardalink-local-redis 2>/dev/null || true
docker rm   ardalink-local-postgres ardalink-local-redis 2>/dev/null || true
ok "previous processes cleaned"

# ---------------------------------------------------------------------------
# 2. Postgres + Redis
# ---------------------------------------------------------------------------
step "Postgres (Docker)"
docker run -d \
  --name ardalink-local-postgres \
  --restart unless-stopped \
  -e POSTGRES_USER=ardalink \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_DB=ardalink \
  -p 127.0.0.1:15432:5432 \
  -v ardalink-local-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine > "$RUN_DIR/postgres.log" 2>&1
for i in $(seq 1 30); do
  docker exec ardalink-local-postgres pg_isready -U ardalink -d ardalink >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = "30" ] && { err "postgres not ready"; tail -30 "$RUN_DIR/postgres.log"; exit 1; }
done
ok "postgres ready"

step "Redis (Docker)"
docker run -d \
  --name ardalink-local-redis \
  --restart unless-stopped \
  -p 127.0.0.1:6379:6379 \
  -v ardalink-local-redisdata:/data \
  redis:7-alpine > "$RUN_DIR/redis.log" 2>&1
for i in $(seq 1 15); do
  docker exec ardalink-local-redis redis-cli ping 2>/dev/null | grep -q PONG && break
  sleep 1
done
ok "redis ready"

# ---------------------------------------------------------------------------
# 3. Migrations + app role + seed
# ---------------------------------------------------------------------------
export PGHOST=127.0.0.1
export PGPORT=15432
export PGUSER=ardalink
export PGDATABASE=ardalink
export PGPASSWORD="$POSTGRES_PASSWORD"

step "Migrations + role"

# Create a non-superuser application role so RLS actually applies
psql -v ON_ERROR_STOP=1 <<SQL > "$RUN_DIR/migrate-role.log" 2>&1
DO \$\$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ardalink_app') THEN
      CREATE ROLE ardalink_app LOGIN PASSWORD '${POSTGRES_PASSWORD}'
        NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
   END IF;
END
\$\$;
GRANT CONNECT, CREATE ON DATABASE ardalink TO ardalink_app;
GRANT USAGE, CREATE ON SCHEMA public, gis_engine TO ardalink_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public, gis_engine TO ardalink_app;
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public, gis_engine TO ardalink_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ardalink_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA gis_engine
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ardalink_app;
SQL
ok "app role ardalink_app (no BYPASSRLS)"

for m in "$PUBLIC_DIR"/migrations/*.up.sql; do
  psql -v ON_ERROR_STOP=1 -f "$m" > "$RUN_DIR/migrate-$(basename "$m").log" 2>&1 \
    || { err "migration failed: $m"; tail -20 "$RUN_DIR/migrate-$(basename "$m").log"; exit 1; }
  ok "$(basename "$m") applied"
done

step "Seed demo data"
psql -v ON_ERROR_STOP=1 -f "$PUBLIC_DIR/seed-data/seed-demo.sql" \
  > "$RUN_DIR/seed.log" 2>&1 \
  || { err "seed failed"; tail -30 "$RUN_DIR/seed.log"; exit 1; }
ok "demo data seeded"

# ---------------------------------------------------------------------------
# 4. Engine
# ---------------------------------------------------------------------------
step "ardalink-engine"
[ -d "$REPO_ROOT/ardalink-engine" ] || { err "ardalink-engine repo not found at $REPO_ROOT"; exit 1; }

# Pull GEE creds from ardalink-engine/.env (dev only, never committed).
_ENG_ENV="$REPO_ROOT/ardalink-engine/.env"
_ENG_GEE_SA="$(grep -E '^GEE_SERVICE_ACCOUNT=' "$_ENG_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)"
_ENG_GEE_KEY="$(grep -E '^GEE_PRIVATE_KEY=' "$_ENG_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)"
_ENG_GEE_PROJECT="$(grep -E '^GEE_PROJECT=' "$_ENG_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)"
[ -z "$_ENG_GEE_SA" ] && _ENG_GEE_SA=""
[ -z "$_ENG_GEE_KEY" ] && _ENG_GEE_KEY=""
[ -z "$_ENG_GEE_PROJECT" ] && _ENG_GEE_PROJECT=""
# Wrap the JSON value in single quotes so bash can source it without
# choking on commas, colons, and braces in the JSON body.
_ENG_GEE_KEY_ESC="${_ENG_GEE_KEY//\'/\'\\\'\'}"

cat > "$RUN_DIR/engine.env" <<EOF
DATABASE_URL=postgresql://ardalink:${POSTGRES_PASSWORD}@127.0.0.1:15432/ardalink
GIS_ENGINE_SCHEMA=gis_engine
ARDALINK_HOST=127.0.0.1
ARDALINK_PORT=5001
ARDALINK_LOG_LEVEL=INFO
TENANT_ATTESTATION_SECRET=${TENANT_ATTESTATION_SECRET}
GEE_SERVICE_ACCOUNT=${_ENG_GEE_SA}
GEE_PRIVATE_KEY='${_ENG_GEE_KEY_ESC}'
GEE_PROJECT=${_ENG_GEE_PROJECT}
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_KEY=
AZURE_OPENAI_DEPLOYMENT=gpt-4o
INGEST_SCHEDULER_ENABLED=0
EOF
( cd "$REPO_ROOT/ardalink-engine" && set -a; . "$RUN_DIR/engine.env"; set +a
  nohup uv run python -m ardalink_engine.main > "$RUN_DIR/engine.log" 2>&1 & echo $! > "$RUN_DIR/engine.pid" )
ok "started"

# Engine cold-start can take 20-30s on first run (uv resolves deps,
# builds the editable install, then uvicorn binds). Give it 60s.
for i in $(seq 1 120); do
  curl -s --max-time 2 http://127.0.0.1:5001/health 2>/dev/null | grep -q '"ok"' \
    && { ok "engine healthy (after $((i/2))s)"; break; }
  sleep 0.5
  [ "$i" = "120" ] && { err "engine did not respond in 60s"; tail -30 "$RUN_DIR/engine.log"; exit 1; }
done

# ---------------------------------------------------------------------------
# 5. API
# ---------------------------------------------------------------------------
step "ardalink-api"
[ -d "$REPO_ROOT/ardalink-api" ] || { err "ardalink-api repo not found at $REPO_ROOT"; exit 1; }

# API uses the non-superuser role so RLS is enforced
# Pull GEE creds from local-dev/.env (if set) so dev can hit real GEE.
# Wrap the JSON value in single quotes so bash can source it without
# choking on commas, colons, and braces in the JSON body.
_GEE_JSON="$(grep -E '^GOOGLE_SERVICE_ACCOUNT_JSON=' "$PUBLIC_DIR/.env" | tail -1 | cut -d= -f2-)"
_GEE_PROJECT="$(grep -E '^GEE_PROJECT=' "$PUBLIC_DIR/.env" | tail -1 | cut -d= -f2-)"
[ -z "$_GEE_JSON" ] && _GEE_JSON=""
[ -z "$_GEE_PROJECT" ] && _GEE_PROJECT=""
# Escape any single-quotes inside the JSON (none expected, but safe).
_GEE_JSON_ESC="${_GEE_JSON//\'/\'\\\'\'}"

# LLM keys for Z.ai and Minimax
_ZAI_KEY="$(grep -E '^ZAI_API_KEY=' "$PUBLIC_DIR/.env" | tail -1 | cut -d= -f2-)"
_ZAI_MODEL="$(grep -E '^ZAI_DEFAULT_MODEL=' "$PUBLIC_DIR/.env" | tail -1 | cut -d= -f2-)"
_MINIMAX_KEY="$(grep -E '^MINIMAX_API_KEY=' "$PUBLIC_DIR/.env" | tail -1 | cut -d= -f2-)"
_MINIMAX_MODEL="$(grep -E '^MINIMAX_DEFAULT_MODEL=' "$PUBLIC_DIR/.env" | tail -1 | cut -d= -f2-)"
_LLM_PRIMARY="$(grep -E '^LLM_PRIMARY_PROVIDER=' "$PUBLIC_DIR/.env" | tail -1 | cut -d= -f2-)"
_LLM_FALLBACK="$(grep -E '^LLM_FALLBACK_PROVIDER=' "$PUBLIC_DIR/.env" | tail -1 | cut -d= -f2-)"
[ -z "$_ZAI_KEY" ] && _ZAI_KEY=""
[ -z "$_ZAI_MODEL" ] && _ZAI_MODEL="glm-4.5-flash"
[ -z "$_MINIMAX_KEY" ] && _MINIMAX_KEY=""
[ -z "$_MINIMAX_MODEL" ] && _MINIMAX_MODEL="MiniMax-M3"
[ -z "$_LLM_PRIMARY" ] && _LLM_PRIMARY="z"
[ -z "$_LLM_FALLBACK" ] && _LLM_FALLBACK="minimax"

# Azure AI Foundry (chat + Realtime) and Azure Speech (STT/TTS)
# Pull from local-dev/.env so the api process picks them up. Trim any
# accidental trailing whitespace; strip inline shell-style comments.
_read_env() {
  local key="$1"
  grep -E "^${key}=" "$PUBLIC_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed 's/[[:space:]]*#.*$//' | sed 's/[[:space:]]*$//'
}
_AZ_OPENAI_ENDPOINT="$(_read_env AZURE_OPENAI_ENDPOINT)"
_AZ_OPENAI_FOUNDRY_ENDPOINT="$(_read_env AZURE_OPENAI_FOUNDRY_ENDPOINT)"
_AZ_OPENAI_KEY="$(_read_env AZURE_OPENAI_API_KEY)"
_AZ_OPENAI_CHAT_DEPLOY="$(_read_env AZURE_OPENAI_CHAT_DEPLOYMENT)"
_AZ_OPENAI_CHAT_APIVER="$(_read_env AZURE_OPENAI_CHAT_API_VERSION)"
_AZ_OPENAI_RT_DEPLOY="$(_read_env AZURE_OPENAI_REALTIME_DEPLOYMENT)"
_AZ_OPENAI_RT_APIVER="$(_read_env AZURE_OPENAI_REALTIME_API_VERSION)"
_AZ_OPENAI_WHISPER="$(_read_env AZURE_OPENAI_WHISPER_DEPLOYMENT)"
_AZ_SPEECH_KEY="$(_read_env AZURE_SPEECH_KEY)"
_AZ_SPEECH_KEY2="$(_read_env AZURE_SPEECH_KEY_SECONDARY)"
_AZ_SPEECH_REGION="$(_read_env AZURE_SPEECH_REGION)"
_AZ_SPEECH_ENDPOINT="$(_read_env AZURE_SPEECH_ENDPOINT)"
_AZ_SPEECH_VOICE_SW="$(_read_env AZURE_SPEECH_TTS_VOICE_SW)"
_AZ_SPEECH_VOICE_EN="$(_read_env AZURE_SPEECH_TTS_VOICE_EN)"
_AZ_SPEECH_LANGS="$(_read_env AZURE_SPEECH_STT_LANGUAGES)"
[ -z "$_AZ_OPENAI_CHAT_DEPLOY" ] && _AZ_OPENAI_CHAT_DEPLOY="gpt-5-mini"
[ -z "$_AZ_OPENAI_CHAT_APIVER" ] && _AZ_OPENAI_CHAT_APIVER="2024-10-21"
[ -z "$_AZ_OPENAI_RT_DEPLOY" ] && _AZ_OPENAI_RT_DEPLOY="gpt-4o-realtime-preview"
[ -z "$_AZ_OPENAI_RT_APIVER" ] && _AZ_OPENAI_RT_APIVER="2025-04-01-preview"
[ -z "$_AZ_OPENAI_WHISPER" ] && _AZ_OPENAI_WHISPER="whisper"
[ -z "$_AZ_SPEECH_VOICE_SW" ] && _AZ_SPEECH_VOICE_SW="sw-KE-ZuriNeural"
[ -z "$_AZ_SPEECH_VOICE_EN" ] && _AZ_SPEECH_VOICE_EN="en-KE-AsiliaNeural"
[ -z "$_AZ_SPEECH_LANGS" ] && _AZ_SPEECH_LANGS="sw-KE,en-KE"

# Supabase — shared reference-data + operational primary
_SUPABASE_URL="$(_read_env SUPABASE_URL)"
_SUPABASE_KEY="$(_read_env SUPABASE_SECRET_KEY)"
_SUPABASE_ANON="$(_read_env SUPABASE_ANON_KEY)"
_SUPABASE_TO_INT="$(_read_env SUPABASE_TIMEOUT_INTERACTIVE_MS)"
_SUPABASE_TO_BATCH="$(_read_env SUPABASE_TIMEOUT_BATCH_MS)"
[ -z "$_SUPABASE_TO_INT" ] && _SUPABASE_TO_INT="2500"
[ -z "$_SUPABASE_TO_BATCH" ] && _SUPABASE_TO_BATCH="8000"

cat > "$RUN_DIR/api.env" <<EOF
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
DATABASE_URL=postgresql://ardalink_app:${POSTGRES_PASSWORD}@127.0.0.1:15432/ardalink
COSMOS_DB_ENDPOINT=
COSMOS_DB_PRIMARY_KEY=
AZURE_OPENAI_FOUNDRY_ENDPOINT=${_AZ_OPENAI_FOUNDRY_ENDPOINT}
AZURE_OPENAI_ENDPOINT=${_AZ_OPENAI_ENDPOINT}
AZURE_OPENAI_API_KEY=${_AZ_OPENAI_KEY}
AZURE_OPENAI_CHAT_DEPLOYMENT=${_AZ_OPENAI_CHAT_DEPLOY}
AZURE_OPENAI_CHAT_API_VERSION=${_AZ_OPENAI_CHAT_APIVER}
AZURE_OPENAI_REALTIME_DEPLOYMENT=${_AZ_OPENAI_RT_DEPLOY}
AZURE_OPENAI_REALTIME_API_VERSION=${_AZ_OPENAI_RT_APIVER}
AZURE_OPENAI_WHISPER_DEPLOYMENT=${_AZ_OPENAI_WHISPER}
AZURE_SPEECH_KEY=${_AZ_SPEECH_KEY}
AZURE_SPEECH_KEY_SECONDARY=${_AZ_SPEECH_KEY2}
AZURE_SPEECH_REGION=${_AZ_SPEECH_REGION}
AZURE_SPEECH_ENDPOINT=${_AZ_SPEECH_ENDPOINT}
AZURE_SPEECH_TTS_VOICE_SW=${_AZ_SPEECH_VOICE_SW}
AZURE_SPEECH_TTS_VOICE_EN=${_AZ_SPEECH_VOICE_EN}
AZURE_SPEECH_STT_LANGUAGES=${_AZ_SPEECH_LANGS}
SUPABASE_URL=${_SUPABASE_URL}
SUPABASE_SECRET_KEY=${_SUPABASE_KEY}
SUPABASE_ANON_KEY=${_SUPABASE_ANON}
SUPABASE_TIMEOUT_INTERACTIVE_MS=${_SUPABASE_TO_INT}
SUPABASE_TIMEOUT_BATCH_MS=${_SUPABASE_TO_BATCH}
DETERMINISTIC_TENANT_ID=bula-pesa
GOOGLE_SERVICE_ACCOUNT_JSON='${_GEE_JSON_ESC}'
GEE_PROJECT=${_GEE_PROJECT}
AFRICASTALKING_USERNAME=sandbox
AFRICASTALKING_API_KEY=
AFRICASTALKING_CALLER_ID=+254700000000
RECIPIENT_PHONE=+254700000000
SESSION_SECRET=${SESSION_SECRET}
JWT_SECRET=${JWT_SECRET}
TENANT_ATTESTATION_SECRET=${TENANT_ATTESTATION_SECRET}
ZAI_API_KEY=${_ZAI_KEY}
ZAI_DEFAULT_MODEL=${_ZAI_MODEL}
MINIMAX_API_KEY=${_MINIMAX_KEY}
MINIMAX_DEFAULT_MODEL=${_MINIMAX_MODEL}
LLM_PRIMARY_PROVIDER=${_LLM_PRIMARY}
LLM_FALLBACK_PROVIDER=${_LLM_FALLBACK}
LLM_TIMEOUT_MS=90000
LLM_CACHE_TTL_SECONDS=300
LLM_DAILY_TOKEN_BUDGET=100000
EOF
( cd "$REPO_ROOT/ardalink-api" && set -a && . "$RUN_DIR/api.env" && set +a &&
  nohup pnpm run dev > "$RUN_DIR/api.log" 2>&1 & echo $! > "$RUN_DIR/api.pid" )
ok "started"

for i in $(seq 1 60); do
  curl -s --max-time 2 http://127.0.0.1:3000/api/healthz 2>/dev/null | grep -q '"ok"' \
    && { ok "api healthy (after $((i/2))s)"; break; }
  sleep 0.5
  [ "$i" = "60" ] && { err "api did not respond in 30s"; tail -30 "$RUN_DIR/api.log"; exit 1; }
done

# ---------------------------------------------------------------------------
# 6. Web (static)
# ---------------------------------------------------------------------------
step "ardalink-web (static build)"

cat > "$RUN_DIR/web-server.py" <<'PYEOF'
import http.server, socketserver, urllib.request
from pathlib import Path

WEB = Path("/tmp/ardalink-local/web")
DASH = WEB / "dashboard"
TALK = WEB / "talk"
PORT = 8080
API_UPSTREAM = "http://127.0.0.1:3000"

class H(http.server.SimpleHTTPRequestHandler):
    def _send_static(self, target, ctype=None):
        try:
            data = target.read_bytes()
            ext = target.suffix.lstrip(".")
            ctype = ctype or {
                "html": "text/html; charset=utf-8",
                "js":   "application/javascript; charset=utf-8",
                "mjs":  "application/javascript; charset=utf-8",
                "css":  "text/css; charset=utf-8",
                "json": "application/json",
                "svg":  "image/svg+xml",
                "png":  "image/png",
                "jpg":  "image/jpeg",
                "ico":  "image/x-icon",
                "txt":  "text/plain; charset=utf-8",
                "map":  "application/json",
            }.get(ext, "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(500, str(e))

    def _proxy(self):
        url = API_UPSTREAM + self.path
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=self.command)
        for h in ("Content-Type", "Authorization", "X-Tenant-ID", "X-Tenant-Sig", "Origin", "Cookie"):
            v = self.headers.get(h)
            if v: req.add_header(h, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() in ("transfer-encoding", "connection"):
                        continue
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(r.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for k, v in (e.headers or {}).items():
                if k.lower() in ("transfer-encoding", "connection"):
                    continue
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_error(502, str(e))

    def _serve_app(self, app_dist, title):
        path = self.path.split("?")[0]
        # Strip the URL routing prefix (do_GET dispatches by URL prefix,
        # not by title tokens). Vite emits base=/talk/ so static assets
        # arrive as /talk/assets/index-<hash>.js and must have the /talk/
        # stripped before joining with app_dist. The dashboard is served
        # at / so no prefix strip is needed for that path.
        for prefix in ("/talk/", "/talk"):
            if path.startswith(prefix):
                rel = path[len(prefix):].lstrip("/")
                break
        else:
            rel = path.lstrip("/")
        target = app_dist / rel if rel else app_dist / "index.html"
        if not target.exists() or target.is_dir():
            target = app_dist / "index.html"
        if not target.exists():
            self._send_placeholder(title)
            return
        self._send_static(target)

    def _send_placeholder(self, title):
        placeholder = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font:14px/1.5 system-ui,sans-serif;padding:2rem;max-width:720px;margin:auto;color:#222}}
h1{{margin-top:0}}pre{{background:#f4f4f4;padding:1rem;border-radius:6px;overflow:auto}}</style>
</head><body>
<h1>{title}</h1>
<p>The web app's static bundle has not been built yet. See
<code>docs/local-dev/README.md</code> for the build instructions,
or use the API directly for now.</p>
</body></html>"""
        self._send_static_string(placeholder, "text/html; charset=utf-8")

    def _send_static_string(self, s, ctype):
        data = s.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/") or self.path.startswith("/ws"):
            self._proxy()
            return
        if self.path.startswith("/talk"):
            self._serve_app(TALK, "ArdaLink Talk")
            return
        self._serve_app(DASH, "ArdaLink Operator Dashboard")

    def do_POST(self):
        if self.path.startswith("/api/") or self.path.startswith("/ws"):
            self._proxy()
            return
        self.send_error(404)

    def do_PUT(self):
        if self.path.startswith("/api/"):
            self._proxy()
            return
        self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            self._proxy()
            return
        self.send_error(404)

    def do_PATCH(self):
        if self.path.startswith("/api/"):
            self._proxy()
            return
        self.send_error(404)

    def do_OPTIONS(self):
        # CORS preflight: respond 204 with the headers the browser needs
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Tenant-ID, X-Tenant-Sig")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def log_message(self, *args, **kwargs):
        pass

# allow_reuse_address must be set BEFORE server_bind runs, so patch the
# class attribute rather than the bound instance.
socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as s:
    s.serve_forever()
PYEOF

mkdir -p "$RUN_DIR/web"
[ -d "$REPO_ROOT/ardalink-web/dashboard/dist" ] && ln -snf "$REPO_ROOT/ardalink-web/dashboard/dist" "$RUN_DIR/web/dashboard"
[ -d "$REPO_ROOT/ardalink-web/talk/dist" ]      && ln -snf "$REPO_ROOT/ardalink-web/talk/dist"      "$RUN_DIR/web/talk"

nohup python3 "$RUN_DIR/web-server.py" > "$RUN_DIR/web.log" 2>&1 & echo $! > "$RUN_DIR/web.pid"
ok "started (serving dashboard + talk on :8080)"

# ---------------------------------------------------------------------------
# 7. Done
# ---------------------------------------------------------------------------
cat <<EOF

${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ArdaLink local stack is up
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}

  Dashboard   http://localhost:8080/
  Talk        http://localhost:8080/talk/
  API         http://localhost:3000/api/healthz
  Engine      http://localhost:5001/health
  Postgres    127.0.0.1:15432 (user ardalink / ardalink_app)

  PIDs  in    $RUN_DIR/*.pid
  Logs  in    $RUN_DIR/*.log
  Stop with   scripts/stop-local.sh
  Verify with scripts/verify.sh

EOF

# Print a ready-to-paste demo snippet
cat <<'DEMO'
# Demo tokens (paste in your shell):
DEMO
for t in bula-pesa ngare-mara burat; do
  TOK=$(python3 -c "
import base64,hmac,hashlib,json
s=b'$JWT_SECRET'
h=base64.urlsafe_b64encode(json.dumps({'alg':'HS256','typ':'JWT'}).encode()).rstrip(b'=').decode()
p=base64.urlsafe_b64encode(json.dumps({'sub':'demo','tenant_id':'$t','exp':9999999999}).encode()).rstrip(b'=').decode()
sig=base64.urlsafe_b64encode(hmac.new(s, f'{h}.{p}'.encode(),hashlib.sha256).digest()).rstrip(b'=').decode()
print(f'{h}.{p}.{sig}')")
  printf "%-13s %s\n" "$t" "$TOK"
done
printf "\n# Cross-tenant check (expected: 12 / 12 / 12):\n"
printf "# curl -s -H 'Authorization: Bearer \$TOK' http://127.0.0.1:3000/api/ground-truth/recent?limit=100 | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'\n"