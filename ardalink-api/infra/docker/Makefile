.PHONY: up up-tls down logs reset migrate-up migrate-down migrate-up-prod migrate-down-prod ps pull-prod up-prod down-prod

COMPOSE = docker compose
COMPOSE_TLS = docker compose --profile tls
COMPOSE_PROD = docker compose -f compose.prod.yml

# Shared shell body for migrate-up / migrate-up-prod — takes the
# compose command to use (dev vs. prod) as $(1) so both stacks share
# one implementation instead of two copies drifting apart.
define run_migrate_up
	@set -e; \
	container=$$($(1) ps -q postgres); \
	if [ -z "$$container" ]; then echo "postgres container not running — bring the stack up first" >&2; exit 1; fi; \
	docker exec -i "$$container" psql -v ON_ERROR_STOP=1 -U ardalink -d ardalink -c 'CREATE SCHEMA IF NOT EXISTS gis_engine;'; \
	for f in $(sort $(wildcard ../../docs/local-dev/migrations/*.up.sql)); do \
		echo "applying $$(basename $$f)"; \
		docker exec -i "$$container" psql -v ON_ERROR_STOP=1 -U ardalink -d ardalink < $$f || exit 1; \
	done; \
	echo "done."
endef

define run_migrate_down_list
	@echo "No automatic rollback — apply a specific down.sql by hand, newest first:"
	@ls -1 ../../docs/local-dev/migrations/*.down.sql | sort -rV
	@echo ""
	@echo "e.g.: docker exec -i \$$($(1) ps -q postgres) psql -U ardalink -d ardalink < ../../docs/local-dev/migrations/0018_sms_registration_pending.down.sql"
endef

up:
	$(COMPOSE) up -d --build

up-tls:
	$(COMPOSE_TLS) up -d --build

# Pre-built-image path — see compose.prod.yml's header. For a different
# person deploying without the source tree.
pull-prod:
	$(COMPOSE_PROD) pull

up-prod:
	$(COMPOSE_PROD) up -d

down-prod:
	$(COMPOSE_PROD) down

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=200

ps:
	$(COMPOSE) ps

reset:
	$(COMPOSE) down -v
	@echo "All volumes removed."

# Applies every *.up.sql in docs/local-dev/migrations/, in order, against
# the running `postgres` container — the same migration set and
# convention docs/local-dev/scripts/start-local.sh uses for the
# non-Docker dev path (see that script's own loop). All idempotent
# (CREATE TABLE IF NOT EXISTS etc.), so safe to re-run. Deliberately
# does NOT touch *.supabase-only.sql files (excluded by the *.up.sql
# glob itself) — those apply only to a real Supabase project's SQL
# editor by hand, see RUNBOOK.md's "Supabase-only migrations" section.
#
# Replaces two hardcoded paths (../../engine/migrations/0001_multitenant
# .up.sql, ../../api/migrations/0001_multitenant.up.sql) that pointed at
# files which no longer exist anywhere in the repo — leftover from a
# single-migration-file era, silently broken since the migration set
# moved to docs/local-dev/migrations/ and grew past 0001.
#
# gis_engine is NOT created by any migration file — the engine service
# creates it itself at runtime, on first connection (ensure_schema() in
# ardalink_engine/src/db/client.py). In start-local.sh's world this is
# invisible because the engine has typically already booted at least
# once against that Postgres before migrations run; here, with no such
# guaranteed ordering, migrate-up creates it explicitly first so this
# target is self-sufficient regardless of which service started first
# (confirmed live: 0001_multitenant_gis_engine.up.sql fails with
# `schema "gis_engine" does not exist` without this).
migrate-up:
	$(call run_migrate_up,$(COMPOSE))

# No blanket auto-rollback: these migrations aren't tracked in a
# schema_migrations table (matching start-local.sh's own approach), so
# there's no safe way to know how far to unwind automatically, and not
# every migration has a down.sql (e.g. 0004_drop_ground_truth_reports,
# every *.supabase-only.sql). Lists what IS available; run the specific
# one(s) you actually need by hand.
migrate-down:
	$(call run_migrate_down_list,$(COMPOSE))

# Same as migrate-up/migrate-down but against the compose.prod.yml
# stack (pre-built-image hand-off path — see pull-prod/up-prod above).
# Both compose files declare the same `name: ardalink` project, so in
# practice `docker compose ps` alone can usually find the postgres
# container either way — these targets exist so that's never something
# you have to rely on or debug.
migrate-up-prod:
	$(call run_migrate_up,$(COMPOSE_PROD))

migrate-down-prod:
	$(call run_migrate_down_list,$(COMPOSE_PROD))