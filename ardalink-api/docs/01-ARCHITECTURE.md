# 01 — Architecture

[← Executive Index](00-EXECUTIVE-INDEX.md) · [Next: API →](02-API.md)

> **For C4-level diagrams and full component descriptions see
> [`Arda-link-AI-Docs/architecture.md`](../../Arda-link-AI-Docs/architecture.md).
> This document is the API-server-level view for engineers working in `ardalink-api`.**

## At a glance

```
Africa's Talking / browser ──► Express ──┬──► ardalink-engine (FastAPI :5001)
                                        ├──► Supabase (PostgREST — source of truth)
                                        ├──► Local Postgres :15432 (mirror + fallback)
                                        ├──► Azure OpenAI (GPT-5 Mini text + gpt-4o-realtime voice)
                                        ├──► Azure Speech (STT/TTS sw-KE)
                                        └──► Google Earth Engine (via engine)

360dialog / Evolution API ──► Express (POST /api/whatsapp-webhook,
                                        POST /api/evolution-whatsapp-webhook)
                                        — same downstream fan-out as above,
                                          via the shared whatsappTurn.ts pipeline
```

**Data hierarchy**: Supabase is the source of truth for all reference data (`wards`, `pastoralists`, `satellite_indices`, `weather_data`, `ground_truth_calls`, `whatsapp_messages`). Local Postgres is a read fallback mirror; the 5-minute `syncJob.ts` keeps it current. Azure Cosmos DB was removed in #40.

**Code layout**: `src/lib/{supabase,openai,openData,herderContext}/` are each a directory of domain modules + a curated `index.ts` barrel (mirroring `src/lib/llm/`) rather than one large file — always import from the barrel (`./supabase/index.js` etc.), never a leaf module directly.

## Background jobs (started at boot in `src/index.ts`)

| Job | Schedule | Purpose |
|-----|----------|---------|
| `satelliteJob` | Seasonal | GEE → Supabase `satellite_indices` refresh |
| `forecastJob` | Every 6 h | Open-Meteo → Supabase `weather_forecast` |
| `vciBackfillJob` | Every 1 h | Fill `vci_value` on any `satellite_indices` rows where null |
| `syncJob` | Every 5 min | Supabase → local mirror (`pastoralist_leads`, `weather_data`) |
| `heartbeatJob` | Every 15 min | Per-table freshness probe; surfaces in `GET /api/healthz` |

## Live routes

- `POST /api/trigger-check` — run the intelligence pipeline
- `GET  /api/status` — drought snapshot (ward + satellite + weather)
- `GET  /api/healthz` — heartbeat / per-table freshness
- `POST /api/voice-callback` — Africa's Talking XML stream (returns `<Stream>`)
- `POST /api/whatsapp-webhook` — 360dialog (Meta Cloud API) inbound WhatsApp
- `POST /api/evolution-whatsapp-webhook` — Evolution API (self-hosted) inbound WhatsApp — currently the live one; see [`whatsapp-first-architecture.md`](../../Arda-link-AI-Docs/whatsapp-first-architecture.md#known-limitation-meta-business-api-verification)
- `WS   /api/voice-stream` — AT phone ↔ Azure Realtime bridge
- `WS   /api/browser-voice-stream` — browser ↔ Azure Realtime bridge (token-gated)
- `POST /api/call-tokens` — mint single-use browser voice tokens
- `GET  /api/ground-truth/recent` — recent `ground_truth_calls` (Supabase)
- `GET|POST|DELETE /api/pastoralists`
- `GET  /api/satellite/vci` — latest VCI from GEE (via engine)
- `GET  /api/speech/status`, `GET /api/speech/token`, `POST /api/speech/tts`, `GET /api/speech/brief.mp3`
- `POST /api/sms` — Africa's Talking SMS keyword handler
- `POST /api/ussd` — Africa's Talking USSD menu handler
- `GET  /api/intelligence/brief` — Swahili + English drought brief (LLM)
- `GET  /api/water-points/{near,ward/:ward,status}` — WPDx water point data
