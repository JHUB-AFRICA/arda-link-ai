# ArdaLink AI — Deployment

> This document covers local development with Docker Compose and production hosting options for the ArdaLink platform.

---

## Table of Contents

1. [Local Development (Docker Compose)](#local-development-docker-compose)
2. [Service Dependency Graph](#service-dependency-graph)
3. [Production Hosting Options](#production-hosting-options)
4. [Environment Variables](#environment-variables)
5. [Caddy Configuration](#caddy-configuration)
6. [Health Checks & Monitoring](#health-checks--monitoring)

---

## Local Development (Docker Compose)

The full platform runs locally with a single `docker compose up` command. Six services are defined:

```mermaid
flowchart TB
    subgraph External ["External (internet required)"]
        AT["Africa's Talking\nngrok tunnel required for webhooks"]
        GEE["Google Earth Engine"]
        AzureOAI["Azure OpenAI Realtime"]
        OpenMeteo["Open-Meteo"]
    end

    subgraph Compose ["Docker Compose — localhost"]
        Caddy["caddy:2-alpine\n:80, :443\n\nReverse proxy + TLS"]
        Web["ardalink-web\n:8080\n\nReact 19 + Vite"]
        API["ardalink-api\n:3000\n\nExpress 5 + Node 22"]
        Engine["ardalink-engine\n:5001\n\nPython 3.12 + FastAPI"]
        PG["postgres:16-alpine\n:5432\n\npublic + gis_engine schemas"]
        Redis["redis:7-alpine\n:6379"]
    end

    Caddy -->|"proxy :8080"| Web
    Caddy -->|"proxy :3000"| API
    Web -->|"REST/WS"| API
    API -->|"REST"| Engine
    API -->|"SQL"| PG
    API -->|"GET/SET"| Redis
    Engine -->|"SQL"| PG
    Engine -->|"GEE SDK"| GEE
    Engine -->|"HTTP"| OpenMeteo
    API -->|"WebSocket"| AzureOAI
    AT -->|"Webhooks (via ngrok)"| API
```

### Docker Compose service definitions

```yaml
services:

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ardalink
      POSTGRES_USER: ardalink
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ardalink"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --save 60 1 --loglevel warning

  engine:
    build:
      context: ./ardalink-engine
      dockerfile: Dockerfile
    ports:
      - "5001:5001"
    environment:
      DATABASE_URL: ${DATABASE_URL}
      GEE_SERVICE_ACCOUNT: ${GEE_SERVICE_ACCOUNT}
      GEE_PROJECT: ${GEE_PROJECT}
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: ./ardalink-api
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      JWT_SECRET: ${JWT_SECRET}
      SESSION_SECRET: ${SESSION_SECRET}
      AFRICASTALKING_API_KEY: ${AFRICASTALKING_API_KEY}
      AZURE_OPENAI_ENDPOINT: ${AZURE_OPENAI_ENDPOINT}
      AZURE_OPENAI_API_KEY: ${AZURE_OPENAI_API_KEY}
      ENGINE_URL: http://engine:5001
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
      engine:
        condition: service_started

  web:
    build:
      context: ./ardalink-web
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    depends_on:
      - api

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api
      - web

volumes:
  pgdata:
  caddy_data:
  caddy_config:
```

---

## Service Dependency Graph

Services must start in the following order:

```mermaid
flowchart LR
    PG["postgres\n(healthcheck)"]
    Redis["redis"]
    Engine["engine\n(depends: postgres)"]
    API["api\n(depends: postgres,\nredis, engine)"]
    Web["web\n(depends: api)"]
    Caddy["caddy\n(depends: api, web)"]

    PG --> Engine
    PG --> API
    Redis --> API
    Engine --> API
    API --> Web
    API --> Caddy
    Web --> Caddy
```

---

## Production Hosting Options

Four hosting configurations have been evaluated for production deployment:

```mermaid
flowchart LR
    subgraph DO ["DigitalOcean ($60–100/mo)"]
        DODrop["2× Droplets\n(API + Engine)"]
        DOPG["Managed PostgreSQL\n(DO DBaaS)"]
        DORedis["Managed Redis\n(DO DBaaS)"]
    end

    subgraph Hetzner ["Hetzner ($30–50/mo)"]
        HetzCX["CX31 Dedicated\n(all services)"]
        HetzPG["Self-hosted PostgreSQL\n+ PostGIS"]
    end

    subgraph AWS ["AWS ($100–200/mo)"]
        AWSEC2["EC2 / ECS\n(Fargate)"]
        AWSRDS["RDS PostgreSQL\n+ PostGIS"]
        AWSElastic["ElastiCache\n(Redis)"]
    end

    subgraph Azure ["Azure ($100–200/mo)"]
        AzureApp["App Service\n(API + Web)"]
        AzureSQL["Azure Database\nfor PostgreSQL"]
        AzureCache["Azure Cache\nfor Redis"]
    end
```

| Provider | Service | Est. Cost/mo | Region | Notes |
|----------|---------|-------------|--------|-------|
| **DigitalOcean** | Managed PostgreSQL + Droplets | $60–100 | AMS (Amsterdam) | Good balance of cost and managed services |
| **Hetzner** | Dedicated + self-host PG | $30–50 | Germany | Lowest cost; requires more ops expertise |
| **AWS** | RDS + EC2/ECS | $100–200 | Nairobi / Cape Town | Native Africa region; best latency for Kenya |
| **Azure** | Cloud SQL + App Service | $100–200 | Kenya / South Africa | Co-located with Azure OpenAI; simplifies networking |

### Recommendation

For **lowest latency** to Africa's Talking and pastoralists in Kenya: **AWS (af-south-1, Cape Town)** or **Azure (eastafrica)** are preferred.

For **lowest cost** during early deployments: **Hetzner** with a single CX31 instance running Docker Compose is viable and has been validated.

### Production checklist

- [ ] TLS certificate provisioned via Caddy (auto Let's Encrypt)
- [ ] `DATABASE_URL` points to managed PostgreSQL, not local
- [ ] `REDIS_URL` points to managed Redis
- [ ] `JWT_SECRET` and `SESSION_SECRET` are 32+ character random strings
- [ ] Africa's Talking webhook URLs updated to production domain
- [ ] GEE service account JSON stored securely (env var or secrets manager)
- [ ] Azure OpenAI endpoint allowlisted for production IP
- [ ] Postgres backups enabled (daily at minimum)
- [ ] `TENANT_ATTESTATION_SECRET` rotated from default

---

## Environment Variables

### Required (all environments)

```bash
PORT=3000
DATABASE_URL=postgresql://ardalink:password@host:5432/ardalink
REDIS_URL=redis://host:6379
SESSION_SECRET=<random-32-chars>
JWT_SECRET=<random-32-chars>
TENANT_ATTESTATION_SECRET=<random-32-chars>
```

### Africa's Talking

```bash
AFRICASTALKING_USERNAME=sandbox          # or your AT username
AFRICASTALKING_API_KEY=<your-key>
AFRICASTALKING_CALLER_ID=+254XXXXXXXXX  # your AT virtual number
```

### Azure OpenAI

```bash
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_KEY=<your-key>
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o
AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-4o-realtime
```

### Google Earth Engine

```bash
GEE_SERVICE_ACCOUNT=<JSON string of service account key>
GEE_PROJECT=<your-gcp-project-id>
```

### Legacy / Migration

```bash
# Cosmos DB (being migrated to PostgreSQL — set if backfill needed)
COSMOS_DB_ENDPOINT=https://<account>.documents.azure.com:443/
COSMOS_DB_PRIMARY_KEY=<your-key>
```

---

## Caddy Configuration

Caddy handles TLS termination and proxying in both local and production environments.

```caddyfile
# Caddyfile

# Production
your-domain.com {
    reverse_proxy /api/* api:3000
    reverse_proxy /* web:8080
    encode gzip
    log {
        output file /var/log/caddy/access.log
    }
}

# Local (HTTP only)
:80 {
    reverse_proxy /api/* api:3000
    reverse_proxy /* web:8080
}
```

**WebSocket proxying:** Caddy automatically upgrades `/api/voice-stream` and `/api/browser-voice-stream` connections to WebSocket — no additional configuration required.

---

## Health Checks & Monitoring

### Container health

All containers expose health check endpoints or use Docker healthcheck instructions.

| Service | Health Check | Endpoint |
|---------|-------------|----------|
| `ardalink-api` | HTTP GET | `GET /api/healthz` |
| `ardalink-engine` | HTTP GET | `GET /healthz` |
| `postgres` | Shell | `pg_isready -U ardalink` |
| `redis` | Shell | `redis-cli ping` |

### Recommended monitoring stack (self-hosted)

- **Uptime:** [Uptime Kuma](https://github.com/louislam/uptime-kuma) — polls `/api/healthz` every 60s, alerts via Telegram/email
- **Logs:** Caddy structured JSON logs → Loki → Grafana
- **Metrics:** Node.js Prometheus client → Grafana dashboard

### Alert thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| API response time | > 2s | > 5s |
| PostgreSQL connections | > 80% pool | > 95% pool |
| Redis memory | > 70% | > 90% |
| Voice call failure rate | > 5% | > 20% |
| GEE pipeline last run | > 8 days ago | > 15 days ago |

---

## Cross-References

- **Architecture overview:** [`architecture.md`](./architecture.md)
- **Security & secrets management:** [`security.md`](./security.md)
- **Developer local setup:** [`onboarding.md`](./onboarding.md)
- **Engine satellite processing:** [`satellite.md`](./satellite.md)
