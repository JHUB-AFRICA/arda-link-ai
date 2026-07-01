# ArdaLink Feature Plan: GEE Satellite Data → Herder Interfaces

**Created**: 2026-07-01
**Author**: ArdaLink Engineering Team
**Status**: Planning Phase

---

## Executive Summary

This plan defines the implementation of **live Google Earth Engine (GEE) satellite data** for drought/vegetation briefings, followed by **herder-facing interfaces (USSD, SMS)**.

**Problem**: GEE code exists but no route triggers it. Herders have no interface to access intelligence.

**Solution**:
1. Wire up existing GEE code via API routes and scheduling
2. Integrate satellite data into intelligence briefs
3. Create herder-facing USSD and SMS interfaces

---

## Current State Analysis

### What EXISTS ✅

| Component | Location | Status |
|---|---|---|
| **GEE Python Pipeline** | `ardalink-engine/src/pipeline/satellite.py` | ✅ Complete - fetch_vegetation_index(), VCI computation, urban mask, Prosopis penalty |
| **GEE Initialization** | `ardalink-engine/src/pipeline/gee.py` | ✅ Complete - service account auth, lazy init |
| **Node Satellite Module** | `ardalink-api/src/lib/satellite.ts` | ✅ Complete - fetchLiveVegetation(), Sentinel-2, NDVI/NDRE/RED_EDGE, anomaly computation |
| **Database Schema** | `satelliteSnapshots.ts` | ✅ Complete - RLS-enabled, JSONB result field |
| **Documentation** | `Arda-link-AI-Docs/satellite.md` | ✅ Complete - pipeline, indices, wards, scheduling |
| **Climate Integration** | `openData.ts` | ✅ Complete - Open-Meteo, air quality |
| **Intelligence Layer** | `llm/` directory | ✅ Complete - z.ai + MiniMax LLM registry |

### What's MISSING ❌

| Gap | Impact | Priority |
|---|---|---|
| **No `/api/satellite` route** | GEE code never called | **P0** |
| **No scheduler** | No automated data fetching | **P0** |
| **Brief integration** | Satellite data not in briefs | **P1** |
| **USSD endpoint** | Herders can't dial in | **P1** |
| **SMS endpoint** | Herders can't text queries | **P1** |
| **Engine baseline population** | No historical comparison | **P2** |

---

## Feature Breakdown

### FEATURE 1: GEE Satellite API Route

**Problem**: Existing GEE code has no HTTP endpoint to trigger it.

**Solution**: Create `/api/satellite` route that calls the Python engine and returns live VCI/NDVI data.

**Branch**: `feature/satellite-api-route`

**Files to Create/Modify**:
```
ardalink-api/
  src/routes/satellite.ts           [NEW]
  src/lib/engine.ts                 [MODIFY - add GEE client]
ardalink-engine/
  ardalink_engine/src/api/satellite.py  [NEW]
  ardalink_engine/main.py           [MODIFY - add route]
```

**API Contract**:
```typescript
GET /api/satellite/vci?ward=bula-pesa
Response: {
  ward_id: "bula-pesa",
  vci: 22.1,
  ndvi_now: 0.17,
  ndvi_min: 0.08,
  ndvi_max: 0.45,
  urban_masked: true,
  prosopis_factor: 0.85,
  image_dates: ["2026-06-20", "2026-06-12", ...],
  captured_at: "2026-07-01T10:30:00Z"
}

POST /api/satellite/trigger
Response: {
  status: "processing",
  wards: ["bula-pesa", "garbatulla", "merti"],
  started_at: "2026-07-01T10:30:00Z"
}
```

**Acceptance Criteria**:
- [ ] `GET /api/satellite/vci?ward=bula-pesa` returns live MODIS VCI data
- [ ] `POST /api/satellite/trigger` fetches data for all demo wards
- [ ] Results written to `satellite_snapshots` table
- [ ] Returns 503 with clear message when GEE credentials missing
- [ ] Unit tests for satellite route

---

### FEATURE 2: Satellite Scheduler

**Problem**: GEE data needs periodic refresh (weekly in dry season, monthly in wet).

**Solution**: Node-cron job that triggers `/api/satellite/trigger` on schedule.

**Branch**: `feature/satellite-scheduler`

**Files to Create/Modify**:
```
ardalink-api/
  src/jobs/satelliteJob.ts          [NEW]
  src/jobs/index.ts                 [NEW]
  src/index.ts                       [MODIFY - start jobs]
```

**Schedule**:
- Dry season (Jun-Sep, Jan-Mar): Weekly (Sunday 6AM)
- Wet season (Oct-Dec, Apr-May): Monthly (1st 6AM)

**Acceptance Criteria**:
- [ ] Job runs on schedule without manual trigger
- [ ] Logs start/end with ward count
- [ ] Handles GEE errors gracefully (logs but continues)
- [ ] Can be disabled via `SATELLITE_JOB_ENABLED=false`

---

### FEATURE 3: Intelligence Brief Integration

**Problem**: Satellite data not included in LLM briefings for herders.

**Solution**: Feed satellite VCI/NDVI into the intelligence brief prompt.

**Branch**: `feature/brief-satellite-integration`

**Files to Create/Modify**:
```
ardalink-api/
  src/lib/intelligence.ts           [MODIFY - add satellite context]
  src/routes/intelligence.ts        [MODIFY - include satellite data]
```

**Brief Context Addition**:
```typescript
// Add to brief context:
satellite_status: {
  vci: 22.1,
  drought_class: "severe",  // VCI < 35
  ndvi_vs_baseline: -38.5,  // % change
  stressed_pixel_pct: 68.4,
  image_freshness: "2 days ago"
}
```

**Acceptance Criteria**:
- [ ] Brief includes current VCI and drought classification
- [ ] Brief includes NDVI vs baseline percentage
- [ ] Brief degrades gracefully when no satellite data
- [ ] LLM uses satellite data in recommendations

---

### FEATURE 4: USSD Interface

**Problem**: Herders with feature phones (40% in Isiolo) have no way to access the system.

**Solution**: `*123*8#` USSD menu that returns satellite-based intelligence in Swahili.

**Branch**: `feature/ussd-interface`

**Files to Create/Modify**:
```
ardalink-api/
  src/routes/ussd.ts                 [MODIFY - make functional]
  src/lib/ussdSession.ts             [NEW]
  src/lib/ussdPrompts.ts             [NEW]
```

**USSD Menu Flow**:
```
*123*8#
├─ 1: Bula Pesa
├─ 2: Garbatulla
├─ 3: Merti
└─ 4: About ArdaLink

Select 1 →
├─ 1: Hali ya nyasi (Pasture status)
├─ 2: Mtihani wa mifugo (Livestock check)
└─ 3: Ripoti kamili (Full report)
```

**Response Format (Swahili)**:
```
CON Bula Pesa - Hali ya Nyasi
NDVI: 0.17 (Maskini diki)
VCI: 22.1 (Bukoa kali)
Picha: 2 siku iliyopita
0. Nyuma  1. Endelea  2. Ripoti kamili
```

**Acceptance Criteria**:
- [ ] `POST /api/ussd` handles session flow
- [ ] Menu navigation works (0 for back, 99 for home)
- [ ] Returns Swahili responses with satellite data
- [ ] Graceful fallback when data unavailable
- [ ] Session timeout after 60s inactivity

---

### FEATURE 5: SMS Keyword Interface

**Problem**: Herders need on-demand SMS access to intelligence (works on any phone).

**Solution**: Keyword-based SMS system - text "BULA" to get Bula Pesa status.

**Branch**: `feature/sms-keyword-interface`

**Files to Create/Modify**:
```
ardalink-api/
  src/routes/sms.ts                  [NEW]
  src/lib/smsParser.ts               [NEW]
ardalink-engine/
  ardalink_engine/src/api/sms.py     [NEW - if needed for AT integration]
```

**SMS Keywords**:
```
BULA     → Bula Pesa ward status
GAR      → Garbatulla ward status
MERTI    → Merti ward status
MALISHO  → All wards summary (pasture focus)
MAJI     → Water point status
MSAADA   → Help/info
```

**Response Format (Swahili)**:
```
ArdaLink: Bula Pesa
NDVI: 0.17 (maskini)
VCI: 22.1 (bukoa)
Maoni: Epua kusini-mashariki.
Tuma RIPOTI BULA kwa maelezo zaidi.
```

**Acceptance Criteria**:
- [ ] Africa's Talking SMS webhook wired
- [ ] All keywords return appropriate responses
- [ ] Swahili messages with practical recommendations
- [ ] Graceful error handling
- [ ] Rate limiting (max 5 SMS/herder/day)

---

### FEATURE 6: Engine Baseline Backfill

**Problem**: `baseline_aggregate` table empty - no historical comparison for VCI.

**Solution**: One-time backfill script to populate 11-year Sentinel-2 baseline.

**Branch**: `feature/baseline-backfill`

**Files to Create/Modify**:
```
ardalink-engine/
  scripts/backfill_baseline.py      [NEW]
  ardalink_engine/src/api/baseline.py  [MODIFY if exists]
```

**Baseline Data**:
- Source: Sentinel-2 archive (2015-2025)
- Per-ward, per-month: p50, p5, p95 for NDVI, NDRE, RED_EDGE
- Optional per-pixel sparse grid

**Acceptance Criteria**:
- [ ] Script populates `baseline_aggregate` for all demo wards
- [ ] 11-year monthly medians computed correctly
- [ ] Idempotent (safe to re-run)
- [ ] Runtime < 30 minutes for all wards

---

## Feature Branch Strategy

```
dev (main development branch)
├── feature/satellite-api-route         [1st - unblocks all others]
├── feature/satellite-scheduler         [2nd - automated refresh]
├── feature/brief-satellite-integration [3rd - data in briefs]
├── feature/ussd-interface              [4th - herder interface 1]
├── feature/sms-keyword-interface       [5th - herder interface 2]
└── feature/baseline-backfill           [parallel - P2, can defer]
```

**Dependencies**:
```
satellite-api-route (BLOCKS)
  ├── satellite-scheduler
  ├── brief-satellite-integration
  ├── ussd-interface
  └── sms-keyword-interface
```

---

## Implementation Order

### Phase 1: Foundation (Week 1)
1. `feature/satellite-api-route` - Wire up GEE
2. `feature/satellite-scheduler` - Automate it
3. Manual testing with real GEE calls

### Phase 2: Intelligence (Week 2)
4. `feature/brief-satellite-integration` - Data in briefs
5. Test LLM prompt with satellite context

### Phase 3: Herder Interfaces (Week 3-4)
6. `feature/ussd-interface` - Dial-in access
7. `feature/sms-keyword-interface` - Text-based access
8. Field testing with demo users

### Phase 4: Enhancement (Optional)
9. `feature/baseline-backfill` - Historical comparison

---

## Testing Strategy

### Unit Tests
- All new routes (satellite, USSD, SMS)
- LLM prompt variations with/without satellite data

### Integration Tests
- End-to-end: GEE → Engine → API → Database
- USSD session flow
- SMS keyword parsing

### Field Tests (Isiolo)
- 5 herders test USSD interface
- 10 SMS queries per keyword
- Feedback loop on Swahili phrasing

---

## Open Questions

1. **GEE Credentials**: Service account JSON ready? (`GEE_PRIVATE_KEY`, `GEE_SERVICE_ACCOUNT`)
2. **Africa's Talking**: SMS/USSD keys procured? 3-week lead time
3. **USSD Shortcode**: `*123*8#` approved by Safaricom?
4. **Swahili Prompts**: Co-design with Isiolo pastoralists?

---

## Success Metrics

| Metric | Target | How Measured |
|---|---|---|
| Satellite freshness | < 7 days old | `newest_image_date` in API response |
| API response time | < 3s p95 | API logs |
| USSD completion rate | > 80% | Session analytics |
| SMS delivery rate | > 95% | Africa's Talking DLRs |
| Herder comprehension | > 70% understand | Field survey |

---

## Next Steps

1. ✅ **GEE credentials available** (from STATUS.md - "key wired, not mocked")
2. ❌ **Create feature branches** (pending approval)
3. ❌ **Start Phase 1** (satellite-api-route)

---

*Last updated: 2026-07-01*
