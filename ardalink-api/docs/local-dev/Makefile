# ArdaLink local-dev — single entrypoint.
#
# Public surface: no secrets baked in. All credentials come from .env
# (gitignored) or environment variables.
#
# Quick start:
#   make setup     # one-time: copy .env.example to .env
#   make up        # boot the full stack (~90s)
#   make verify    # 30-point health check
#   make down      # tear down
#   make fresh     # full wipe + rebuild from scratch

SHELL := /bin/bash
PUBLIC_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
# This Makefile lives at ardalink-api/docs/local-dev/Makefile
# REPO_ROOT (the api repo) is two levels up; the JHUB workspace (with
# ardalink-engine and ardalink-web as siblings) is three levels up.
API_ROOT   := $(abspath $(PUBLIC_DIR)/../..)
REPO_ROOT  := $(abspath $(PUBLIC_DIR)/../../..)

.PHONY: setup up down verify fresh logs ps token brief login login-test sandbox-sms sandbox-ussd sandbox-voice sandbox-all help clean

help:
	@echo "ArdaLink local-dev targets:"
	@echo "  make setup   — copy .env.example to .env (one-time)"
	@echo "  make up      — boot the full stack (~90s)"
	@echo "  make down    — stop all services and remove containers"
	@echo "  make verify  — 30-point pre-flight health check"
	@echo "  make fresh   — full wipe (deletes demo data) + bring-up"
	@echo "  make clean   — stop + remove docker volumes (no data)"
	@echo "  make logs    — tail all service logs"
	@echo "  make ps      — list running services + containers"
	@echo "  make token T=bula-pesa  — print a demo JWT for tenant T"
	@echo ""
	@echo "Africa's Talking sandbox simulator (requires 'make up' first):"
	@echo "  make sandbox-sms    — drive the SMS keyword webhook"
	@echo "  make sandbox-ussd   — walk the USSD menu webhook"
	@echo "  make sandbox-voice  — fire a voice call + lifecycle event"
	@echo "  make sandbox-all    — run all three flows end-to-end"
	@echo ""
	@echo "  See docs/local-dev/SANDBOX-WORKFLOW.md for the full webhook contract."

setup:
	@if [ ! -f $(PUBLIC_DIR)/.env ]; then \
		cp $(PUBLIC_DIR)/.env.example $(PUBLIC_DIR)/.env && \
		echo "Created $(PUBLIC_DIR)/.env with dev-only defaults. Edit before non-dev use."; \
	else \
		echo "$(PUBLIC_DIR)/.env already exists — leaving it alone."; \
	fi

up:
	REPO_ROOT=$(REPO_ROOT) bash $(PUBLIC_DIR)/scripts/start-local.sh

down:
	bash $(PUBLIC_DIR)/scripts/stop-local.sh

verify:
	REPO_ROOT=$(REPO_ROOT) bash $(PUBLIC_DIR)/scripts/verify.sh

fresh: down
	docker volume rm ardalink-local-pgdata 2>/dev/null || true
	docker volume rm ardalink-local-redisdata 2>/dev/null || true
	@echo "Volumes removed. Bringing up fresh..."
	$(MAKE) up

clean: down
	docker volume rm ardalink-local-pgdata 2>/dev/null || true
	docker volume rm ardalink-local-redisdata 2>/dev/null || true
	@echo "Clean."

logs:
	@tail -f /tmp/ardalink-local/*.log

ps:
	@echo "--- Processes ---"
	@for f in /tmp/ardalink-local/*.pid; do \
		[ -f $$f ] && echo "  $$(basename $$f .pid): pid $$(cat $$f)"; \
	done
	@echo "--- Docker containers ---"
	@docker ps --filter name=ardalink-local --format "  {{.Names}}: {{.Status}}"

# Print a demo JWT for a tenant (default bula-pesa)
token:
	@if [ -z "$(T)" ]; then T=bula-pesa; fi; \
	. $(PUBLIC_DIR)/.env 2>/dev/null || true; \
	python3 -c "import base64,hmac,hashlib,json; s=b'$${JWT_SECRET:-local-dev-jwt-secret-at-least-32-chars-long-fixed}'; h=base64.urlsafe_b64encode(json.dumps({'alg':'HS256','typ':'JWT'}).encode()).rstrip(b'=').decode(); p=base64.urlsafe_b64encode(json.dumps({'sub':'demo','tenant_id':'$(T)','exp':9999999999}).encode()).rstrip(b'=').decode(); sig=base64.urlsafe_b64encode(hmac.new(s, f'{h}.{p}'.encode(),hashlib.sha256).digest()).rstrip(b'=').decode(); print(f'{h}.{p}.{sig}')"

# Print the Tenant Intelligence Brief for a tenant (default bula-pesa).
# This is the "wow moment" for the Tuesday demo. Requires the stack
# to be up (make up).
#
# Usage:
#   make brief T=bula-pesa           # English (default)
#   LANG=sw make brief T=bula-pesa   # Swahili
brief:
	@if [ -z "$(T)" ]; then T=bula-pesa; fi; \
	if echo "$${LANG:-en}" | grep -qi '^sw'; then LANG_VAL=sw; else LANG_VAL=en; fi; \
	TOKEN=$$($(MAKE) -s token T=$(T)); \
	echo "== $(T) — Intelligence Brief (lang=$$LANG_VAL) =="; \
	curl -s -H "Authorization: Bearer $$TOKEN" \
	  "http://localhost:3000/api/intelligence/brief?lang=$$LANG_VAL" \
	  | python3 /tmp/ardalink-local/print-brief.py
# Print demo login credentials (POST /api/auth/login)
# The 4 seeded admins (2026-07-08 onward, aligned with Supabase active_wards):
#   bula-pesa@ardalink.test    / bula-pesa         (tenant=bula-pesa,  role=operator)
#   ngare-mara@ardalink.test   / garbatulla        (tenant=ngare-mara, role=operator)
#   burat@ardalink.test        / merti             (tenant=burat,      role=operator)
#   admin@ardalink.test        / admin-secret-2024 (tenant=bula-pesa,  role=admin)
# (The ngare-mara/burat passwords are legacy hashes reused from the
#  retired garbatulla/merti operators — rotate before any non-dev deploy.)
login:
	@echo "Demo admin credentials (POST /api/auth/login):"
	@echo
	@printf "  %-30s %-25s %-15s %s\n" "EMAIL" "PASSWORD" "TENANT" "ROLE"
	@printf "  %-30s %-25s %-15s %s\n" "bula-pesa@ardalink.test"  "bula-pesa"        "bula-pesa"  "operator"
	@printf "  %-30s %-25s %-15s %s\n" "ngare-mara@ardalink.test" "garbatulla"       "ngare-mara" "operator"
	@printf "  %-30s %-25s %-15s %s\n" "burat@ardalink.test"      "merti"            "burat"      "operator"
	@printf "  %-30s %-25s %-15s %s\n" "admin@ardalink.test"      "admin-secret-2024" "bula-pesa"  "admin"
	@echo
	@echo "Rotate these before any non-dev deploy (start-local.sh, .env.example)."

# Smoke-test the login flow end-to-end
login-test:
	@. $(PUBLIC_DIR)/.env 2>/dev/null || true; \
	EMAIL="$${EMAIL:-bula-pesa@ardalink.test}"; \
	PW="$${PW:-bula-pesa}"; \
	echo "POST /api/auth/login as $$EMAIL ..."; \
	RESP=$$(curl -s -X POST -H "Content-Type: application/json" \
	  -d "{\"email\":\"$$EMAIL\",\"password\":\"$$PW\"}" \
	  http://localhost:3000/api/auth/login); \
	TOK=$$(echo "$$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('token',''))"); \
	if [ -z "$$TOK" ]; then echo "  $$RESP"; exit 1; fi; \
	TID=$$(echo "$$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('tenant_id',''))"); \
	echo "  token issued for tenant=$$TID"; \
	echo "  GET /api/auth/me with that token ..."; \
	curl -s -H "Authorization: Bearer $$TOK" http://localhost:3000/api/auth/me; echo

# ── Africa's Talking sandbox simulator ────────────────────────────────────
# Drive the four AT webhooks (voice-callback, voice-events, ussd-callback,
# sms-callback) with the exact payload shapes AT sends in production, so we
# can validate the full call + USSD + SMS flow without ngrok or a real AT
# account. See docs/local-dev/SANDBOX-WORKFLOW.md for the contract.
SANDBOX_SCRIPT := $(API_ROOT)/scripts/sandbox-simulate.mjs

sandbox-sms:
	@API_BASE=http://localhost:3000 node $(SANDBOX_SCRIPT) sms

sandbox-ussd:
	@API_BASE=http://localhost:3000 node $(SANDBOX_SCRIPT) ussd

sandbox-voice:
	@API_BASE=http://localhost:3000 node $(SANDBOX_SCRIPT) voice

sandbox-all:
	@API_BASE=http://localhost:3000 node $(SANDBOX_SCRIPT) all
