.PHONY: up up-tls down logs reset migrate-up migrate-down ps

COMPOSE = docker compose
COMPOSE_TLS = docker compose --profile tls

up:
	$(COMPOSE) up -d --build

up-tls:
	$(COMPOSE_TLS) up -d --build

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