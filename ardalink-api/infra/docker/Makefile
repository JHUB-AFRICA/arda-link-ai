.PHONY: up up-tls down logs reset migrate-up migrate-down ps pull-prod up-prod down-prod

COMPOSE = docker compose
COMPOSE_TLS = docker compose --profile tls
COMPOSE_PROD = docker compose -f compose.prod.yml

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

migrate-up:
	docker exec -i ardalink-postgres-1 psql -U ardalink -d ardalink < ../../engine/migrations/0001_multitenant.up.sql
	docker exec -i ardalink-postgres-1 psql -U ardalink -d ardalink < ../../api/migrations/0001_multitenant.up.sql

migrate-down:
	docker exec -i ardalink-postgres-1 psql -U ardalink -d ardalink < ../../api/migrations/0001_multitenant.down.sql
	docker exec -i ardalink-postgres-1 psql -U ardalink -d ardalink < ../../engine/migrations/0001_multitenant.down.sql