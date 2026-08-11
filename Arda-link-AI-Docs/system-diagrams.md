# ArdaLink — System diagrams

Every diagram here is Mermaid — renders natively in GitHub, VS Code
preview, Notion, and Obsidian. Everything is grouped by *who starts
the flow*:

| Section | Trigger | What it covers |
|---|---|---|
| §1 | — | System topology (one big picture) |
| §2 | Herder | SMS · USSD · voice pipelines |
| §3 | The clock | Scheduled jobs (forecast, satellite, VCI backfill) |
| §4 | Africa's Talking | Delivery, opt-out, subscription callbacks |
| §5 | Ops user | Login, verify-a-lead, decline, heatmap toggle |
| §6 | The flywheel | How every herder report reshapes the next herder's brief |
| §7 | All actors | Use-case map |

> Pre-launch pilot. Every phone number below is a test fixture.

---

## 1. System topology

```mermaid
flowchart LR
    %% External providers
    subgraph EXT[External providers]
      direction TB
      AT[Africa's Talking<br/>SMS + USSD + Voice]
      GEE[Google Earth Engine<br/>Sentinel-2 + MODIS]
      OM[Open-Meteo<br/>rainfall + observation]
      WPDx[WPDx open data<br/>water points, 2012]
      AZS[Azure Speech<br/>TTS + STT]
      AZO[Azure OpenAI<br/>GPT-5-mini]
    end

    %% Herder edge
    subgraph HERDER[Pastoralist]
      PHONE[2G phone]
    end

    %% ArdaLink stack
    subgraph STACK[ArdaLink stack]
      direction TB
      TUN[Cloudflare tunnel]
      WEB[web-proxy :8080<br/>SPA + api proxy]
      API[api :3000<br/>Node/Express]
      ENG[engine :5001<br/>Python/FastAPI]
      DASH[Dashboard SPA<br/>Ground Truth + Map tabs]
      TALK[Talk SPA]
      JOBS[Scheduled jobs<br/>forecast · satellite · vci-backfill]
    end

    %% Data plane
    subgraph DATA[Data plane]
      direction TB
      SB[(Supabase — source of truth<br/>satellite_indices · 1 093<br/>satellite_cell_indices · 2.36 M<br/>ward_cells · 26 975<br/>weather_forecast · 3 080<br/>weather_data · 30 growing<br/>pastoralists · leads · interactions<br/>ground_truth_calls)]
      LOCAL[(Local Postgres<br/>admin_users · tenants<br/>ground_truth_reports mirror)]
    end

    OPS[Ops user]

    %% Flows
    PHONE <-->|SMS / USSD / voice| AT
    AT <-->|webhooks| TUN
    TUN --> WEB
    WEB -->|/api/*| API
    WEB -->|SPA static| DASH
    WEB -->|SPA static| TALK

    API --> SB
    API --> LOCAL
    API -->|satellite fetch| ENG
    ENG --> GEE
    JOBS --> OM
    JOBS --> API
    API -->|TTS + STT| AZS
    API -->|extract| AZO
    API -.->|snapshot| WPDx
    API -->|outbound SMS + voice| AT

    DASH -->|read + verify + heatmap| API
    OPS --> DASH

    classDef ext fill:#111827,stroke:#4b5563,color:#e5e7eb;
    classDef stack fill:#0f172a,stroke:#22c55e,color:#e5e7eb;
    classDef data fill:#1e1b4b,stroke:#8b5cf6,color:#e5e7eb;
    class EXT,AT,GEE,OM,WPDx,AZS,AZO ext;
    class STACK,TUN,WEB,API,ENG,DASH,TALK,JOBS stack;
    class DATA,SB,LOCAL data;
```

**Read it as:** the herder never touches us directly — Africa's
Talking is the only edge. The api coordinates every other piece.
Supabase is source of truth; the local database keeps a resilient
mirror plus what Supabase doesn't yet host (admin login, tenant
settings).

---

## 2. Herder flows

### 2.1 SMS keywords — one diagram, four keywords

Every keyword follows the same handler shape: **inbound webhook →
identify caller → compose reply → send outbound SMS → log both
sides**.

```mermaid
sequenceDiagram
    autonumber
    actor H as Herder
    participant AT as AT SMS gateway
    participant API as api :3000
    participant SB as Supabase
    participant OUT as AT outbound SMS

    H->>AT: Text keyword to 48910<br/>(BULA · MALISHO · RIPOTI · STOP)
    AT->>API: POST /api/sms-callback
    API->>SB: identityForPhone(from)
    SB-->>API: verified · lead · unknown

    alt BULA (drought brief)
      API->>SB: latest ward NDVI + forecast + peer signal + water-point overlay
      API->>API: buildLocalizedBrief(sw|en)
    else MALISHO (water points)
      API->>API: WPDx nearest + ground-truth overlay (last 90 days)
    else RIPOTI (my last report)
      API->>SB: recentGroundTruth(phone)
    else STOP (opt out)
      API->>SB: setOptedOut(phone) — cross-channel
    end

    API->>OUT: sendSmsViaAt(phone, reply text)
    OUT-->>H: SMS lands
    API->>SB: logLeadInteraction(inbound + reply)
```

**Note:** `STOP` sends an empty outbound (Africa's Talking convention);
every future dispatch to that phone is blocked at the api boundary.

### 2.2 USSD menu — the 5 items

```mermaid
sequenceDiagram
    autonumber
    actor H as Herder
    participant AT as AT USSD gateway
    participant API as api :3000
    participant SB as Supabase

    H->>AT: Dial service code
    AT->>API: POST /api/ussd-callback text=""
    API-->>AT: CON menu<br/>1 Brief · 2 Water · 3 Voice · 4 Exit · 5 Register
    AT-->>H: Show menu

    alt Press 1 — Brief
      API->>SB: identity + ward signals
      API-->>AT: END with Kiswahili brief line
    else Press 2 — Water
      API->>API: WPDx nearest + ground-truth overlay
      API-->>AT: END with 5 nearest water points + status
    else Press 3 — Voice
      API->>API: mint call token
      API->>OUT: outbound voice call to phone
      API-->>AT: END "Tutakupigia sasa"
    else Press 4 — Exit
      API-->>AT: END "Kwaheri"
    else Press 5 — Jisajili
      Note over API,SB: see §2.3
    end
```

### 2.3 Jisajili — 4-screen self-enrolment

```mermaid
sequenceDiagram
    autonumber
    actor H as Herder
    participant AT as AT USSD gateway
    participant API as api :3000
    participant SB as Supabase
    participant SMS as AT outbound SMS
    participant DASH as Dashboard

    H->>AT: Press 5 from main menu
    API-->>AT: CON "Andika jina lako:"
    AT-->>H: Prompt for name

    H->>AT: "Amina Wanjiku"
    API-->>AT: CON ward picker (5 wards)
    AT-->>H: Show ward menu

    H->>AT: Press ward digit
    API-->>AT: CON language picker
    AT-->>H: Kiswahili / English

    H->>AT: Press language digit
    API->>SB: upsertPastoralistLead(phone, name, lang, ward)
    API->>SB: logLeadInteraction(channel=ussd)

    par Fire-and-forget welcome SMS
      API->>SMS: sendSmsViaAt(phone, "Karibu ArdaLink…")
      SMS->>H: Welcome SMS lands
      API->>SB: logLeadInteraction(channel=sms, delivery=sent)
    end

    API-->>AT: END "Umesajiliwa. Tutakupigia kesho."
    AT-->>H: Confirmation

    Note over DASH,SB: 30 s later
    DASH->>SB: leads + interactions
    SB-->>DASH: Amina appears
```

**Read it as:** four screens, one welcome SMS, two rows in Supabase.
The USSD `END` comes back to the herder before the SMS even
dispatches — never make them wait.

### 2.4 Voice pipeline

```mermaid
sequenceDiagram
    autonumber
    actor H as Herder
    participant AT as AT voice number
    participant API as api :3000
    participant AZS as Azure Speech
    participant AZO as Azure OpenAI
    participant SB as Supabase
    participant SMS as AT outbound SMS

    H->>AT: Dial number (or receive outbound call)
    AT->>API: POST /api/voice-callback (call started)
    API->>API: voiceOpener(phone, ward, sw|en)
    API-->>AT: XML — Kiswahili greeting + menu (1-7)
    AT-->>H: Plays greeting + prompt

    H->>AT: Press menu digit
    AT->>API: POST /api/voice-callback (digit)
    API-->>AT: XML — spoken confirmation + Record 20 s

    H->>AT: Speak reply, press # (or timeout)
    AT->>API: POST /api/voice-callback (recording URL)

    API->>API: download MP3 → transcode to WAV
    API->>AZS: STT (sw-KE, fall back en-KE)
    AZS-->>API: transcript
    API->>AZO: extract indicators (BCS, water status, etc.)
    AZO-->>API: structured facts
    API->>SB: insertGroundTruthCall(...)

    par Summary SMS closes the loop
      API->>SMS: sendSmsViaAt(phone, Kiswahili summary)
      SMS->>H: SMS lands with what we heard
    end

    Note over API,SB: also fires lifecycle events → §4.4
```

**Read it as:** three round-trips (greeting → menu → recording). At
the end the herder always gets an SMS summary of what we captured —
no black hole.

---

## 3. Scheduled jobs

### 3.1 Forecast job — every 6 hours

```mermaid
sequenceDiagram
    autonumber
    participant SCH as Scheduler (setInterval)
    participant API as forecastJob
    participant OM as Open-Meteo
    participant SB as Supabase

    SCH->>API: fire
    API->>SB: listActiveWards()
    SB-->>API: 5 wards

    loop per ward
      API->>OM: 14-day ensemble (forecast)
      OM-->>API: daily arrays
      API->>SB: persistForecast(14 rows) → weather_forecast

      API->>OM: past_days=30 (observation)
      OM-->>API: 30 days of past
      API->>SB: upsert_weather_data RPC<br/>(rainfall_30d + humidity + temp + ET0)
    end

    API->>SB: refresh_satellite_indices_latest RPC
    Note over API,SB: single log line summarises the cycle
```

### 3.2 Satellite job — as-needed

```mermaid
sequenceDiagram
    autonumber
    participant SCH as Scheduler
    participant API as satelliteJob
    participant ENG as engine :5001
    participant GEE as Google Earth Engine
    participant SB as Supabase

    SCH->>API: fire (or manual trigger)
    API->>SB: latestSatelliteFor(ward) — is it stale?
    alt stale
      API->>ENG: /api/v1/satellite/vci?ward_id=…
      ENG->>GEE: Sentinel-2 monthly composite
      GEE-->>ENG: NDVI + friends
      ENG-->>API: {ndvi, vci, prosopis_share, …}
      API->>SB: upsert satellite_indices row
    else fresh
      API->>API: skip
    end
```

### 3.3 VCI backfill — on demand

```mermaid
sequenceDiagram
    autonumber
    actor O as Ops user
    participant DASH as Dashboard
    participant API as /api/ops/vci-backfill
    participant SB as Supabase

    O->>DASH: Click "Run VCI backfill"
    DASH->>API: POST (Bearer JWT)
    API->>SB: satellite_indices WHERE vci_value IS NULL
    SB-->>API: 776 rows to fill

    loop each row
      API->>SB: fetch 11-yr envelope for (ward, month)
      API->>API: computeVci(ndvi, envelope)
      API->>SB: UPDATE satellite_indices SET vci_value=…
    end

    API-->>DASH: {backfilled: 774, skipped: 2}
```

---

## 4. Africa's Talking callbacks

Every event AT sends us has its own handler. All are idempotent —
duplicate deliveries are safe.

### 4.1 SMS delivery report

```mermaid
sequenceDiagram
    autonumber
    participant AT as AT (post-delivery)
    participant API as /api/sms-delivery-callback
    participant SB as Supabase

    AT->>API: id + status (Sent | Delivered | Failed)
    API->>SB: logLeadInteraction(channel=sms,<br/>keyword=delivery:sent|delivered|failed)
```

### 4.2 SMS opt-out (bulk)

```mermaid
sequenceDiagram
    autonumber
    participant AT as AT (subscriber opts out)
    participant API as /api/sms-optout-callback
    participant SB as Supabase

    AT->>API: phone + timestamp
    API->>SB: setOptedOut(phone) — flips flag on<br/>pastoralists AND pastoralist_leads
    API->>SB: logLeadInteraction(channel=sms, keyword=STOP)
```

### 4.3 Subscription notification

```mermaid
sequenceDiagram
    autonumber
    participant AT as AT (billing surface)
    participant API as /api/sms-subscription-callback
    participant SB as Supabase

    AT->>API: shortcode + phone + updateType
    API->>SB: logLeadInteraction(<br/>channel=sms, keyword=subscription:<updateType><br/>)
```

### 4.4 Voice call lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant AT as AT voice events
    participant API as /api/voice-events
    participant SB as Supabase

    AT->>API: callSessionState + duration + cost
    API->>SB: logLeadInteraction(channel=voice_event, raw_body=<full event>)
```

---

## 5. Ops flows

### 5.1 Login + dashboard boot

```mermaid
sequenceDiagram
    autonumber
    actor O as Ops user
    participant DASH as Dashboard SPA
    participant API as /api/auth/login
    participant DB as Local Postgres

    O->>DASH: email + password
    DASH->>API: POST credentials
    API->>DB: SELECT admin_users WHERE email=…
    API->>API: bcrypt verify · sign JWT (tenant_id, role)
    API-->>DASH: {token, tenant_id, role}

    par parallel dashboard fetches
      DASH->>API: /api/wards/map · timeseries · ops/leads · ops/interactions
    end
    DASH-->>O: rendered dashboard
```

### 5.2 Verify a lead

```mermaid
sequenceDiagram
    autonumber
    actor O as Ops user
    participant DASH as LeadsSection
    participant API as /api/ops/leads/:id/verify
    participant SB as Supabase
    participant SMS as AT outbound SMS

    O->>DASH: Click ✓ Verify (with note)
    DASH->>API: POST (Bearer JWT)
    API->>SB: upsertPastoralist(from lead fields)
    API->>SB: setLeadStatus(id, verified, promoted_pastoralist_id, verified_by)

    par Second welcome SMS
      API->>SMS: sendSmsViaAt(phone, "Umethibitishwa…")
      SMS->>O: (herder gets it too)
      API->>SB: logLeadInteraction(channel=sms, keyword=verified)
    end

    API-->>DASH: updated lead row
    DASH-->>O: green ✓ verified badge
```

### 5.3 Decline a lead

```mermaid
sequenceDiagram
    autonumber
    actor O as Ops user
    participant DASH as LeadsSection
    participant API as /api/ops/leads/:id/decline
    participant SB as Supabase

    O->>DASH: Click ✗ Decline (with reason)
    DASH->>API: POST
    API->>SB: setLeadStatus(id, declined, reason, declined_by)
    API-->>DASH: updated lead row
    Note over DASH,API: no SMS sent — decline is silent by policy
```

### 5.4 Heatmap toggle (both tabs)

```mermaid
sequenceDiagram
    autonumber
    actor O as Ops user
    participant DASH as Map / Ground Truth tab
    participant API as /api/wards/:id/cells/latest
    participant SB as Supabase

    O->>DASH: Toggle "Drought heatmap"
    par 5 wards in parallel (React Query)
      DASH->>API: /api/wards/241/cells/latest
      API->>SB: latest period_end for ward
      API->>SB: Range-paginated fetch (up to 3× 1000 rows)
      API-->>DASH: cells with NDVI + centroid + area
    and
      DASH->>API: /api/wards/242/cells/latest
    and
      DASH->>API: /api/wards/245/cells/latest
    and
      DASH->>API: /api/wards/246/cells/latest
    and
      DASH->>API: /api/wards/247/cells/latest
    end
    DASH-->>O: 3 274 coloured dots overlaid on the map
```

**Read it as:** the payload is capped per-ward and cached 30 min
client-side. Every fetch skips a Supabase view that used to time
out — the api reads the raw table + paginates around PostgREST's
1 000-row default.

---

## 6. The ground-truth flywheel

The single most important loop in the system: what one herder tells
us becomes the next herder's brief.

```mermaid
sequenceDiagram
    autonumber
    actor H1 as Herder Ali
    actor H2 as Herder Amina
    participant API as api
    participant SB as Supabase
    participant SMS as AT SMS

    Note over H1,SB: Day 1 — Ali reports
    H1->>API: Voice / SMS: "Bwawa la Burat linafanya kazi"
    API->>API: extract water_point_name + status = OK
    API->>SB: insert ground_truth_calls (water_point_status="working")

    Note over H2,SB: Day 3 — Amina texts BULA
    H2->>API: SMS BULA
    API->>SB: recentWaterPointGroundTruth(90d)
    SB-->>API: Ali's report is still fresh
    API->>API: overlayStatusFromGroundTruth(wpdx, ali_report)<br/>→ Burat is now marked "working"
    API->>SB: peerSignalForWard(7d) — how many other herders reported this week?
    API->>API: buildLocalizedBrief(sw)<br/>"Bwawa la Burat linafanya kazi (Ali aliripoti)."
    API->>SMS: sendSmsViaAt(amina, brief)
    SMS-->>H2: Amina reads a brief informed by Ali's report
```

**Two windows in play:**

| Window | Purpose |
|---|---|
| **7 days** | Peer mood + pasture — stale fast |
| **90 days** | Water-point status — changes seasonally |

Both surface only when at least two herders have reported, so no
one herder's echo dominates.

---

## 7. Actors + use cases

```mermaid
graph TB
    P((👤 Pastoralist))
    O((🧑‍💻 Ops user))
    D((🛰 External data))
    C((⏰ Clock / scheduler))

    subgraph SYS[ArdaLink system]
      direction TB

      subgraph PA[Herder-facing]
        UC1[Get drought brief · SMS BULA / USSD 1]
        UC2[Find water · SMS MALISHO / USSD 2]
        UC3[Read my last report · SMS RIPOTI]
        UC4[Self-enrol · USSD 5]
        UC5[Ask for a voice call · USSD 3 / SMS ONGEA]
        UC6[Give voice report · dial in / accept callback]
        UC7[Opt out · SMS STOP]
      end

      subgraph OA[Ops]
        UC10[View live callback log]
        UC11[Verify a lead → promote to pastoralist]
        UC12[Decline a lead]
        UC13[Toggle drought heatmap on the map]
        UC14[View greenness + rainfall time-series]
        UC15[Trigger VCI backfill on demand]
      end

      subgraph AJ[Automated]
        UC20[Fetch satellite greenness · monthly]
        UC21[Fetch rainfall forecast + observation · every 6 h]
        UC22[Refresh materialised view · every 6 h]
        UC23[Transcribe voice recording · Azure]
        UC24[Extract structured facts · Azure OpenAI]
        UC25[Log every AT callback · delivery / opt-out / subscription]
      end
    end

    P --> UC1
    P --> UC2
    P --> UC3
    P --> UC4
    P --> UC5
    P --> UC6
    P --> UC7

    O --> UC10
    O --> UC11
    O --> UC12
    O --> UC13
    O --> UC14
    O --> UC15

    D --> UC20
    D --> UC21
    D --> UC23
    D --> UC24
    D --> UC25

    C --> UC20
    C --> UC21
    C --> UC22

    UC5 -.->|dispatches| UC6
    UC6 -.->|includes| UC23
    UC6 -.->|includes| UC24
    UC11 -.->|welcome SMS| UC1
    UC1 -.->|reads| UC20
    UC1 -.->|reads| UC21
    UC13 -.->|reads| UC20

    classDef actor fill:#111827,stroke:#f59e0b,color:#fbbf24;
    class P,O,D,C actor;
```

**Read it as:** four actors — herder, ops user, external data
provider, and the clock. Every use case has an owner. Dotted lines
show which capabilities extend or include others (e.g. verifying a
lead automatically triggers a welcome SMS).

---

## Diagram maintenance rules

- **Update whenever:** a new external provider is added, a new
  persistent table lands in Supabase, a new user-facing use case
  ships, or a scheduled job's cadence changes.
- **Do not include:** transient in-process caches, individual DB
  rows, log lines. Kept at the system + capability level.
- **Preview locally:**
  ```bash
  npx @mermaid-js/mermaid-cli -i system-diagrams.md -o diagrams.png
  ```
