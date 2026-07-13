# ArdaLink — System UML Diagrams

Rendered natively by GitHub, VS Code preview, Notion (with the Mermaid
integration), and Obsidian. All three diagrams are kept in one file so
the audit reviewer can see topology, flow, and capability in one scroll.

Status: **pre-launch pilot**. All actor phones and data referenced in
these diagrams are test / synthetic. No real herders enrolled yet.

---

## 1. Component diagram — system topology + data flow

Shows every deployed piece of ArdaLink and how they connect. External
providers (Africa's Talking, Google Earth Engine, Open-Meteo, WPDx,
Azure Speech, Azure OpenAI) are the black-boxes the system depends on.
Supabase Postgres is the source-of-truth data plane; local Postgres is
a resilient mirror.

```mermaid
flowchart LR
    %% ── External providers ────────────────────────────
    subgraph EXT[External providers]
      direction TB
      AT[Africa's Talking<br/>SMS + USSD + Voice]
      GEE[Google Earth Engine<br/>Sentinel-2 + MODIS]
      OM[Open-Meteo<br/>rainfall + forecast]
      WPDx[WPDx open data<br/>water points]
      AZS[Azure Speech<br/>TTS + STT]
      AZO[Azure OpenAI<br/>GPT-5 mini]
    end

    %% ── Herder-facing surfaces ────────────────────────
    subgraph HERDER[Pastoralist]
      PHONE[2G / smartphone<br/>+254712000004]
    end

    %% ── ArdaLink stack ────────────────────────────────
    subgraph STACK[ArdaLink stack]
      direction TB
      TUN[Cloudflare tunnel<br/>rotating public host]
      WEB[web-server.py :8080<br/>SPA + api proxy + gzip]
      API[ardalink-api :3000<br/>Node/Express + Drizzle]
      ENG[ardalink-engine :5001<br/>Python/FastAPI + GEE SDK]
      DASH[Dashboard SPA<br/>React + Recharts]
      TALK[Talk SPA<br/>WebRTC voice demo]
    end

    %% ── Data plane ────────────────────────────────────
    subgraph DATA[Data plane]
      direction TB
      SB[(Supabase Postgres<br/>source of truth<br/>satellite_indices<br/>weather_forecast<br/>pastoralists / _leads<br/>ground_truth_calls<br/>lead_interactions)]
      LOCAL[(Local Postgres<br/>mirror + RLS<br/>ground_truth_reports)]
    end

    %% ── Ops ───────────────────────────────────────────
    OPS[Ops user<br/>admin@ardalink.test]

    %% ── Flows ─────────────────────────────────────────
    PHONE <-->|SMS / USSD / voice call| AT
    AT <-->|form-encoded webhooks| TUN
    TUN --> WEB
    WEB -->|/api/*| API
    WEB -->|SPA static| DASH
    WEB -->|SPA static| TALK

    API --> SB
    API --> LOCAL
    API -->|/api/v1/satellite/*| ENG
    ENG --> GEE
    API --> OM
    API -->|TTS synth + STT| AZS
    API -->|indicator extract| AZO
    API -.->|snapshot| WPDx
    API -->|POST /messaging| AT
    API -->|POST /call| AT

    DASH -->|read + verify actions| API
    OPS --> DASH

    classDef ext fill:#111827,stroke:#4b5563,color:#e5e7eb;
    classDef stack fill:#0f172a,stroke:#22c55e,color:#e5e7eb;
    classDef data fill:#1e1b4b,stroke:#8b5cf6,color:#e5e7eb;
    class EXT,AT,GEE,OM,WPDx,AZS,AZO ext;
    class STACK,TUN,WEB,API,ENG,DASH,TALK stack;
    class DATA,SB,LOCAL data;
```

**Reading it:**
- Herder never talks to us directly — AT is the only edge. Every AT
  webhook lands on the tunnel, is proxied to the api, and the api
  replies (SMS body, USSD `CON`/`END` text, voice XML).
- Api is the coordinator. It reads Supabase for herder identity +
  satellite + weather, delegates raw GEE fetches to the Python engine,
  writes reports to both Supabase (source of truth) and local (mirror).
- Ops interacts only with the dashboard, never with production data
  directly.

---

## 2. Sequence diagram — USSD self-enrollment end-to-end (Jisajili flow)

The most complete existing loop-closure example: a herder dials USSD,
walks the 4-screen enrollment, lands in `pastoralist_leads`, gets a
welcome SMS, appears on the ops dashboard. Every arrow below is code
that runs today.

```mermaid
sequenceDiagram
    autonumber
    actor H as Herder<br/>+254799954672
    participant AT as Africa's Talking<br/>USSD gateway
    participant API as ardalink-api :3000
    participant SB as Supabase
    participant SMS as AT SMS<br/>outbound
    participant DASH as Dashboard<br/>(ops view)

    H->>AT: Dial *384*NNNN#
    AT->>API: POST /api/ussd-callback<br/>text=""
    API->>API: parseLastInput → level 0
    API-->>AT: CON menu (Jisajili at 5)
    AT-->>H: Show menu

    H->>AT: Press 5
    AT->>API: text="5"
    API->>SB: identityForPhone(phone)
    SB-->>API: null (new caller)
    API-->>AT: CON "Andika jina lako:"
    AT-->>H: Prompt for name

    H->>AT: Type "Amina Wanjiku"
    AT->>API: text="5*Amina Wanjiku"
    API-->>AT: CON ward picker (5 wards)
    AT-->>H: Show ward menu

    H->>AT: Press 3 (Ngare Mara)
    AT->>API: text="5*Amina Wanjiku*3"
    API-->>AT: CON language picker
    AT-->>H: Kiswahili / English

    H->>AT: Press 1 (Kiswahili)
    AT->>API: text="5*Amina Wanjiku*3*1"
    API->>SB: upsertPastoralistLead(<br/>phone, name, lang=sw,<br/>ward=245, source=ussd_self<br/>)
    SB-->>API: SbPastoralistLead row
    API->>SB: logLeadInteraction(<br/>channel=ussd, tier=lead, ...<br/>)

    par Fire-and-forget welcome SMS
      API->>SMS: sendSmsViaAt(phone, "Karibu ArdaLink...")
      SMS->>H: Welcome SMS lands
      SMS-->>API: 200 OK (message id + cost)
      API->>SB: logLeadInteraction(<br/>channel=sms, keyword=delivery:sent<br/>)
    end

    API-->>AT: END "Umesajiliwa. ArdaLink itakupigia simu kesho."
    AT-->>H: Confirmation screen

    Note over DASH,SB: 30s later
    DASH->>SB: GET api_phone_identity + lead_interactions
    SB-->>DASH: Amina appears in LeadsSection<br/>+ interaction in CallbackLog
```

**Reading it:**
- 4 USSD round-trips, 1 outbound SMS, 2 Supabase writes (lead +
  interaction), all instrumented.
- The SMS is fire-and-forget (`par` block) — USSD `END` returns to
  AT immediately so the herder isn't waiting for the SMS to dispatch.
- The dashboard sees the new lead within 30 seconds via the
  auto-refreshing panel.
- Every interaction — USSD keystroke, welcome SMS, delivery status —
  is a row in `lead_interactions` so the ops CallbackLog shows the
  entire timeline.

---

## 3. Use case diagram — actors + capabilities

Who does what. Three actors interact with the system: **Pastoralist**
(via 2G phone, real herder), **Ops user** (via dashboard, project
staff), and **External data provider** (AT / GEE / Open-Meteo — the
system consumes these).

```mermaid
graph TB
    %% ── Actors ────────────────────────────────────────
    P((👤 Pastoralist<br/>2G phone))
    O((🧑‍💻 Ops user<br/>dashboard))
    D((🛰 External data<br/>providers))

    %% ── System boundary ───────────────────────────────
    subgraph SYS[ArdaLink system]
      direction TB

      subgraph PA[Herder-facing use cases]
        UC1[Request drought brief<br/>SMS BULA]
        UC2[Find nearest water<br/>SMS MALISHO]
        UC3[Check my last report<br/>SMS RIPOTI]
        UC4[Self-enroll<br/>USSD Jisajili]
        UC5[Request voice call<br/>SMS/USSD ONGEA]
        UC6[Give voice report<br/>voice DTMF + record]
        UC7[Opt out<br/>SMS STOP]
      end

      subgraph OA[Ops use cases]
        UC10[View live callback log]
        UC11[Verify a lead<br/>promote to pastoralist]
        UC12[Decline a lead]
        UC13[Trigger VCI backfill]
        UC14[View NDVI + rainfall<br/>time-series per ward]
        UC15[View ward map<br/>PostGIS choropleth]
      end

      subgraph DA[Data-ingest use cases]
        UC20[Persist Sentinel-2 NDVI<br/>satellite job, monthly]
        UC21[Persist 14d rainfall forecast<br/>forecastJob, every 6h]
        UC22[Refresh WPDx snapshot<br/>manual, annual]
        UC23[Transcribe voice recording<br/>Azure Speech STT]
        UC24[Extract indicators<br/>GPT-5-mini]
      end
    end

    %% ── Pastoralist edges ─────────────────────────────
    P --> UC1
    P --> UC2
    P --> UC3
    P --> UC4
    P --> UC5
    P --> UC6
    P --> UC7

    %% ── Ops edges ─────────────────────────────────────
    O --> UC10
    O --> UC11
    O --> UC12
    O --> UC13
    O --> UC14
    O --> UC15

    %% ── External data edges ───────────────────────────
    D --> UC20
    D --> UC21
    D --> UC22
    D --> UC23
    D --> UC24

    %% ── Include / extend relations ────────────────────
    UC5 -.->|dispatches| UC6
    UC6 -.->|includes STT| UC23
    UC6 -.->|includes extract| UC24
    UC11 -.->|includes welcome SMS| UC1
    UC1 -.->|includes anomaly line| UC20
    UC1 -.->|includes forecast line| UC21

    classDef actor fill:#111827,stroke:#f59e0b,color:#fbbf24;
    classDef sys fill:#0f172a,stroke:#22c55e,color:#e5e7eb;
    class P,O,D actor;
```

**Reading it:**
- Pastoralist has 7 primary use cases, all channel-neutral (SMS,
  USSD, or voice depending on their preference).
- Ops has 6 dashboard-driven capabilities, split between reactive
  (view logs, verify) and proactive (trigger backfill).
- External data ingest is 5 background jobs — 3 scheduled, 2 called
  during voice pipeline execution.
- Dotted lines are `<<include>>` / `<<extend>>` — showing e.g. that
  requesting a voice call (UC5) dispatches the voice report use case
  (UC6), which itself includes STT + LLM extract.

---

## Diagram maintenance rules

- **When to update:** whenever a new external provider is added, a
  new persistent table lands in Supabase, or a new user-facing use
  case ships.
- **What NOT to include:** transient in-process caches, individual
  DB rows, log lines. Kept at the "system + capability" level.
- **Preview locally:**
  ```bash
  npx @mermaid-js/mermaid-cli -i system-diagrams.md -o diagrams.png
  ```
