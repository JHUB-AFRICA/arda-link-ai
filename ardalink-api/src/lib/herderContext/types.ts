import type { WpdxStatus } from "../wpdx.js";

export interface HerderContext {
  /** True if we matched a pastoralist row on either Supabase or local. */
  known: boolean;
  /**
   * Data tier — critical for downstream policy:
   *   verified — real pastoralists row. Full analytics, drill batches,
   *              ground_truth_reports inserts, threshold alerts.
   *   lead     — self-subscribed via USSD/SMS/inbound-call. Welcome
   *              cadence only; NEVER included in the daily drill or
   *              analytics until ops promotes them.
   *   unknown  — phone matched nothing; skip every outbound dispatch.
   */
  tier: "verified" | "lead" | "unknown";
  /** Which source resolved the herder (helpful for debugging). */
  source: "supabase" | "local" | "none";
  phone: string;
  /** Canonicalized `+254…` phone or original input if it didn't normalize. */
  canonicalPhone: string;

  // Herder profile
  pastoralistId: string | null; // Supabase uuid, when available
  name: string | null;
  location: string | null;
  preferredLanguage: string | null;
  herdSize: number | null; // Supabase single-integer view
  cattle: number | null; // local breakdown, may be null when only Supabase knows the herder
  goats: number | null;
  camels: number | null;
  waterSource: string | null;
  lastContactAt: Date | null;

  // Last ground-truth report (from local — Supabase's ground_truth_calls is empty)
  lastBcsScore: number | null;
  lastBcsSpecies: string | null;
  lastActionTag: string | null;
  lastReportedLocation: string | null;
  lastReportedQuadrant: string | null;
  lastReportAt: Date | null;

  // Fresh ward-level intelligence — Supabase-primary, in-process cycle as fallback
  wardId: string;
  wardName: string | null;
  wardMonth: string | null;
  wardStressedPct: number | null;
  wardNdviPct: number | null;
  wardNdviMean: number | null;
  wardVci: number | null;
  wardRainfall30dMm: number | null;
  wardTemperatureC: number | null;
  wardHumidityPct: number | null;
  wardEt0Mm: number | null;
  wardDroughtSeverity: string | null;
  wardRiskLevel: string | null;
  wardRecommendation: string | null;

  // Neighbor-ward advice — populated when a neighboring ward has
  // meaningfully higher NDVI so the deterministic opener can suggest
  // moving. Null when no neighbor is better (the common case in a
  // drought where everyone is suffering).
  neighborWardName: string | null;
  neighborNdviMean: number | null;
  neighborNdviDelta: number | null;

  // Nearest WPDx water point — pulled from a static snapshot so the
  // opener can say "your nearest water point is X, N km away". Falls
  // back to null when the WPDx dataset has no rows for the ward.
  nearestWaterPointName: string | null;
  nearestWaterPointDistanceKm: number | null;
  nearestWaterPointStatus: WpdxStatus | null;

  // Peer signal — what other herders in this ward have reported in
  // the last 7 days. Populated by overlayPeerSignal below when the
  // ward has any activity. Powers the "N wachungaji karibu nawe
  // wameripoti hali kama hii wiki hii" opener line.
  peerCallerCount: number | null;
  peerThinAnimalsCount: number | null;
  peerBrokenWaterCount: number | null;
  peerWindowDays: number | null;

  // Real-anomaly signals derived from Supabase's 11-year
  // satellite_indices history for this ward + calendar month. These
  // replace the fixed-threshold "97 % stressed" line with sentences
  // the caller can act on ("driest June since 2017").
  //   baselineMonth   — the calendar month we're comparing against
  //   baselineYears   — how many historical years the envelope covers
  //   ndviBaselineP50 — median NDVI for this month across history
  //   ndviBaselineP5  — 5th-percentile NDVI (drought threshold)
  //   ndviBaselineP95 — 95th-percentile (green-flush threshold)
  //   vciDerived      — 0..100, worst-ever = 0, best-ever = 100
  //   worseThanYears  — of the last N years, how many had a better NDVI
  //                     for this month than we're seeing now
  //   driestYearOnRecord — the historical year with the lowest NDVI
  //                     for this month (for "since YYYY" phrasing)
  baselineMonth: number | null;
  baselineYears: number | null;
  ndviBaselineP50: number | null;
  ndviBaselineP5: number | null;
  ndviBaselineP95: number | null;
  vciDerived: number | null;
  worseThanYears: number | null;
  driestYearOnRecord: number | null;

  // Cell-level intelligence (from Supabase satellite_cell_indices, ~1 km
  // grid). Ward aggregate ("N of M patches stressed") is populated
  // whenever wardId resolves. The nearest-cell fields require herder
  // coordinates and fall back to the ward centroid when we only know
  // the ward — a stand-in that will be replaced once Jisajili + Voice
  // capture GPS.
  wardCellCount: number | null;
  wardStressedCellCount: number | null;
  wardCellNdviMedian: number | null;
  nearestCellId: string | null;
  nearestCellNdvi: number | null;
  nearestCellAnomaly: number | null;
}
