import { Router, type IRouter, type Request } from "express";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchYearOverYearClimate,
  fetchAirQualitySnapshot,
  discoverAllForWard,
  probeOpenDataSources,
  OPEN_DATA_SOURCES,
  type PlanetaryComputerCollection,
} from "../lib/openData/index.js";
import { withTenantContext } from "../lib/tenancy-context.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

function requireTenant(req: Request): string {
  const tenantId = req.tenant?.tenant_id;
  if (!tenantId) {
    throw new Error("tenant_id missing from request context");
  }
  return tenantId;
}

// ── Static GeoJSON for the choropleth map ────────────────────────────────
//
// Kenya counties GeoJSON (~1.3 MB) lives in docs/local-dev/data/. Loaded
// once at module init and served from memory. For production this would
// come from a CDN or be uploaded to a cloud bucket.
let countiesGeoJsonCache: unknown | null = null;
function loadCountiesGeoJson(): unknown | null {
  if (countiesGeoJsonCache) return countiesGeoJsonCache;
  try {
    // Resolve relative to the api repo's docs/local-dev/data/ path.
    // In dev start-local.sh sets REPO_ROOT; in production build the
    // file would ship alongside the bundle.
    const here = dirname(fileURLToPath(import.meta.url));
    // Walk up looking for docs/local-dev/data/kenya-counties.geojson —
    // works in both dev (src/routes/openData.ts → docs/...) and built
    // (dist/routes/openData.js → docs/...) layouts.
    const candidates = [
      join(here, "..", "..", "..", "docs", "local-dev", "data", "kenya-counties.geojson"),
      join(here, "..", "..", "docs", "local-dev", "data", "kenya-counties.geojson"),
      join(process.cwd(), "docs", "local-dev", "data", "kenya-counties.geojson"),
      join(process.cwd(), "ardalink-api", "docs", "local-dev", "data", "kenya-counties.geojson"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        const txt = readFileSync(c, "utf8");
        countiesGeoJsonCache = JSON.parse(txt);
        logger.info(
          { path: c, counties: (countiesGeoJsonCache as { features: unknown[] }).features?.length ?? 0 },
          "[OpenData] Loaded Kenya counties GeoJSON",
        );
        return countiesGeoJsonCache;
      }
    }
    logger.warn(
      { tried: candidates },
      "[OpenData] Kenya counties GeoJSON not found — choropleth will be empty",
    );
    return null;
  } catch (e) {
    logger.error({ err: e }, "[OpenData] Failed to load Kenya counties GeoJSON");
    return null;
  }
}

// Same shape as the counties loader, but for the Isiolo-wards file.
// Sourced from GADM v4.1 (https://gadm.org) — 10 wards within Isiolo
// County: Bulla Pesa, Burat, Chari, Cherab, Ngare Mara, Oldonyiro,
// Wabera, Garbatulla, Kinna, Sericho. Bundled at 142 KB.
let isioloWardsGeoJsonCache: unknown | null = null;
function loadIsioloWardsGeoJson(): unknown | null {
  if (isioloWardsGeoJsonCache) return isioloWardsGeoJsonCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "..", "docs", "local-dev", "data", "isiolo-wards.geojson"),
      join(here, "..", "..", "docs", "local-dev", "data", "isiolo-wards.geojson"),
      join(process.cwd(), "docs", "local-dev", "data", "isiolo-wards.geojson"),
      join(process.cwd(), "ardalink-api", "docs", "local-dev", "data", "isiolo-wards.geojson"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        const txt = readFileSync(c, "utf8");
        isioloWardsGeoJsonCache = JSON.parse(txt);
        logger.info(
          { path: c, wards: (isioloWardsGeoJsonCache as { features: unknown[] }).features?.length ?? 0 },
          "[OpenData] Loaded Isiolo wards GeoJSON",
        );
        return isioloWardsGeoJsonCache;
      }
    }
    logger.warn(
      { tried: candidates },
      "[OpenData] Isiolo wards GeoJSON not found — choropleth ward view will be empty",
    );
    return null;
  } catch (e) {
    logger.error({ err: e }, "[OpenData] Failed to load Isiolo wards GeoJSON");
    return null;
  }
}

/**
 * GET /api/open-data/sources
 *
 * Lists every open-data provider the system touches plus a live
 * "is this reachable right now?" probe. Used by the dashboard's
 * Open Data panel so operators can see, at a glance, which feeds
 * are green and which are red.
 *
 * Tenant-scoped because the URL flips based on local ward bbox
 * in the future; today the providers are global so the response
 * is identical per tenant. The bearer auth keeps the multi-tenant
 * invariant honest.
 */
router.get("/open-data/sources", async (_req, res): Promise<void> => {
  try {
    const probed = await probeOpenDataSources();
    res.json({
      sources: probed,
      totalHealthy: probed.filter((s) => s.healthy).length,
      totalProviders: probed.length,
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    logger.error({ err }, "[OpenData] Source probe failed");
    res.status(500).json({ error: "open-data probe failed" });
  }
});

/**
 * GET /api/open-data/year-over-year?windowDays=30
 *
 * Live rolling-30-day climate vs the same window one year ago.
 * Pulled from Open-Meteo Archive (CC-BY 4.0, ERA5 + CHIRPS blend).
 * No API key, no rate-limit concern. ~2 round-trips to Open-Meteo.
 */
router.get("/open-data/year-over-year", async (req, res): Promise<void> => {
  try {
    requireTenant(req);
    const windowDays = Math.max(
      7,
      Math.min(180, Number(req.query.windowDays ?? 30)),
    );
    const data = await fetchYearOverYearClimate(undefined, undefined, windowDays);
    res.json(data);
  } catch (err: unknown) {
    logger.error({ err }, "[OpenData] year-over-year fetch failed");
    res.status(500).json({ error: "year-over-year fetch failed" });
  }
});

/**
 * GET /api/open-data/air-quality
 *
 * Live PM2.5/PM10 from Open-Meteo Air Quality (CAMS ensemble).
 * Useful dust-storm context for dry-season briefings.
 */
router.get("/open-data/air-quality", async (_req, res): Promise<void> => {
  try {
    const aq = await fetchAirQualitySnapshot();
    res.json(aq);
  } catch (err: unknown) {
    logger.error({ err }, "[OpenData] air-quality fetch failed");
    res.status(500).json({ error: "air-quality fetch failed" });
  }
});

/**
 * GET /api/open-data/satellite/discover?lookbackDays=60
 *
 * Searches Microsoft Planetary Computer STAC catalog for the
 * satellite scenes available right now over the ward's bbox.
 * Discovery only — no asset downloads.
 */
router.get("/open-data/satellite/discover", async (req, res): Promise<void> => {
  try {
    const lookbackDays = Math.max(
      1,
      Math.min(365, Number(req.query.lookbackDays ?? 60)),
    );
    // Ward bbox — Isiolo County (Bula Pesa / Garbatulla / Merti all sit in this envelope)
    const bbox: [number, number, number, number] = [37.0, -0.5, 38.5, 1.0];
    const discovered = await discoverAllForWard(bbox, lookbackDays);
    res.json({
      bbox,
      lookbackDays,
      discovered,
      collectionsSearched: Object.keys(discovered) as PlanetaryComputerCollection[],
      license: "Microsoft Planetary Computer — various open licenses",
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    logger.error({ err }, "[OpenData] planetary computer discover failed");
    res.status(500).json({ error: "discovery failed" });
  }
});

/**
 * GET /api/open-data/sources/manifest
 *
 * Static list of providers with attribution. The probe endpoint
 * adds latency; the manifest is just the catalog. Good for the
 * "About" panel in the dashboard.
 */
router.get("/open-data/sources/manifest", (_req, res): void => {
  res.json({
    providers: OPEN_DATA_SOURCES,
    note:
      "All providers below are free to use without API keys. Attribution " +
      "is included verbatim per each provider's license terms.",
  });
});

/**
 * GET /api/open-data/geo/kenya-counties
 *
 * Returns the Kenya counties GeoJSON used by the dashboard's
 * choropleth. Public — no auth — because the boundaries themselves
 * carry no sensitive information. The choropleth then layers
 * tenant-scoped aggregates on top in the browser.
 */
router.get("/open-data/geo/kenya-counties", (_req, res): void => {
  const geo = loadCountiesGeoJson();
  if (!geo) {
    res.status(503).json({
      error: "Kenya counties GeoJSON not bundled in this build",
    });
    return;
  }
  // Allow the web-server proxy (different origin) to cache this for 1h.
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json(geo);
});

/**
 * GET /api/open-data/geo/isiolo-wards
 *
 * Returns the 10 wards inside Isiolo County (Bulla Pesa, Burat, Chari,
 * Cherab, Ngare Mara, Oldonyiro, Wabera, Garbatulla, Kinna, Sericho)
 * as a GeoJSON FeatureCollection. Sourced from GADM v4.1. Public —
 * no auth — so the dashboard can render the ward polygons before the
 * user signs in. Cached 1h on the server.
 */
router.get("/open-data/geo/isiolo-wards", (_req, res): void => {
  const geo = loadIsioloWardsGeoJson();
  if (!geo) {
    res.status(503).json({
      error: "Isiolo wards GeoJSON not bundled in this build",
    });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json(geo);
});

// Per-ward detail payload (bbox + quadrants + landmarks + named places).
// Loaded from docs/local-dev/data/ward-detail.json. Currently populated
// for Bula Pesa only; the Choropleth gracefully handles empty arrays for
// the other 9 wards. Cached 1h on the server — landmarks are static OSM
// data and don't change between requests.
type WardQuadrant = {
  id: string;
  name: string;
  sub: string;
  polygon: Array<[number, number]>;
};

type WardLandmark = {
  name: string;
  category: string;
  lat: number;
  lon: number;
};

type WardPlace = {
  name: string;
  kind: string;
  lat: number;
  lon: number;
};

type WardDetail = {
  bbox?: { west: number; south: number; east: number; north: number };
  quadrants: WardQuadrant[];
  landmarks: WardLandmark[];
  places: WardPlace[];
};

type WardDetailMap = Record<string, WardDetail>;

let wardDetailCache: WardDetailMap | null = null;
function loadWardDetail(): WardDetailMap | null {
  if (wardDetailCache) return wardDetailCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "..", "docs", "local-dev", "data", "ward-detail.json"),
      join(here, "..", "..", "docs", "local-dev", "data", "ward-detail.json"),
      join(process.cwd(), "docs", "local-dev", "data", "ward-detail.json"),
      join(process.cwd(), "ardalink-api", "docs", "local-dev", "data", "ward-detail.json"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        const txt = readFileSync(c, "utf8");
        const parsed = JSON.parse(txt) as WardDetailMap;
        // Normalise: every ward has at minimum empty arrays for the three
        // collections, so the dashboard never has to null-check.
        for (const k of Object.keys(parsed)) {
          parsed[k] = {
            ...parsed[k],
            quadrants: parsed[k].quadrants ?? [],
            landmarks: parsed[k].landmarks ?? [],
            places: parsed[k].places ?? [],
          };
        }
        wardDetailCache = parsed;
        logger.info(
          {
            path: c,
            wards: Object.keys(parsed).length,
            withDetail: Object.values(parsed).filter(
              (w) => w.quadrants.length > 0 || w.landmarks.length > 0,
            ).length,
          },
          "[OpenData] Loaded ward detail JSON",
        );
        return wardDetailCache;
      }
    }
    logger.warn(
      { tried: candidates },
      "[OpenData] ward-detail.json not found — Choropleth detail view will be empty",
    );
    return null;
  } catch (e) {
    logger.error({ err: e }, "[OpenData] Failed to load ward-detail.json");
    return null;
  }
}

/**
 * GET /api/open-data/geo/ward-detail?ward=<NAME_3>
 *
 * Per-ward geographic detail (bbox + quadrants + landmarks + named
 * places). Currently populated for Bula Pesa only; other wards return
 * an empty detail object so the client always has a well-defined
 * shape. Public — no auth — because the data is OSM-sourced and
 * static.
 */
router.get("/open-data/geo/ward-detail", (req, res): void => {
  const ward = String(req.query.ward ?? "").trim();
  const all = loadWardDetail();
  if (!all) {
    res.status(503).json({ error: "ward-detail.json not bundled in this build" });
    return;
  }
  if (!ward) {
    res.status(400).json({ error: "missing required query parameter: ward" });
    return;
  }
  const detail = all[ward] ?? { quadrants: [], landmarks: [], places: [] };
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({ ward, ...detail });
});

/**
 * GET /api/open-data/geo/ward-aggregates
 *
 * Per-ward numeric aggregates (Bulla Pesa, Garbatulla, Sericho + the
 * 7 surrounding Isiolo wards). The data comes from RLS-scoped
 * ground-truth reports + pastoralists and is bucketed by the
 * GADM ward the place name resolves to.
 *
 *   ?metric=reports  → count of ground-truth reports per ward
 *   ?metric=bcs      → avg body-condition score per ward
 *   ?metric=ndvi     → avg NDVI delta vs baseline per ward
 *   ?metric=herd     → total animals (cattle+goats+camels) per ward
 *   ?slice=          → 7d / 30d / 90d / 1y / all (default 30d)
 */
router.get("/open-data/geo/ward-aggregates", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req);
  const metric = String(req.query.metric ?? "reports").toLowerCase();
  const slice = parseSlice(String(req.query.slice ?? "30d").toLowerCase());
  try {
    const { computeWardAggregates } = await import("../lib/geoHelpers.js");
    const data = await computeWardAggregates(tenantId, metric, slice);
    res.json({
      tenant_id: tenantId,
      metric,
      slice,
      generated_at: new Date().toISOString(),
      ...data,
    });
  } catch (err: unknown) {
    logger.error({ err, metric, slice, tenantId }, "ward aggregates failed");
    res.status(500).json({ error: "ward aggregate computation failed" });
  }
});

/**
 * GET /api/open-data/geo/pastoralist-pins
 *
 * Returns the caller's pastoralists as lat/lon pins (resolved from
 * their `location` field via geoHelpers.resolvePlaceName). Each pin
 * carries name, phone, herd totals, and the resolved ward.
 */
router.get("/open-data/geo/pastoralist-pins", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req);
  try {
    const { resolvePlaceName } = await import("../lib/geoHelpers.js");
    const rows = await withTenantContext(tenantId, async (tx) => {
      const { pastoralistsTable } = await import("@workspace/db");
      return tx
        .select({
          id: pastoralistsTable.id,
          name: pastoralistsTable.name,
          phone: pastoralistsTable.phone,
          location: pastoralistsTable.location,
          cattle: pastoralistsTable.cattle,
          goats: pastoralistsTable.goats,
          camels: pastoralistsTable.camels,
          waterSource: pastoralistsTable.waterSource,
          alertsSent: pastoralistsTable.alertsSent,
        })
        .from(pastoralistsTable);
    });
    const pins = rows.map((r: {
      id: number; name: string; phone: string; location: string;
      cattle: number; goats: number; camels: number; waterSource: string;
      alertsSent: number;
    }) => {
      const geo = resolvePlaceName(r.location);
      return {
        id: r.id,
        name: r.name,
        phone: r.phone,
        lat: geo.lat,
        lon: geo.lon,
        placeName: geo.placeName,
        ward: geo.ward,
        mapped: geo.mapped,
        cattle: r.cattle,
        goats: r.goats,
        camels: r.camels,
        waterSource: r.waterSource,
        alertsSent: r.alertsSent,
      };
    });
    res.json({
      tenant_id: tenantId,
      generated_at: new Date().toISOString(),
      count: pins.length,
      pins,
    });
  } catch (err: unknown) {
    logger.error({ err, tenantId }, "pastoralist pins failed");
    res.status(500).json({ error: "pastoralist pins failed" });
  }
});

/**
 * GET /api/open-data/geo/report-pins
 *
 * Returns the caller's ground-truth reports as lat/lon pins (resolved
 * from `reportedLocation`). Each pin carries BCS, NDVI, mortality
 * status, and the resolved ward. The dashboard uses this to overlay
 * the source data on the ward choropleth.
 *
 *   ?slice=7d|30d|90d|1y|all  → default 30d
 */
router.get("/open-data/geo/report-pins", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req);
  const slice = parseSlice(String(req.query.slice ?? "30d").toLowerCase());
  try {
    const { resolvePlaceName, timeSliceStart } = await import("../lib/geoHelpers.js");
    const { isSupabaseConfigured, recentGroundTruthCalls } = await import("../lib/supabase/index.js");
    const since = timeSliceStart(slice);
    // Read from Supabase ground_truth_calls. Fields not present on Supabase
    // (reportedLocation, reportedQuadrant, waterPointName, ndviVsBaselinePercent,
    // actionTag) are returned as null. reportedLocation resolves to the Isiolo
    // centre ("unmapped") since no location is available.
    const sbRows = isSupabaseConfigured()
      ? ((await recentGroundTruthCalls(500)) ?? [])
      : [];
    const filteredRows = since
      ? sbRows.filter((r) => new Date(r.created_at).getTime() >= since.getTime())
      : sbRows;
    const mortalityLabel = (rate: number | null): string | null => {
      if (rate == null) return null;
      if (rate >= 0.1) return "4-plus";
      if (rate >= 0.02) return "1-3";
      return "none";
    };
    const pins = filteredRows.map((r) => {
      // reportedLocation is not available on ground_truth_calls; resolve
      // to unmapped (Isiolo centre).
      const geo = resolvePlaceName(null);
      return {
        id: r.call_id,
        lat: geo.lat,
        lon: geo.lon,
        placeName: geo.placeName,
        ward: geo.ward,
        quadrant: null,
        mapped: false,
        bcsScore: r.bcs_score ?? null,
        mortalityRate: mortalityLabel(r.mortality_rate ?? null),
        waterPointStatus: r.water_point_status ?? null,
        waterPointName: null,
        ndviVsBaselinePercent: null,
        actionTag: null,
        createdAt: r.created_at,
      };
    });
    res.json({
      tenant_id: tenantId,
      slice,
      generated_at: new Date().toISOString(),
      count: pins.length,
      pins,
    });
  } catch (err: unknown) {
    logger.error({ err, tenantId, slice }, "report pins failed");
    res.status(500).json({ error: "report pins failed" });
  }
});

/**
 * GET /api/open-data/geo/ward-presets
 *
 * Public — returns the 10 Isiolo ward names + which 3 are the demo
 * "home" wards. The dashboard uses this to render the ward picker.
 */
router.get("/open-data/geo/ward-presets", async (_req, res): Promise<void> => {
  const { ISILO_WARDS, TENANT_HOME_WARD } = await import("../lib/geoHelpers.js");
  res.json({
    wards: ISILO_WARDS,
    tenant_home_ward: TENANT_HOME_WARD,
    attribution: "Ward boundaries from GADM v4.1 (https://gadm.org), freely available for non-commercial use.",
  });
});

/**
 * GET /api/open-data/geo/per-county-aggregates
 *
 * Returns per-county numeric aggregates for the choropleth.
 * Today these are derived from the caller's tenant data (RLS-scoped
 * ground-truth reports + pastoralists) plus live open-data weather.
 * Counties without any source data come back as null — the choropleth
 * renders them gray with a "No data" tooltip.
 *
 *   ?metric=reports  → total ground-truth report count per county
 *   ?metric=bcs      → average BCS score per county (where available)
 *   ?metric=ndvi     → drought-stress proxy per county (0–100)
 *   ?metric=herd     → total cattle + goats + camels per county
 *   ?slice=live|7d|30d|90d|1y|all  → time window (default 30d)
 *
 * Tenant-scoped because per-tenant aggregates are inherently
 * tenant data. The cross-tenant layer (county-level view) requires
 * the admin role.
 */
router.get("/open-data/geo/per-county-aggregates", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req);
  const metric = String(req.query.metric ?? "reports").toLowerCase();
  const sliceRaw = String(req.query.slice ?? "30d").toLowerCase();
  const slice = parseSlice(sliceRaw);
  try {
    const { computePerCountyAggregates } = await import("../lib/openData/index.js");
    const data = await computePerCountyAggregates(tenantId, metric, slice);
    res.json({
      tenant_id: tenantId,
      metric,
      slice,
      generated_at: new Date().toISOString(),
      ...data,
    });
  } catch (err: unknown) {
    logger.error({ err, metric, tenantId, slice }, "per-county aggregates failed");
    res.status(500).json({ error: "aggregate computation failed" });
  }
});

/**
 * GET /api/open-data/geo/county-presets
 *
 * Lists the counties the dashboard is allowed to render, grouped into
 * "pastoral demo" (always on) and "main reference" (selectable by
 * the operator). Public — no auth — because county names carry no
 * sensitive information.
 */
router.get("/open-data/geo/county-presets", async (_req, res): Promise<void> => {
  const { COUNTY_PRESETS, DEFAULT_MAIN_COUNTIES } = await import(
    "../lib/openData/index.js"
  );
  res.json({
    pastoral: COUNTY_PRESETS.filter((c) => c.group === "pastoral"),
    main: COUNTY_PRESETS.filter((c) => c.group === "main"),
    default_main_selected: DEFAULT_MAIN_COUNTIES,
  });
});

/**
 * GET /api/open-data/geo/rankings
 *
 * Returns a severity ranking for the active metric across the
 * operator's selected counties. Used to drive the bar-chart panel
 * under the choropleth.
 */
router.get("/open-data/geo/rankings", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req);
  const metric = String(req.query.metric ?? "reports").toLowerCase();
  const slice = parseSlice(String(req.query.slice ?? "30d").toLowerCase());
  const selected = parseSelectedCounties(req.query.counties);
  try {
    const { computeRankings } = await import("../lib/openData/index.js");
    const data = await computeRankings(tenantId, metric, slice, selected);
    res.json({
      tenant_id: tenantId,
      generated_at: new Date().toISOString(),
      ...data,
    });
  } catch (err: unknown) {
    logger.error({ err, metric, slice, selected, tenantId }, "rankings failed");
    res.status(500).json({ error: "rankings computation failed" });
  }
});

/**
 * GET /api/open-data/geo/insights
 *
 * Auto-generated plain-English bullets comparing the selected
 * counties. Returns 3-5 deterministic insights derived from the
 * current aggregates + year-over-year climate.
 */
router.get("/open-data/geo/insights", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req);
  const slice = parseSlice(String(req.query.slice ?? "30d").toLowerCase());
  const selected = parseSelectedCounties(req.query.counties);
  try {
    const { computeInsights } = await import("../lib/openData/index.js");
    const data = await computeInsights(tenantId, slice, selected);
    res.json({
      tenant_id: tenantId,
      slice,
      ...data,
    });
  } catch (err: unknown) {
    logger.error({ err, slice, selected, tenantId }, "insights failed");
    res.status(500).json({ error: "insights computation failed" });
  }
});

/**
 * GET /api/open-data/geo/alert-markers
 *
 * Returns the list of active alert markers to overlay on the
 * choropleth. Each marker corresponds to a single ground-truth
 * report that triggered a red/yellow alert in the time slice.
 */
router.get("/open-data/geo/alert-markers", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req);
  const slice = parseSlice(String(req.query.slice ?? "30d").toLowerCase());
  try {
    const { computeAlertMarkers } = await import("../lib/openData/index.js");
    const markers = await computeAlertMarkers(tenantId, slice);
    res.json({
      tenant_id: tenantId,
      slice,
      generated_at: new Date().toISOString(),
      count: markers.length,
      markers,
    });
  } catch (err: unknown) {
    logger.error({ err, slice, tenantId }, "alert markers failed");
    res.status(500).json({ error: "alert markers computation failed" });
  }
});

/**
 * GET /api/open-data/geo/time-travel
 *
 * Returns per-county aggregates across all time slices at once, so the
 * dashboard can render a multi-epoch "what changed?" sparkline.
 * Cheap because the source is just SQL with different WHERE clauses.
 */
router.get("/open-data/geo/time-travel", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req);
  const metric = String(req.query.metric ?? "reports").toLowerCase();
  const selected = parseSelectedCounties(req.query.counties);
  try {
    const { computePerCountyAggregates, TIME_SLICE_LABELS } = await import(
      "../lib/openData/index.js"
    );
    const slices: Array<"live" | "7d" | "30d" | "90d" | "1y" | "all"> = [
      "7d", "30d", "90d", "1y", "all",
    ];
    const series: Record<string, Record<string, number | null>> = {};
    for (const sl of slices) {
      series[sl] = {};
      const data = await computePerCountyAggregates(tenantId, metric, sl);
      for (const c of selected) {
        series[sl]![c] = data.byCounty[c] ?? null;
      }
    }
    res.json({
      tenant_id: tenantId,
      metric,
      selected_counties: selected,
      series,
      slice_labels: TIME_SLICE_LABELS,
      generated_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    logger.error({ err, metric, selected, tenantId }, "time-travel failed");
    res.status(500).json({ error: "time-travel computation failed" });
  }
});

// ── Query helpers ────────────────────────────────────────────────────────

function parseSlice(raw: string): "live" | "7d" | "30d" | "90d" | "1y" | "all" {
  switch (raw) {
    case "live":
    case "7d":
    case "30d":
    case "90d":
    case "1y":
    case "all":
      return raw;
    default:
      return "30d";
  }
}

function parseSelectedCounties(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).toUpperCase()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }
  return [];
}

export default router;
