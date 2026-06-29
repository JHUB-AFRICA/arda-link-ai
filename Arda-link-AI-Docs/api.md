# ArdaLink AI — API Reference

> All endpoints are served by **ardalink-api** (Express 5, Node.js 22) on port `:3000`. In production, Caddy proxies traffic to this service.
>
> Base URL (local): `http://localhost:3000`
> Base URL (production): `https://your-domain.com`

---

## Table of Contents

1. [Authentication](#authentication)
2. [Pastoralist Data](#pastoralist-data)
3. [Ground Truth Reports](#ground-truth-reports)
4. [Intelligence / Satellite](#intelligence--satellite)
5. [Open Data (Public)](#open-data-public)
6. [Voice & Telephony](#voice--telephony)
7. [Public Talk (Browser Voice)](#public-talk-browser-voice)
8. [Health](#health)
9. [WebSocket Protocols](#websocket-protocols)

---

## Authentication

All protected endpoints require a `Bearer` token in the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### POST `/api/auth/login`

Authenticates an operator and returns a JWT.

**Request:**
```json
{
  "email": "amina@isiolo.go.ke",
  "password": "s3cur3p@ss"
}
```

**Response `200`:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "tenant_id": "bula-pesa",
  "display_name": "Amina Hassan"
}
```

**Response `401`:**
```json
{ "error": "Invalid credentials" }
```

---

### GET `/api/whoami`

Returns the identity of the currently authenticated user.

**Response `200`:**
```json
{
  "tenant_id": "bula-pesa",
  "sub": "admin_user:42",
  "role": "operator"
}
```

---

## Pastoralist Data

### GET `/api/pastoralists`

Returns all pastoralists registered under the current tenant.

**Response `200`:**
```json
[
  {
    "id": 1,
    "name": "Hassan Wako",
    "phone": "+254711082200",
    "location": "Bula Pesa NW",
    "cattle": 45,
    "goats": 120,
    "camels": 8,
    "water_source": "Bula Pesa Dam",
    "alerts_enabled": true,
    "alerts_sent": 3,
    "last_contact_at": "2026-06-15T09:22:00Z"
  }
]
```

---

### POST `/api/pastoralists`

Registers a new pastoralist.

**Request:**
```json
{
  "name": "Fatuma Dida",
  "phone": "+254722334455",
  "location": "Garbatulla SE",
  "cattle": 30,
  "goats": 80,
  "camels": 0
}
```

**Response `201`:**
```json
{ "id": 42 }
```

---

## Ground Truth Reports

### GET `/api/ground-truth/recent`

Returns the most recent ground-truth reports from voice calls for the current tenant.

**Response `200`:**
```json
[
  {
    "id": 101,
    "phone": "+254711082200",
    "month": "2026-06",
    "bcs_score": 2.5,
    "bcs_species": "cattle",
    "bcs_confidence": "medium",
    "offtake_rate": "early",
    "mortality_rate": "1-3",
    "milk_production": "reduced",
    "water_trekking_distance": "5-10km",
    "water_point_status": "poor",
    "ndvi_score": 0.18,
    "ndvi_vs_baseline_percent": -42.0,
    "rainfall_30day_mm": 8.4,
    "trust_score": 74,
    "call_duration_seconds": 187,
    "data_completeness_percent": 85.7,
    "created_at": "2026-06-18T11:04:00Z"
  }
]
```

---

### POST `/api/ground-truth`

Submits a ground-truth report (typically called internally after a voice call ends).

**Request:**
```json
{
  "phone": "+254711082200",
  "session_id": "AT_SESSION_abc123",
  "user_feedback": "Mifugo yangu iko vibaya. Ng'ombe wangu wana tatizo kubwa.",
  "action_tag": "alert_triggered",
  "bcs_score": 2.0,
  "bcs_species": "cattle",
  "mortality_rate": "4-plus",
  "water_point_status": "dry"
}
```

**Response `201`:**
```json
{
  "id": 102,
  "trust_score": 61,
  "trust_flags": ["short_call", "satellite_mismatch"]
}
```

---

## Intelligence / Satellite

### GET `/api/intelligence/brief`

Returns the current drought intelligence brief for the operator's tenant ward.

**Response `200`:**
```json
{
  "live": {
    "anomaly": true,
    "wardStressedPixelPct": 68.4,
    "ndvi_mean": 0.17,
    "ndvi_vs_baseline_percent": -38.5,
    "vci": 22.1,
    "newest_image_date": "2026-06-20"
  },
  "forecast": {
    "rainfall_7day_mm": 3.2,
    "rainfall_14day_mm": 11.8,
    "condition": "dry",
    "outlook": "Below-normal rainfall expected through end of June"
  },
  "script": "Ukame mkubwa unaendelea katika Bula Pesa. VCI ya 22 inaonyesha hali mbaya sana..."
}
```

The `script` field contains a pre-generated Swahili drought brief that can be used as the AI voice greeting.

---

### POST `/api/trigger-check`

Triggers a drought check and optionally initiates an outbound alert call to a specific phone number.

**Request:**
```json
{
  "phone": "+254711082200",
  "dryRun": false,
  "forceAlert": false
}
```

- `dryRun: true` — evaluates conditions without placing a call.
- `forceAlert: true` — places a call regardless of drought threshold.

**Response `200`:**
```json
{
  "triggered": true,
  "hasAnomaly": true,
  "ndvi_vs_baseline_percent": -38.5,
  "call_queued": true
}
```

---

### GET `/api/intelligence/status`

Returns the scheduler status for the satellite intelligence pipeline.

**Response `200`:**
```json
{
  "lastRun": "2026-06-20T03:00:00Z",
  "nextRun": "2026-06-27T03:00:00Z",
  "active": true,
  "wards_processed": 10
}
```

---

## Open Data (Public)

These endpoints do **not** require authentication. They expose aggregated, anonymized data for public dashboards and research.

### GET `/api/open-data/choropleth`

Returns GeoJSON feature collection of Isiolo wards with vegetation stress metrics for map rendering.

**Response `200`:**
```json
{
  "featureCollection": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": { "type": "Polygon", "coordinates": [[...]] },
        "properties": {
          "ward_name": "Bula Pesa",
          "ndvi_mean": 0.17,
          "vci": 22.1,
          "stress_level": "extreme",
          "stressed_pixel_pct": 68.4
        }
      }
    ]
  },
  "ward_metrics": [
    {
      "ward": "bula-pesa",
      "ndvi_mean": 0.17,
      "vci": 22.1,
      "stress_level": "extreme"
    }
  ]
}
```

---

### GET `/api/open-data/year-over-year`

Returns NDVI trend data across years for time-series charts.

**Response `200`:**
```json
{
  "yearly_data": [
    { "year": 2015, "ndvi_mean_june": 0.31 },
    { "year": 2016, "ndvi_mean_june": 0.28 },
    { "year": 2024, "ndvi_mean_june": 0.24 },
    { "year": 2025, "ndvi_mean_june": 0.19 },
    { "year": 2026, "ndvi_mean_june": 0.17 }
  ],
  "trend": "declining",
  "baseline_mean": 0.29
}
```

---

### GET `/api/open-data/forecast`

Returns the multi-period rainfall and vegetation forecast.

**Response `200`:**
```json
{
  "forecast_periods": [
    { "period": "7-day", "rainfall_mm": 3.2, "condition": "dry" },
    { "period": "14-day", "rainfall_mm": 11.8, "condition": "below_normal" },
    { "period": "30-day", "rainfall_mm": 22.0, "condition": "below_normal" }
  ],
  "conditions": "Below-normal rainfall expected. Continued pasture stress likely."
}
```

---

## Voice & Telephony

These endpoints are called by **Africa's Talking** webhooks — not by operators directly. They accept `application/x-www-form-urlencoded` bodies (AT's default).

### POST `/api/voice-callback`

Called by AT when an outbound call connects. ArdaLink responds with XML to open an audio stream.

**Request (form-encoded):**
```
callerNumber=+254711082200
destinationNumber=+254XXXXXXXXX
sessionId=AT_SESSION_abc123
direction=Outbound
```

**Response `200` (XML):**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream url="wss://your-domain.com/api/voice-stream?phone=%2B254711082200"/>
</Response>
```

---

### POST `/api/voice-events`

Called by AT with call lifecycle events (ringing, answered, completed).

**Request (form-encoded):**
```
sessionId=AT_SESSION_abc123
callSessionState=Completed
durationInSeconds=187
callerNumber=+254711082200
```

**Response `200`:**
```json
{ "ok": true }
```

---

### POST `/api/ussd-callback`

Called by AT each time the herder makes a USSD menu selection.

**Request (form-encoded):**
```
sessionId=ATUSSDSession_xyz
serviceCode=*123*8#
phoneNumber=+254711082200
text=1*1
```

`text` accumulates selections: `"1"` → first menu, `"1*1"` → first item in first submenu.

**Response `200` (plain text):**
```
CON Hali ya Ukame - Bula Pesa
NDVI: -38% chini ya kawaida
Hali: MBAYA SANA (VCI 22)

0. Rudi
```

Or to end the session:
```
END Asante. ArdaLink itapiga simu hivi karibuni.
```

---

### POST `/api/sms-callback`

Called by AT when a herder sends an SMS keyword.

**Request (form-encoded):**
```
from=+254711082200
to=+254XXXXXXXXX
text=BULA
id=SMS_msg_001
date=2026-06-18 11:04:00
```

**Response `200` (plain text):**
```
Hali ya ukame Bula Pesa: NDVI -38% chini ya kawaida. VCI 22 - Hali mbaya.
ArdaLink itapiga simu hivi karibuni. Jibu ONGEA ukitaka msaada sasa.
```

---

### POST `/api/call-tokens`

Issues a single-use authentication token for browser voice sessions.

**Request:**
```json
{
  "phone": "+254711082200",
  "ttl": 3600
}
```

**Response `200`:**
```json
{
  "token": "tok_a1b2c3d4e5f6..."
}
```

---

## Public Talk (Browser Voice)

Allows authenticated browsers to conduct voice sessions — used for operator testing and demos.

### GET `/api/talk/config`

Returns the browser voice feature flag and allowed origins.

**Response `200`:**
```json
{
  "enabled": true,
  "originWhitelist": ["localhost", ".replit.app", "your-domain.com"]
}
```

---

## Health

### GET `/api/healthz`

Liveness check for container orchestration and uptime monitors.

**Response `200`:**
```json
{
  "status": "ok",
  "service": "ardalink-api",
  "version": "1.0.0"
}
```

---

## WebSocket Protocols

### `WS /api/voice-stream?phone=<E.164>`

Bidirectional WebSocket bridge between Africa's Talking audio and Azure OpenAI Realtime.

**Connection:** Opened by Africa's Talking after `/api/voice-callback` instructs it via XML.

```mermaid
sequenceDiagram
    participant AT as Africa's Talking
    participant API as ardalink-api
    participant Azure as Azure OpenAI Realtime

    AT->>API: WS Connect /api/voice-stream?phone=+254711082200
    API->>Azure: WS Connect (gpt-4o-realtime)
    Azure-->>API: session.created
    API->>Azure: session.update (Swahili system prompt)

    loop Audio Exchange
        AT->>API: Binary mulaw audio frame
        API->>Azure: input_audio_buffer.append (base64 PCM)
        Azure-->>API: response.audio.delta (base64 PCM)
        API->>AT: Binary mulaw audio frame
    end

    Azure-->>API: response.done + transcription
    API->>API: Extract BCS + indicators via GPT-4o
    API->>DB: INSERT INTO ground_truth_reports
    AT->>API: WS Close
    API->>Azure: WS Close
```

**Audio format:** mulaw (µ-law), 8kHz, mono (Africa's Talking default)

**Azure events handled:**

| Event | Description |
|-------|-------------|
| `session.created` | Connection established |
| `response.audio.delta` | Streamed audio chunk from AI |
| `response.done` | Full turn complete |
| `conversation.item.input_audio_transcription.completed` | Herder speech transcribed |
| `response.text.done` | Final transcript ready for extraction |

---

### `WS /api/browser-voice-stream?token=<token>`

Browser voice WebSocket — requires a valid single-use token from `/api/call-tokens`.

- Token is validated against Redis store on connection.
- Token is consumed (deleted) on first use.
- Origin header is validated against `originWhitelist`.
- Protocol is otherwise identical to `/api/voice-stream`.

---

## Cross-References

- **Voice flow detail:** [`voice.md`](./voice.md)
- **Satellite data format:** [`satellite.md`](./satellite.md)
- **Authentication & RLS:** [`security.md`](./security.md)
- **Database schemas:** [`data.md`](./data.md)
