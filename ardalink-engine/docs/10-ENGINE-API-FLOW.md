# 10 — Engine ↔ API Communication Flow

[← Runbooks](07-RUNBOOKS.md) · [Index →](00-EXECUTIVE-INDEX.md)

## Overview

The ArdaLink system consists of two main components that work together:

1. **Python Engine** (`ardalink-engine`) — Biophysical data processing and analysis
2. **Node.js API** (`ardalink-api`) — Webhooks, AI conversation, and communication channels

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ARDALINK SYSTEM ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────┐         HTTP          ┌──────────────────────┐ │
│  │   Python Engine         │ ◄────────────────────► │   Node.js API        │ │
│  │   Port 5001             │                       │   (ardalink-api)     │ │
│  └─────────────────────────┘                       └──────────────────────┘ │
│           ▲                                                  │             │
│           │                                                  │             │
│           │                                                  │             │
│    ┌──────┴──────┐                                 ┌───────▼──────────┐      │
│    │  PostgreSQL  │                                 │ Africa's Talking  │      │
│    │  (gis_engine)│                                 │  • SMS            │      │
│    │              │                                 │  • USSD           │      │
│    └───────────────┘                                 │  • Voice          │      │
│                                                       └───────────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Technology | Responsibility |
|-----------|-----------|---------------|
| **Python Engine** | Python/FastAPI | Satellite data ingestion, baseline computation, grid analysis, VCI snapshots |
| **Node.js API** | TypeScript/Express | Africa's Talking webhooks, intelligence cycles, AI conversation, voice streaming |
| **Database** | PostgreSQL | Persistent storage for baselines, pixel grids, snapshots |

---

## Python Engine (Data Provider)

### Purpose

The Python engine is a **data source only**. It processes satellite imagery, computes baselines, and provides HTTP endpoints for the Node.js API to consume.

### Key Endpoints

| Endpoint | Method | Returns | Used By |
|----------|--------|---------|---------|
| `/health` | GET | Service status | API health checks |
| `/api/v1/baseline/aggregate` | GET | Ward-level NDVI/NDRE/RedEdge p50/p5 | Intelligence cycles |
| `/api/v1/baseline/pixel` | GET | Per-pixel baseline grids | Anomaly detection |
| `/api/v1/satellite/vci` | GET | VCI snapshot from GEE | Drought briefs |

### Environment Variables

```bash
# Engine Configuration
ARDALINK_HOST=127.0.0.1
ARDALINK_PORT=5001
DATABASE_URL=postgresql://...

# Google Earth Engine
GEE_PRIVATE_KEY=...
GEE_PROJECT=...

# Azure OpenAI (optional)
AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_KEY=...
```

---

## Node.js API (Communication Layer)

### Purpose

The Node.js API **consumes engine data** and manages all communication with herders via Africa's Talking.

### Key Responsibilities

1. **Fetch data from Python engine** via HTTP client (`src/lib/engine.ts`)
2. **Run intelligence cycles** combining engine data + climate + forecast
3. **Handle Africa's Talking webhooks** for SMS, USSD, and Voice
4. **Stream voice calls** to Azure OpenAI Realtime API for AI conversation

### Africa's Talking Integration

| Channel | Endpoint | Keywords/Actions |
|---------|----------|------------------|
| **SMS** | `/api/sms-callback` | BULA (brief), MALISHO (water), ONGEA (call), STOP (opt-out) |
| **USSD** | `/api/ussd-callback` | Menu system `*123*8#` with bilingual options |
| **Voice** | `/api/voice-callback` | Returns Stream XML → WebSocket → Azure OpenAI |
| **Events** | `/api/voice-events` | Call lifecycle: queued, ringing, answered, completed |

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/engine.ts` | HTTP client to Python engine |
| `src/lib/satellite.ts` | Live vegetation + baseline comparison |
| `src/lib/intelligence.ts` | Intelligence cycle orchestration |
| `src/lib/channels/intelligenceCore.ts` | Unified AI across SMS/USSD/Voice |
| `src/routes/sms.ts` | SMS webhook handler |
| `src/routes/ussd.ts` | USSD menu system |
| `src/routes/voice.ts` | Voice callback (Stream XML) |
| `src/routes/voiceEvents.ts` | Voice event logging |

---

## Data Flow: Herder Request Example

### SMS: "BULA" Request

```
1. Herder sends "BULA" to short code
   │
2. Africa's Talking POSTs to /api/sms-callback
   │
3. Node.js API parses keyword
   │
4. Fetches last intelligence result (includes engine data)
   │
5. Generates SMS reply with drought brief
   │
6. Optionally triggers voice call
   │
7. Returns plain-text SMS body to Africa's Talking
   │
8. Herder receives SMS reply
```

### Voice Call Flow

```
1. Intelligence cycle detects drought alert
   │
2. Node.js API stores call session (with engine data context)
   │
3. Initiates call via Africa's Talking Voice API
   │
4. Africa's Talking POSTs to /api/voice-callback when call connects
   │
5. Node.js API returns <Stream url="wss://..."/> XML
   │
6. Africa's Talking opens WebSocket to Node.js
   │
7. Node.js bridges to Azure OpenAI Realtime API
   │
8. AI conducts conversation with herder
   │
9. Africa's Talking POSTs call state to /api/voice-events
```

---

## Communication Contract

### Engine → API

The Python engine provides data via these HTTP contracts:

**Baseline Aggregate** (`/api/v1/baseline/aggregate`)
```json
{
  "available": true,
  "tenant_id": "isiolo",
  "ward_id": "242",
  "month": 7,
  "row": {
    "ndvi_p50": 0.45,
    "ndvi_p5": 0.32,
    "ndre_p50": 0.28,
    "red_edge_p50": 0.15
  }
}
```

**VCI Snapshot** (`/api/v1/satellite/vci`)
```json
{
  "ward_id": "bula-pesa",
  "ward_name": "Bulla Pesa",
  "vci": 42.3,
  "ndvi_now": 0.38,
  "ndvi_min": 0.12,
  "ndvi_max": 0.65,
  "captured_at": "2026-07-04T10:00:00Z"
}
```

---

## Important Design Decisions

### Why Africa's Talking is in Node.js Only

1. **Single source of truth** — All communication channels managed in one place
2. **WebSocket streaming** — Node.js better suited for real-time voice streaming
3. **Express middleware** — Easier webhook handling without authentication bypasses
4. **Intelligence proximity** — AI conversation logic lives with the communication layer

### Why Python Engine Doesn't Handle Communication

1. **Separation of concerns** — Engine focuses on data processing
2. **Avoid duplication** — Prevents conflicting message/call logic
3. **Simpler deployment** — Engine can be containerized without AT credentials
4. **Cleaner testing** — Data pipeline tests independent of communication tests

---

## Environment Setup

### Python Engine (.env)

```bash
# Core
ARDALINK_HOST=127.0.0.1
ARDALINK_PORT=5001
DATABASE_URL=postgresql://user:pass@localhost/dbname

# Google Earth Engine
GEE_PRIVATE_KEY='{"type": "service_account", ...}'

# Azure OpenAI (optional)
AZURE_OPENAI_ENDPOINT=https://...
AZURE_OPENAI_KEY=...
```

### Node.js API (.env)

```bash
# Engine Connection
ARDALINK_ENGINE_BASE=http://localhost:5001

# Africa's Talking
AFRICASTALKING_USERNAME=your_username
AFRICASTALKING_API_KEY=your_api_key
AFRICASTALKING_CALLER_ID=+254700000000

# Google Earth Engine (for satellite.ts)
GOOGLE_SERVICE_ACCOUNT_JSON='{"type": "service_account", ...}'

# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://...
AZURE_OPENAI_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

---

## Testing the Integration

### 1. Start the Engine

```bash
cd ardalink-engine
python -m ardalink_engine.main
# Engine runs on http://localhost:5001
```

### 2. Start the API

```bash
cd ardalink-api
pnpm start
# API runs on http://localhost:3000
```

### 3. Test Engine Health

```bash
curl http://localhost:5001/health
# Returns: {"status": "ok", "service": "ArdaLink Biophysical Data Engine", ...}
```

### 4. Test API Health

```bash
curl http://localhost:3000/api/healthz
# Returns engine reachability status
```

### 5. Test Africa's Talking Webhooks (Sandbox)

```bash
# SMS
curl -X POST http://localhost:3000/api/sms-callback \
  -d "from=+254711082200" \
  -d "text=BULA" \
  -d "id=test_001"

# USSD
curl -X POST http://localhost:3000/api/ussd-callback \
  -d "phoneNumber=+254711082200" \
  -d "serviceCode=*123*8#" \
  -d "text="

# Voice
curl -X POST http://localhost:3000/api/voice-callback \
  -d "callerNumber=+254711082200" \
  -d "destinationNumber=+254700000000" \
  -d "sessionId=test_session"
```

---

## Quick Reference

| Question | Answer |
|----------|--------|
| Where is SMS handled? | `ardalink-api/src/routes/sms.ts` |
| Where is USSD handled? | `ardalink-api/src/routes/ussd.ts` |
| Where is Voice handled? | `ardalink-api/src/routes/voice.ts` |
| Where does engine data come from? | Python `/api/v1/baseline/*` endpoints |
| How does API talk to engine? | HTTP via `ardalink-api/src/lib/engine.ts` |
| Can Python send SMS directly? | No — all communication through Node.js API |
| Where is AI conversation logic? | `ardalink-api/src/lib/channels/intelligenceCore.ts` |
