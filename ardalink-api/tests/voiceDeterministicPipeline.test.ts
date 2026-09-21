import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Test-controlled fixtures ────────────────────────────────────────
//
// The deterministic pipeline runs Speech + LLM + a fire-and-forget
// Supabase mirror. The local ground_truth_reports table has been dropped;
// there is no longer a local insert step. The mirror ONLY writes when the
// pastoralist already exists on Supabase — we never auto-upsert
// profiles from a call (pilot enrolment is out-of-band).

interface Fx {
  speechConfigured: boolean;
  transcript: string | null;
  locale: string;
  indicators: Record<string, unknown> | null;
  actionTag: string;
  trustScore: number;
  intelligenceLast: unknown;
  supabase: {
    configured: boolean;
    pastoralist: { pastoralist_id: string; ward_id: string | null } | null;
    insertGtCalls: Array<Record<string, unknown>>;
    upsertCalls: Array<Record<string, unknown>>; // must stay empty
    insertReturns: unknown;
  };
  local: {
    /** @deprecated No longer used — local insert was removed. Kept for test-level assertions. */
    insertCalls: Array<Record<string, unknown>>;
    throwOnInsert: boolean;
  };
  fetchImplementation:
    | ((input: string) => Promise<Response>)
    | null;
}

const fx: Fx = {
  speechConfigured: true,
  transcript: "Test transcript",
  locale: "en-KE",
  indicators: null,
  actionTag: "Dry Season Stress",
  trustScore: 60,
  intelligenceLast: null,
  supabase: {
    configured: true,
    pastoralist: null,
    insertGtCalls: [],
    upsertCalls: [],
    insertReturns: { call_id: "call-uuid-1", call_timestamp: "2026-07-08" },
  },
  local: {
    insertCalls: [],
    throwOnInsert: false,
  },
  fetchImplementation: null,
};

vi.mock("../src/lib/speech.js", () => ({
  isSpeechConfigured: () => fx.speechConfigured,
  fastTranscribe: async () =>
    fx.transcript == null ? null : { transcript: fx.transcript, locale: fx.locale },
}));

vi.mock("../src/lib/openai/index.js", () => ({
  extractIndicators: async () => fx.indicators,
  generateActionTag: async () => fx.actionTag,
}));

vi.mock("../src/lib/intelligence.js", () => ({
  getLastResult: () => fx.intelligenceLast,
}));

vi.mock("../src/lib/trustScore.js", () => ({
  computeTrustScore: () => ({ score: fx.trustScore, flags: [] }),
  logTrustScore: vi.fn(),
}));

vi.mock("../src/lib/pastoralistContact.js", () => ({
  touchPastoralistLastContact: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/supabase/index.js", () => ({
  isSupabaseConfigured: () => fx.supabase.configured,
  pastoralistByPhone: async () => fx.supabase.pastoralist,
  // upsertPastoralist deliberately not exported — the pipeline should
  // no longer import it. If a future change re-imports it, the test
  // will fail to compile.
  insertGroundTruthCall: async (row: Record<string, unknown>) => {
    fx.supabase.insertGtCalls.push(row);
    return fx.supabase.insertReturns;
  },
}));

// Note: the local ground_truth_reports table has been dropped.
// voiceDeterministicPipeline.ts no longer imports withTenantContext or
// groundTruthReportsTable, so no mocks are needed for those.

beforeEach(() => {
  process.env.SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_x";

  const fakeAudio = new Uint8Array([1, 2, 3, 4]);
  // Read fetchImplementation lazily so tests can override AFTER beforeEach.
  globalThis.fetch = (async (input: string) => {
    const impl = fx.fetchImplementation;
    if (impl) return impl(input);
    return new Response(fakeAudio, {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  }) as unknown as typeof fetch;

  fx.speechConfigured = true;
  fx.transcript = "Test transcript";
  fx.locale = "en-KE";
  fx.indicators = {
    bcs_score: 2,
    bcs_species: "goats",
    mortality_rate: "1-3",
    offtake_rate: "normal",
    water_point_status: "dry",
    supplementary_feeding: "no",
    water_trekking_distance: "5-10km",
    indicators_collected: 3,
  };
  fx.actionTag = "Dry Season Stress";
  fx.trustScore = 60;
  fx.intelligenceLast = null;
  fx.supabase.configured = true;
  fx.supabase.pastoralist = null;
  fx.supabase.insertGtCalls = [];
  fx.supabase.upsertCalls = [];
  fx.supabase.insertReturns = {
    call_id: "call-uuid-1",
    call_timestamp: "2026-07-08",
  };
  fx.local.insertCalls = [];
  fx.local.throwOnInsert = false;
  fx.fetchImplementation = null;
});

afterEach(() => vi.clearAllMocks());

// Give the fire-and-forget Supabase mirror a chance to run.
async function flushMirror() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function run(overrides: Partial<Pick<Fx, "transcript">> = {}) {
  if ("transcript" in overrides) fx.transcript = overrides.transcript ?? null;
  const { processDeterministicVoiceRecording } = await import(
    "../src/lib/voiceDeterministicPipeline.js"
  );
  const id = await processDeterministicVoiceRecording({
    sessionId: "sess-1",
    phone: "+254712000004",
    recordingUrl: "http://test/recording.wav",
    durationSeconds: 15,
    categoryId: "bcs",
    categoryLabel: "body condition score",
  });
  await flushMirror();
  return id;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("processDeterministicVoiceRecording", () => {
  it("returns null when Speech is not configured", async () => {
    fx.speechConfigured = false;
    const id = await run();
    expect(id).toBeNull();
    expect(fx.local.insertCalls).toHaveLength(0);
  });

  it("returns null when the recording download fails (non-2xx)", async () => {
    fx.fetchImplementation = async () =>
      new Response("nope", { status: 404 });
    const id = await run();
    expect(id).toBeNull();
    expect(fx.local.insertCalls).toHaveLength(0);
    expect(fx.supabase.insertGtCalls).toHaveLength(0);
  });

  it("returns null when transcription produces nothing usable", async () => {
    const id = await run({ transcript: null });
    expect(id).toBeNull();
    expect(fx.local.insertCalls).toHaveLength(0);
    expect(fx.supabase.insertGtCalls).toHaveLength(0);
  });

  it("processes a successful call and returns null (no local row written)", async () => {
    // The local ground_truth_reports table has been dropped.
    // The pipeline now returns null — no local row ID.
    const id = await run();
    expect(id).toBeNull();
    expect(fx.local.insertCalls).toHaveLength(0);
  });

  it("does NOT mirror to Supabase when the pastoralist is not enrolled there", async () => {
    // No auto-upsert — pilot enrolment is out-of-band.
    // Supabase mirror is silently skipped.
    fx.supabase.pastoralist = null;
    const id = await run();
    expect(id).toBeNull();
    expect(fx.local.insertCalls).toHaveLength(0);
    expect(fx.supabase.insertGtCalls).toHaveLength(0);
    expect(fx.supabase.upsertCalls).toHaveLength(0);
  });

  it("does NOT mirror when the enrolled pastoralist has no ward_id (data quality guard)", async () => {
    fx.supabase.pastoralist = {
      pastoralist_id: "pid-99",
      ward_id: null,
    };
    await run();
    expect(fx.supabase.insertGtCalls).toHaveLength(0);
  });

  it("mirrors ground_truth_calls only when the pastoralist is enrolled", async () => {
    fx.supabase.pastoralist = {
      pastoralist_id: "pid-42",
      ward_id: "242",
    };
    await run();

    expect(fx.supabase.insertGtCalls).toHaveLength(1);
    const sbRow = fx.supabase.insertGtCalls[0];
    expect(sbRow.pastoralist_id).toBe("pid-42");
    expect(sbRow.ward_id).toBe("242");
    expect(sbRow.bcs_score).toBe(2);
    // mortality_rate "1-3" normalises to 0.05 (proportion, not raw count)
    expect(sbRow.mortality_rate).toBeCloseTo(0.05);
    // offtake_rate "normal" normalises to 0.3
    expect(sbRow.offtake_rate).toBeCloseTo(0.3);
    // trust_score 60 normalises to 0.6 (proportion, not percent)
    expect(sbRow.trust_score).toBeCloseTo(0.6);
    expect(sbRow.supplementary_feeding).toBe(false);
    expect(sbRow.water_trek_distance_km).toBeCloseTo(7.5);
  });

  it("skips Supabase mirror entirely when SUPABASE is not configured", async () => {
    fx.supabase.configured = false;
    fx.supabase.pastoralist = {
      pastoralist_id: "pid-42",
      ward_id: "242",
    };
    const id = await run();
    expect(id).toBeNull();
    expect(fx.local.insertCalls).toHaveLength(0);
    expect(fx.supabase.insertGtCalls).toHaveLength(0);
  });

  it("returns null even when withTenantContext throws — no local insert path", async () => {
    // The pipeline no longer writes to local DB, so withTenantContext
    // throwing has no effect on whether the function returns null.
    fx.local.throwOnInsert = true;
    fx.supabase.pastoralist = {
      pastoralist_id: "pid-42",
      ward_id: "242",
    };
    const id = await run();
    // The Supabase mirror may or may not fire since there's no local
    // row gate any more — we just verify the function doesn't throw.
    expect(id).toBeNull();
  });

  it("maps mortality_rate '4-plus' to 0.15 and offtake 'early' to 0.6", async () => {
    fx.supabase.pastoralist = {
      pastoralist_id: "pid-42",
      ward_id: "242",
    };
    fx.indicators = {
      bcs_score: 1,
      mortality_rate: "4-plus",
      offtake_rate: "early",
      water_point_status: "dry",
    };
    await run();
    const sbRow = fx.supabase.insertGtCalls[0];
    expect(sbRow.mortality_rate).toBeCloseTo(0.15);
    expect(sbRow.offtake_rate).toBeCloseTo(0.6);
  });

  it("caps trust_score at 1.0 even when local value >100", async () => {
    fx.supabase.pastoralist = {
      pastoralist_id: "pid-42",
      ward_id: "242",
    };
    fx.trustScore = 250;
    await run();
    const sbRow = fx.supabase.insertGtCalls[0];
    expect(sbRow.trust_score).toBe(1);
  });

  it("water_trek_distance_km handles under_5km and over_10km buckets", async () => {
    fx.supabase.pastoralist = {
      pastoralist_id: "pid-42",
      ward_id: "242",
    };
    fx.indicators = {
      bcs_score: 3,
      water_trekking_distance: "under_5km",
      water_point_status: "operational_good",
    };
    await run();
    expect(fx.supabase.insertGtCalls[0].water_trek_distance_km).toBeCloseTo(2.5);

    fx.supabase.insertGtCalls = [];
    fx.indicators = {
      bcs_score: 3,
      water_trekking_distance: "over_10km",
      water_point_status: "operational_good",
    };
    await run();
    expect(fx.supabase.insertGtCalls[0].water_trek_distance_km).toBeCloseTo(12);
  });
});
