import {
  useQuery,
  useMutation,
  type UseQueryOptions,
  type UseMutationOptions,
  type QueryKey,
} from "@tanstack/react-query";

const API_BASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE) ||
  "";

type QueryConfig<TData> = {
  query?: Pick<UseQueryOptions<TData, Error, TData, QueryKey>, "queryKey" | "refetchInterval" | "retry">;
};

function getToken(): string {
  if (typeof window === "undefined") return "";
  let token = window.localStorage.getItem("ardalink.jwt") ?? "";
  if (!token) {
    // Allow ?token=xxx on initial load (demo + link sharing)
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("token");
    const fromHash = window.location.hash.replace(/^#/, "");
    const hashToken = new URLSearchParams(fromHash).get("token");
    token = fromQuery || hashToken || "";
    if (token) {
      window.localStorage.setItem("ardalink.jwt", token);
      const tenant = url.searchParams.get("tenant") ||
        new URLSearchParams(fromHash).get("tenant") || "";
      if (tenant) {
        window.localStorage.setItem("ardalink.tenant", tenant);
      }
    }
  }
  return token;
}

/**
 * Read the current JWT for the dashboard / talk app.
 *
 * Lookup order:
 *   1. `localStorage["ardalink.jwt"]` (the steady-state)
 *   2. `?token=…` query parameter on the URL (demo link sharing)
 *   3. `#token=…` URL hash (same, for copy-paste-able links)
 *
 * If (2) or (3) yields a token, it is **persisted** to localStorage so
 * the next render reads from there and the URL can be sanitised.
 *
 * Returns `""` when running outside a browser (SSR, tests in node
 * environment).
 */
export function readToken(): string {
  return getToken();
}

export function getTenant(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem("ardalink.tenant") ?? "";
}

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/**
 * Test-only escape hatch around the internal `apiFetch`. The leading
 * underscore signals "private but exported for tests" — application
 * code must not call this directly; use the typed hooks (`useGetStatus`,
 * `mintCallToken`, …) instead.
 */
export const __apiFetch = apiFetch;

// ---- Types ----------------------------------------------------------------

export type Quadrant = "NE" | "NW" | "SE" | "SW" | "C";
export type ActionTag =
  | "no_action"
  | "advised_relocate"
  | "advised_supplement"
  | "advised_water_access";

export interface GroundTruthReport {
  id: number;
  createdAt: string;
  phone: string;
  month: string;
  reportedQuadrant: Quadrant;
  reportedLocation: string;
  actionTag: ActionTag;
  bcsScore: number;
  bcsConfidence: string;
  bcsSpecies: string;
  bcsFlagFollowup: boolean;
  offtakeRate: string;
  mortalityRate: string;
  milkProduction: string;
  waterTrekkingDistance: string;
  waterPointName: string;
  waterPointStatus: string;
  supplementaryFeeding: string;
  ndviVsBaselinePercent: number;
  rainfall30dayMm: number;
  indicatorsCollected: number;
  dataCompletenessPercent: number;
  trustScore: number;
  trustFlags: string[];
  userFeedback?: string | null;
}

export interface QuadrantSummary {
  quadrant: Quadrant;
  reportCount: number;
  bcsAvg: number;
  ndviAvg: number;
}

export interface GroundTruthSummary {
  totalReports: number;
  avgBcs: number;
  byQuadrant: QuadrantSummary[];
}

export interface StatusResponse {
  is_running: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_summary?: Record<string, unknown>;
  /** Legacy alias used by the dashboard. */
  last_run?: {
    timestamp?: string;
    month?: string;
    live?: Record<string, unknown>;
    climate?: Record<string, unknown>;
    forecast?: Record<string, unknown>;
    anomaly?: Record<string, unknown>;
  };
}

export interface ForecastResponse {
  forecastHorizonDays: number;
  ndviProjection: { date: string; ndvi: number }[];
  rainfallProjection: { date: string; mm: number }[];
  riskLevel: "low" | "moderate" | "high" | "severe";
  recommendations: string[];
  generatedAt: string;
}

export interface Pastoralist {
  id: number;
  name: string;
  phone: string;
  location?: string;
  cattle: number;
  goats: number;
  camels: number;
  alertsEnabled: boolean;
  alertsSent: number;
  createdAt: string;
  lastContactAt?: string | null;
  waterSource?: string;
}

export interface CreatePastoralistInput {
  name: string;
  phone: string;
  location?: string;
  cattle: number;
  goats: number;
  camels: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatRequest {
  messages?: ChatMessage[];
  /** Direct pass-through shape used by the dashboard. */
  data?: { message: string; history?: ChatMessage[] };
  locale?: string;
}

export interface ChatResponse {
  reply: string;
  /** Legacy alias for the old shape. */
  content?: string;
  /** Optional context the dashboard renders in the chat panel. */
  context?: Record<string, unknown>;
  citations?: { source: string; snippet: string }[];
  ok?: boolean;
  message?: string;
}

export interface TriggerCheckInput {
  dryRun?: boolean;
  forceAlert?: boolean;
}

export interface TriggerCheckResponse {
  ok: boolean;
  message?: string;
}

export interface IntelligenceBriefResponse {
  tenant_id: string;
  lang: "en" | "sw";
  summary: string;
  actions: string[];
  data_sources: string[];
  generated_at: string;
  provider: string;
  model: string;
  cached: boolean;
  tokens: number;
  latency_ms: number;
}

// ---- Query key helpers ---------------------------------------------------

export const getStatus = async (): Promise<StatusResponse> =>
  apiFetch<StatusResponse>("/api/status");

export const getGetStatusQueryKey = () => ["status"] as const;

export const getForecast = async (): Promise<ForecastResponse> =>
  apiFetch<ForecastResponse>("/api/forecast");

export const getGetForecastQueryKey = () => ["forecast"] as const;

export const listPastoralists = async (): Promise<Pastoralist[]> =>
  apiFetch<Pastoralist[]>("/api/pastoralists");

export const getListPastoralistsQueryKey = () => ["pastoralists", "list"] as const;

export const listGroundTruthRecent = async (
  params: { limit?: number } = {},
): Promise<GroundTruthReport[]> =>
  apiFetch<GroundTruthReport[]>(
    `/api/ground-truth/recent?limit=${params.limit ?? 20}`,
  );

export const getListGroundTruthRecentQueryKey = (params: { limit?: number } = {}) =>
  ["ground-truth", "recent", params.limit ?? 20] as const;

export const getGroundTruthSummary = async (): Promise<GroundTruthSummary> =>
  apiFetch<GroundTruthSummary>("/api/ground-truth/summary");

export const getGetGroundTruthSummaryQueryKey = () =>
  ["ground-truth", "summary"] as const;

export const getIntelligenceBrief = async (
  params: { lang?: "en" | "sw"; regenerate?: boolean } = {},
): Promise<IntelligenceBriefResponse> => {
  const search = new URLSearchParams();
  if (params.lang) search.set("lang", params.lang);
  if (params.regenerate) search.set("regenerate", "1");
  const qs = search.toString();
  return apiFetch<IntelligenceBriefResponse>(
    `/api/intelligence/brief${qs ? `?${qs}` : ""}`,
  );
};

export const getIntelligenceBriefQueryKey = (
  params: { lang?: "en" | "sw"; regenerate?: boolean } = {},
) => ["intelligence", "brief", params.lang ?? "en", !!params.regenerate] as const;

// ---- Choropleth types + helpers ------------------------------------------

export interface PerCountyAggregateResponse {
  tenant_id: string;
  metric: string;
  generated_at: string;
  byCounty: Record<string, number | null>;
  unit: string;
  description: string;
}

export type ChoroplethMetric = "reports" | "bcs" | "ndvi" | "herd";

export const getKenyaCountiesGeoJson = async (): Promise<unknown> => {
  // Public endpoint — no token needed.
  const res = await fetch("/api/open-data/geo/kenya-counties");
  if (!res.ok) {
    throw new Error(`kenya-counties GeoJSON: HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
};

export const getPerCountyAggregates = async (
  metric: ChoroplethMetric,
): Promise<PerCountyAggregateResponse> =>
  apiFetch<PerCountyAggregateResponse>(
    `/api/open-data/geo/per-county-aggregates?metric=${metric}`,
  );

export const getPerCountyAggregatesQueryKey = (metric: ChoroplethMetric) =>
  ["open-data", "per-county-aggregates", metric] as const;

export function usePerCountyAggregates(metric: ChoroplethMetric) {
  return useQuery<PerCountyAggregateResponse, Error>({
    queryKey: getPerCountyAggregatesQueryKey(metric),
    queryFn: () => getPerCountyAggregates(metric),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

// ---- Time-travel + insights + rankings + presets ------------------------

export type TimeSlice = "live" | "7d" | "30d" | "90d" | "1y" | "all";

export const TIME_SLICE_LABELS: Record<TimeSlice, string> = {
  live: "Live (24h)",
  "7d": "Past 7 days",
  "30d": "Past 30 days",
  "90d": "Past 90 days",
  "1y": "Past year",
  all: "All time",
};

export interface CountyPreset {
  name: string;
  displayName: string;
  group: "pastoral" | "main";
  why: string;
}

export interface CountyPresetsResponse {
  pastoral: CountyPreset[];
  main: CountyPreset[];
  default_main_selected: string[];
}

export const getCountyPresets = async (): Promise<CountyPresetsResponse> => {
  // Public endpoint — no token required.
  const res = await fetch("/api/open-data/geo/county-presets");
  if (!res.ok) throw new Error(`county-presets: HTTP ${res.status}`);
  return (await res.json()) as CountyPresetsResponse;
};

export const getCountyPresetsQueryKey = () =>
  ["open-data", "county-presets"] as const;

export function useCountyPresets() {
  return useQuery<CountyPresetsResponse, Error>({
    queryKey: getCountyPresetsQueryKey(),
    queryFn: getCountyPresets,
    staleTime: 60 * 60 * 1000, // county list rarely changes
  });
}

export interface PerCountyTimeSlicedAggregate extends PerCountyAggregateResponse {
  slice: TimeSlice;
}

export const getPerCountyAggregatesSlice = async (
  metric: ChoroplethMetric,
  slice: TimeSlice,
): Promise<PerCountyTimeSlicedAggregate> =>
  apiFetch<PerCountyTimeSlicedAggregate>(
    `/api/open-data/geo/per-county-aggregates?metric=${metric}&slice=${slice}`,
  );

export const getPerCountyAggregatesSliceQueryKey = (
  metric: ChoroplethMetric,
  slice: TimeSlice,
) => ["open-data", "per-county-aggregates", metric, slice] as const;

export function usePerCountyAggregatesSlice(
  metric: ChoroplethMetric,
  slice: TimeSlice,
) {
  return useQuery<PerCountyTimeSlicedAggregate, Error>({
    queryKey: getPerCountyAggregatesSliceQueryKey(metric, slice),
    queryFn: () => getPerCountyAggregatesSlice(metric, slice),
    staleTime: 30 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

export interface RankingsResponse {
  tenant_id: string;
  generated_at: string;
  metric: string;
  unit: string;
  slice: TimeSlice;
  rows: Array<{
    county: string;
    value: number | null;
    rank: number;
    normalised: number;
  }>;
}

export interface MintCallTokenResponse {
  token: string;
  expiresAt: number;
  ttlSeconds: number;
}

/**
 * Mint a single-use token for the browser-voice WebSocket. POSTs to
 * /api/call-tokens with the Bearer JWT from localStorage (the
 * dashboard's logged-in session) so the tenant middleware is happy.
 * The browser automatically attaches the Origin header; the web-server
 * proxy forwards it, and the api requires it to match localhost or
 * the deployed .replit.app domain.
 */
export const mintCallToken = async (
  phone?: string,
): Promise<MintCallTokenResponse> =>
  apiFetch<MintCallTokenResponse>("/api/call-tokens", {
    method: "POST",
    body: JSON.stringify(phone ? { phone } : {}),
  });

export const mintCallTokenQueryKey = () => ["call-tokens", "mint"] as const;

export function useMintCallToken() {
  return useMutation<MintCallTokenResponse, Error, { phone?: string } | void>({
    mutationFn: (vars) => mintCallToken(vars?.phone),
  });
}

export const getRankings = async (
  metric: ChoroplethMetric,
  slice: TimeSlice,
  counties: string[],
): Promise<RankingsResponse> => {
  const qs = new URLSearchParams({
    metric,
    slice,
    counties: counties.join(","),
  });
  return apiFetch<RankingsResponse>(`/api/open-data/geo/rankings?${qs}`);
};

export const getRankingsQueryKey = (
  metric: ChoroplethMetric,
  slice: TimeSlice,
  counties: string[],
) => ["open-data", "rankings", metric, slice, counties.slice().sort().join(",")] as const;

export function useRankings(
  metric: ChoroplethMetric,
  slice: TimeSlice,
  counties: string[],
) {
  return useQuery<RankingsResponse, Error>({
    queryKey: getRankingsQueryKey(metric, slice, counties),
    queryFn: () => getRankings(metric, slice, counties),
    staleTime: 30 * 1000,
  });
}

export interface InsightsResponse {
  tenant_id: string;
  slice: TimeSlice;
  bullets: string[];
  generatedAt: string;
}

export const getInsights = async (
  slice: TimeSlice,
  counties: string[],
): Promise<InsightsResponse> => {
  const qs = new URLSearchParams({
    slice,
    counties: counties.join(","),
  });
  return apiFetch<InsightsResponse>(`/api/open-data/geo/insights?${qs}`);
};

export const getInsightsQueryKey = (slice: TimeSlice, counties: string[]) =>
  ["open-data", "insights", slice, counties.slice().sort().join(",")] as const;

export function useInsights(slice: TimeSlice, counties: string[]) {
  return useQuery<InsightsResponse, Error>({
    queryKey: getInsightsQueryKey(slice, counties),
    queryFn: () => getInsights(slice, counties),
    staleTime: 30 * 1000,
  });
}

export interface AlertMarker {
  id: number;
  county: string;
  severity: "red" | "yellow";
  kind: string;
  message: string;
  quadrant: string | null;
  createdAt: string;
}

export interface AlertMarkersResponse {
  tenant_id: string;
  slice: TimeSlice;
  generated_at: string;
  count: number;
  markers: AlertMarker[];
}

export const getAlertMarkers = async (
  slice: TimeSlice,
): Promise<AlertMarkersResponse> =>
  apiFetch<AlertMarkersResponse>(
    `/api/open-data/geo/alert-markers?slice=${slice}`,
  );

export const getAlertMarkersQueryKey = (slice: TimeSlice) =>
  ["open-data", "alert-markers", slice] as const;

export function useAlertMarkers(slice: TimeSlice) {
  return useQuery<AlertMarkersResponse, Error>({
    queryKey: getAlertMarkersQueryKey(slice),
    queryFn: () => getAlertMarkers(slice),
    staleTime: 60 * 1000,
  });
}

export interface TimeTravelSeries {
  // Map: slice -> county -> value
  [slice: string]: Record<string, number | null>;
}

export interface TimeTravelResponse {
  tenant_id: string;
  metric: string;
  selected_counties: string[];
  series: TimeTravelSeries;
  slice_labels: Record<string, string>;
  generated_at: string;
}

export const getTimeTravel = async (
  metric: ChoroplethMetric,
  counties: string[],
): Promise<TimeTravelResponse> => {
  const qs = new URLSearchParams({
    metric,
    counties: counties.join(","),
  });
  return apiFetch<TimeTravelResponse>(
    `/api/open-data/geo/time-travel?${qs}`,
  );
};

export const getTimeTravelQueryKey = (
  metric: ChoroplethMetric,
  counties: string[],
) => ["open-data", "time-travel", metric, counties.slice().sort().join(",")] as const;

export function useTimeTravel(metric: ChoroplethMetric, counties: string[]) {
  return useQuery<TimeTravelResponse, Error>({
    queryKey: getTimeTravelQueryKey(metric, counties),
    queryFn: () => getTimeTravel(metric, counties),
    staleTime: 60 * 1000,
  });
}

// ---- Wards + pastoralist pins + report pins -----------------------------

export interface WardPreset {
  name: string;
  displayName: string;
  isDemoHome: boolean;
}

export interface WardPresetsResponse {
  wards: WardPreset[];
  tenant_home_ward: Record<string, string>;
  attribution: string;
}

export const getWardPresets = async (): Promise<WardPresetsResponse> => {
  // Public endpoint — no token required.
  const res = await fetch("/api/open-data/geo/ward-presets");
  if (!res.ok) throw new Error(`ward-presets: HTTP ${res.status}`);
  return (await res.json()) as WardPresetsResponse;
};

export const getWardPresetsQueryKey = () =>
  ["open-data", "ward-presets"] as const;

export function useWardPresets() {
  return useQuery<WardPresetsResponse, Error>({
    queryKey: getWardPresetsQueryKey(),
    queryFn: getWardPresets,
    staleTime: 60 * 60 * 1000,
  });
}

export const getIsioloWardsGeoJson = async (): Promise<unknown> => {
  // Public endpoint — no token required.
  const res = await fetch("/api/open-data/geo/isiolo-wards");
  if (!res.ok) throw new Error(`isiolo-wards: HTTP ${res.status}`);
  return (await res.json()) as unknown;
};

export interface WardAggregatesResponse {
  tenant_id: string;
  metric: string;
  slice: TimeSlice;
  generated_at: string;
  byWard: Record<string, number | null>;
  unit: string;
  description: string;
}

export const getWardAggregates = async (
  metric: ChoroplethMetric,
  slice: TimeSlice,
): Promise<WardAggregatesResponse> =>
  apiFetch<WardAggregatesResponse>(
    `/api/open-data/geo/ward-aggregates?metric=${metric}&slice=${slice}`,
  );

export const getWardAggregatesQueryKey = (
  metric: ChoroplethMetric,
  slice: TimeSlice,
) => ["open-data", "ward-aggregates", metric, slice] as const;

export function useWardAggregates(
  metric: ChoroplethMetric,
  slice: TimeSlice,
) {
  return useQuery<WardAggregatesResponse, Error>({
    queryKey: getWardAggregatesQueryKey(metric, slice),
    queryFn: () => getWardAggregates(metric, slice),
    staleTime: 30 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

export interface PastoralistPin {
  id: number;
  name: string;
  phone: string;
  lat: number;
  lon: number;
  placeName: string;
  ward: string;
  mapped: boolean;
  cattle: number;
  goats: number;
  camels: number;
  waterSource: string;
  alertsSent: number;
}

export interface PastoralistPinsResponse {
  tenant_id: string;
  generated_at: string;
  count: number;
  pins: PastoralistPin[];
}

export const getPastoralistPins = async (): Promise<PastoralistPinsResponse> =>
  apiFetch<PastoralistPinsResponse>("/api/open-data/geo/pastoralist-pins");

export const getPastoralistPinsQueryKey = () =>
  ["open-data", "pastoralist-pins"] as const;

export function usePastoralistPins() {
  return useQuery<PastoralistPinsResponse, Error>({
    queryKey: getPastoralistPinsQueryKey(),
    queryFn: getPastoralistPins,
    staleTime: 60 * 1000,
  });
}

export interface ReportPin {
  id: number;
  lat: number;
  lon: number;
  placeName: string;
  ward: string;
  quadrant: string | null;
  mapped: boolean;
  bcsScore: number | null;
  mortalityRate: string | null;
  waterPointStatus: string | null;
  waterPointName: string | null;
  ndviVsBaselinePercent: number | null;
  actionTag: string | null;
  createdAt: string;
}

export interface ReportPinsResponse {
  tenant_id: string;
  slice: TimeSlice;
  generated_at: string;
  count: number;
  pins: ReportPin[];
}

export const getReportPins = async (
  slice: TimeSlice,
): Promise<ReportPinsResponse> =>
  apiFetch<ReportPinsResponse>(
    `/api/open-data/geo/report-pins?slice=${slice}`,
  );

export const getReportPinsQueryKey = (slice: TimeSlice) =>
  ["open-data", "report-pins", slice] as const;

export function useReportPins(slice: TimeSlice) {
  return useQuery<ReportPinsResponse, Error>({
    queryKey: getReportPinsQueryKey(slice),
    queryFn: () => getReportPins(slice),
    staleTime: 60 * 1000,
  });
}

// ---- Hooks ----------------------------------------------------------------

export function useGetStatus(config: QueryConfig<StatusResponse> = {}) {
  return useQuery<StatusResponse, Error>({
    queryKey: getGetStatusQueryKey(),
    queryFn: getStatus,
    ...config.query,
  });
}

export function useGetForecast(config: QueryConfig<ForecastResponse> = {}) {
  return useQuery<ForecastResponse, Error>({
    queryKey: getGetForecastQueryKey(),
    queryFn: getForecast,
    ...config.query,
  });
}

export function useListPastoralists(
  config: QueryConfig<Pastoralist[]> = {},
) {
  return useQuery<Pastoralist[], Error>({
    queryKey: getListPastoralistsQueryKey(),
    queryFn: listPastoralists,
    ...config.query,
  });
}

export function useCreatePastoralist(
  options?: UseMutationOptions<
    Pastoralist,
    Error,
    CreatePastoralistInput
  >,
) {
  return useMutation<Pastoralist, Error, CreatePastoralistInput>({
    mutationFn: (data) =>
      apiFetch<Pastoralist>("/api/pastoralists", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    ...options,
  });
}

export function useDeletePastoralist() {
  return useMutation<{ ok: true }, Error, { id: number }>({
    mutationFn: ({ id }) =>
      apiFetch<{ ok: true }>(`/api/pastoralists/${id}`, { method: "DELETE" }),
  });
}

export function useListGroundTruthRecent(
  params: { limit?: number } = {},
  config: QueryConfig<GroundTruthReport[]> = {},
) {
  return useQuery<GroundTruthReport[], Error>({
    queryKey: getListGroundTruthRecentQueryKey(params),
    queryFn: () => listGroundTruthRecent(params),
    ...config.query,
  });
}

export function useGetGroundTruthSummary(
  config: QueryConfig<GroundTruthSummary> = {},
) {
  return useQuery<GroundTruthSummary, Error>({
    queryKey: getGetGroundTruthSummaryQueryKey(),
    queryFn: getGroundTruthSummary,
    ...config.query,
  });
}

export function useIntelligenceBrief(
  params: { lang?: "en" | "sw"; regenerate?: boolean } = {},
  config: QueryConfig<IntelligenceBriefResponse> = {},
) {
  return useQuery<IntelligenceBriefResponse, Error>({
    queryKey: getIntelligenceBriefQueryKey(params),
    queryFn: () => getIntelligenceBrief(params),
    staleTime: 5 * 60 * 1000, // brief is cached server-side for 5 min
    refetchInterval: 5 * 60 * 1000,
    ...config.query,
  });
}

export function useTriggerCheck(
  options?: UseMutationOptions<
    TriggerCheckResponse,
    Error,
    TriggerCheckInput
  >,
) {
  return useMutation<TriggerCheckResponse, Error, TriggerCheckInput>({
    mutationFn: (data) =>
      apiFetch<TriggerCheckResponse>("/api/trigger-check", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    ...options,
  });
}

export function useChatWithLand(
  options?: UseMutationOptions<ChatResponse, Error, ChatRequest>,
) {
  return useMutation<ChatResponse, Error, ChatRequest>({
    mutationFn: (data) =>
      apiFetch<ChatResponse>("/api/chat", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    ...options,
  });
}

export function setToken(token: string): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem("ardalink.jwt", token);
  }
}

export function clearToken(): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem("ardalink.jwt");
  }
}