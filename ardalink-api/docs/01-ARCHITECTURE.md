# 01 — Architecture

[← Executive Index](00-EXECUTIVE-INDEX.md) · [Next: API →](02-API.md)

**Status**: stub — full content migrates from legacy `ardalink-ai/README.md` during Phase 7.

## At a glance

```
Africa's Talking / browser ──► Express ──┬──► ardalink-engine (FastAPI)
                                        ├──► PostgreSQL (ground truth)
                                        ├──► Azure Cosmos DB (baselines)
                                        ├──► Azure OpenAI (GPT-4o + Realtime)
                                        └──► Google Earth Engine (via engine)
```

## Routes (planned v0.2.0)

- `POST /api/trigger-check` — run the intelligence pipeline
- `GET /api/status` — drought snapshot
- `POST /api/voice-callback` — Africa's Talking XML stream
- `WS /api/voice-stream` — phone ↔ Realtime bridge
- `WS /api/browser-voice-stream` — browser ↔ Realtime bridge
- `POST /api/call-tokens` — mint one-shot call tokens
- `GET /api/ground-truth/recent`
- `GET|POST|DELETE /api/pastoralists`
- `GET /api/healthz`
