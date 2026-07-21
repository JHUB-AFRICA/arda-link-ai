#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# dryrun-migration-0003.sh — apply 0003_realign_local_mirror to a snapshot
# of the live local DB so the destructive step can be reviewed *before* it
# touches the real container.
#
# Pipeline:
#   1) pg_dump the live ardalink-local-postgres.
#   2) Start ardalink-local-postgres-dryrun on a spare port (15433).
#   3) Restore the dump.
#   4) Snapshot pre-migration counts + schema.
#   5) Apply 0003_realign_local_mirror.up.sql.
#   6) Snapshot post-migration counts + schema.
#   7) Print a diff. Save to /tmp/ardalink-migration-0003-report.md.
#
# Never touches the live container. Safe to re-run — the dryrun
# container is recreated each time.
# -----------------------------------------------------------------------------
set -euo pipefail

SRC_CONTAINER="${SRC_CONTAINER:-ardalink-local-postgres}"
DRYRUN_CONTAINER="ardalink-local-postgres-dryrun"
DRYRUN_PORT="15433"
DB_USER="${DB_USER:-ardalink}"
DB_NAME="${DB_NAME:-ardalink}"
DB_PASSWORD="${POSTGRES_PASSWORD:-ardalink_dev_only}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$SCRIPT_DIR/../migrations" && pwd)"
UP_SQL="$MIGRATIONS_DIR/0003_realign_local_mirror.up.sql"
REPORT="/tmp/ardalink-migration-0003-report.md"

[ -f "$UP_SQL" ] || { echo "FATAL: $UP_SQL not found" >&2; exit 1; }
docker inspect "$SRC_CONTAINER" >/dev/null 2>&1 || {
  echo "FATAL: source container $SRC_CONTAINER not running" >&2; exit 1; }

echo "▶ Dumping $SRC_CONTAINER (public schema only) …"
DUMP=$(mktemp -t ardalink-dryrun-XXXXXX.sql)
# Skip --clean/--if-exists — the dryrun container starts with an empty
# POSTGRES_DB=ardalink, so DROP-then-CREATE statements just cause
# restore to disconnect mid-way.
#
# Restrict to --schema=public — migration 0003 does not touch
# gis_engine, and the engine's baseline_pixel table alone weighs in at
# ~4M rows. Dumping only public keeps the dry-run under 30 seconds.
docker exec "$SRC_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --schema=public > "$DUMP"
echo "  → $(wc -l < "$DUMP") lines dumped to $DUMP"

echo "▶ Recreating dryrun container on :$DRYRUN_PORT …"
docker rm -f "$DRYRUN_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$DRYRUN_CONTAINER" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "127.0.0.1:$DRYRUN_PORT:5432" \
  postgres:16-alpine >/dev/null

# Wait for the "ready to accept connections" line to appear twice —
# the postgres:16-alpine image starts a temporary server for init,
# stops it, then starts the real one. Only after the second "ready"
# is the external port live.
for i in $(seq 1 60); do
  # grep -c exits 1 when zero matches — swallow with || true so set -e
  # doesn't kill us mid-poll.
  ready_count=$(docker logs "$DRYRUN_CONTAINER" 2>&1 \
    | grep -c "database system is ready to accept connections" || true)
  if [ "$ready_count" -ge 2 ]; then break; fi
  sleep 1
  [ "$i" = "60" ] && { echo "FATAL: dryrun container never reported real ready" >&2; exit 1; }
done
# One extra beat for the port to bind.
sleep 1

PSQL=(docker exec -e PGPASSWORD="$DB_PASSWORD" "$DRYRUN_CONTAINER" \
  psql -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME")

echo "▶ Restoring dump …"
docker exec -i -e PGPASSWORD="$DB_PASSWORD" "$DRYRUN_CONTAINER" \
  psql -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -q < "$DUMP" \
  >/tmp/ardalink-dryrun-restore.log 2>&1 || {
    echo "FATAL: restore failed — see /tmp/ardalink-dryrun-restore.log" >&2; exit 1; }

run_query() {
  "${PSQL[@]}" -At -c "$1"
}

capture_state() {
  local label="$1"
  {
    echo "## $label"
    echo
    echo '```'
    echo "-- Public schema tables (row counts)"
    run_query "
      SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
    " | while read -r t; do
      c=$(run_query "SELECT COUNT(*) FROM public.\"$t\"")
      printf '  %-30s %s\n' "$t" "$c"
    done
    echo
    echo "-- Tenants"
    run_query "
      SELECT tenant_id || ' | ' || COALESCE(display_name,'') FROM public.tenants ORDER BY tenant_id;
    "
    echo
    echo "-- Retired-tenant rows still present"
    for tab in pastoralists ground_truth_reports tenant_feature_flags admin_users; do
      c=$(run_query "SELECT COUNT(*) FROM public.\"$tab\" WHERE tenant_id IN ('garbatulla','merti')")
      printf '  %-30s %s\n' "$tab (garbatulla+merti)" "$c"
    done
    for tab in satellite_snapshots climate_snapshots; do
      c=$(run_query "SELECT COUNT(*) FROM public.\"$tab\" WHERE tenant_id = 'isiolo' OR tenant_id IS NULL")
      printf '  %-30s %s\n' "$tab (isiolo/null)" "$c"
    done
    echo '```'
    echo
  }
}

echo "▶ Capturing pre-migration state …"
{
  echo "# Migration 0003 dry-run report"
  echo
  echo "- Source container: \`$SRC_CONTAINER\`"
  echo "- Dryrun container: \`$DRYRUN_CONTAINER\` on port $DRYRUN_PORT"
  echo "- Migration: \`$UP_SQL\`"
  echo "- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  capture_state "Pre-migration"
} > "$REPORT"

echo "▶ Applying 0003_realign_local_mirror.up.sql …"
docker exec -i -e PGPASSWORD="$DB_PASSWORD" "$DRYRUN_CONTAINER" \
  psql -h 127.0.0.1 -p 5432 -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$UP_SQL" \
  > /tmp/ardalink-dryrun-migrate.log 2>&1 || {
    echo "FATAL: migration failed — see /tmp/ardalink-dryrun-migrate.log" >&2
    tail -20 /tmp/ardalink-dryrun-migrate.log
    exit 1; }

echo "▶ Capturing post-migration state …"
capture_state "Post-migration" >> "$REPORT"

echo
echo "✓ Dry-run complete."
echo "  Report:  $REPORT"
echo "  Dump:    $DUMP  (delete when done reviewing)"
echo "  Dryrun DB is still up on port $DRYRUN_PORT — poke at it, then:"
echo "    docker rm -f $DRYRUN_CONTAINER"
