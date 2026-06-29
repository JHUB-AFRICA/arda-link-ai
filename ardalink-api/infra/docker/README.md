# ArdaLink — Local Development

```bash
cd ardalink/infra/docker
cp .env.example .env       # fill in the secrets
make up                    # or: docker compose up --build
```

After `make up`:

| Service | URL |
|---|---|
| Operator dashboard | http://localhost:8080 |
| Public Talk | http://localhost:8080/talk |
| API | http://localhost:3000/api/healthz |
| Engine | http://localhost:5001/health |
| Postgres | `localhost:5432` (user `ardalink`, db `ardalink`) |
| Redis | `localhost:6379` |

## Profiles

- `make up` (default) — local stack without TLS
- `make up-tls` — adds Caddy with auto-TLS via Let's Encrypt (requires a real domain)
- `make logs`, `make down`, `make reset` — see `Makefile`

## Running migrations

After the engine boots for the first time, apply Phase 2 multi-tenant migrations:

```bash
make migrate-up       # forward
make migrate-down     # rollback
```