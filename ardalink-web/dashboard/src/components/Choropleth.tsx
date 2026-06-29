import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  Polygon,
  Tooltip as LeafletTooltip,
  ZoomControl,
  CircleMarker,
  useMap,
} from "react-leaflet";
import L, { type LatLngBoundsExpression } from "leaflet";
import {
  Loader2,
  AlertTriangle,
  Compass,
  TrendingUp,
  TrendingDown,
  Minus,
  ChevronRight,
  Sparkles,
  Activity,
  Users,
  MapPin,
  Layers,
  Plane,
  Globe,
} from "lucide-react";
import {
  usePerCountyAggregatesSlice,
  useRankings,
  useInsights,
  useAlertMarkers,
  useTimeTravel,
  useCountyPresets,
  useWardPresets,
  useWardAggregates,
  usePastoralistPins,
  useReportPins,
  TIME_SLICE_LABELS,
  type ChoroplethMetric,
  type TimeSlice,
  type AlertMarker,
  type PastoralistPin,
  type ReportPin,
} from "@workspace/api-client-react";

interface KenyaCountiesFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id?: number;
    properties: Record<string, unknown>;
    geometry: {
      type: "Polygon" | "MultiPolygon";
      coordinates: number[][][] | number[][][][];
    };
  }>;
}

interface IsioloWardsFeatureCollection extends KenyaCountiesFeatureCollection {}

type ViewMode = "wards" | "counties";

interface ChoroplethProps {
  tenantId?: string;
  initialMetric?: ChoroplethMetric;
  initialSlice?: TimeSlice;
}

// ───────────────────────────────────────────────────────────────────────
// Choropleth — ward-level choropleth with herder + report pins
//
// Default view: zoomed into Isiolo County showing the 10 GADM wards
// (BullaPesa, Burat, Chari, Cherab, Garbatulla, Kinna, NgareMara,
// Oldo/Nyiro, Sericho, Wabera). Each ward is colored by the active
// metric (BCS / NDVI / reports / herd). Pastoralist pins and ground-
// truth report markers are overlaid on top.
//
// Toggle "Counties" to see the wider Kenya view (the legacy
// 48-county choropleth with the time-travel slider).
//
// Time travel: a horizontal slider sweeps through "live" → "all" and
// re-fetches aggregates, rankings, insights, pins. Each step eases the
// camera to a different altitude/zoom for the "taking a flight" feel.
// ───────────────────────────────────────────────────────────────────────

export function Choropleth({
  initialMetric = "bcs",
  initialSlice = "30d",
}: ChoroplethProps) {
  const [metric, setMetric] = useState<ChoroplethMetric>(initialMetric);
  const [slice, setSlice] = useState<TimeSlice>(initialSlice);
  const [view, setView] = useState<ViewMode>("wards");
  const [layerShowHerderPins, setLayerShowHerderPins] = useState(true);
  const [layerShowReportPins, setLayerShowReportPins] = useState(true);
  const [geo, setGeo] = useState<KenyaCountiesFeatureCollection | null>(null);
  const [isioloWards, setIsioloWards] = useState<IsioloWardsFeatureCollection | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoLoading, setGeoLoading] = useState(true);
  const [touring, setTouring] = useState(false);
  const tourRef = useRef<number | null>(null);

  // Load both the county GeoJSON and the Isiolo wards GeoJSON in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [counties, wards] = await Promise.all([
          fetch("/api/open-data/geo/kenya-counties").then((r) => {
            if (!r.ok) throw new Error(`counties: HTTP ${r.status}`);
            return r.json();
          }),
          fetch("/api/open-data/geo/isiolo-wards").then((r) => {
            if (!r.ok) throw new Error(`wards: HTTP ${r.status}`);
            return r.json();
          }),
        ]);
        if (!cancelled) {
          setGeo(counties as KenyaCountiesFeatureCollection);
          setIsioloWards(wards as IsioloWardsFeatureCollection);
          setGeoLoading(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setGeoError(
            e instanceof Error ? e.message : "Failed to load ward/county GeoJSON",
          );
          setGeoLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch all data panels in parallel.
  const countyAggregates = usePerCountyAggregatesSlice(metric, slice);
  const wardAggregates = useWardAggregates(metric, slice);
  const rankings = useRankings(metric, slice, ["ISIOLO"]);
  const insights = useInsights(slice, ["ISIOLO"]);
  const alerts = useAlertMarkers(slice);
  const timeTravel = useTimeTravel(metric, ["ISIOLO"]);
  const countyPresets = useCountyPresets();
  const wardPresets = useWardPresets();
  const pastoralistPins = usePastoralistPins();
  const reportPins = useReportPins(slice);

  // Stop the tour on unmount.
  useEffect(() => {
    return () => {
      if (tourRef.current) window.clearTimeout(tourRef.current);
    };
  }, []);

  const startTour = useCallback(() => {
    if (view !== "wards" || !isioloWards) return;
    const wards = (isioloWards.features ?? []).slice(0, 6);
    setTouring(true);
    let i = 0;
    const flyNext = () => {
      const f = wards[i % wards.length];
      const name = String(f.properties["NAME_3"] ?? "");
      if (name) dispatchFlyToWard(name, 1800);
      i += 1;
      if (i < wards.length * 2) {
        tourRef.current = window.setTimeout(flyNext, 2400);
      } else {
        tourRef.current = window.setTimeout(() => setTouring(false), 2400);
      }
    };
    flyNext();
  }, [view, isioloWards]);

  return (
    <div
      data-testid="choropleth"
      className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-xl"
    >
      <ChoroplethHeader
        metric={metric}
        onMetricChange={setMetric}
        slice={slice}
        onSliceChange={setSlice}
        view={view}
        onViewChange={setView}
        layerShowHerderPins={layerShowHerderPins}
        onToggleHerderPins={setLayerShowHerderPins}
        layerShowReportPins={layerShowReportPins}
        onToggleReportPins={setLayerShowReportPins}
        wardCount={wardPresets.data?.wards.length ?? 0}
        pastoralistCount={pastoralistPins.data?.count ?? 0}
        reportCount={reportPins.data?.count ?? 0}
        onStartTour={startTour}
        touring={touring}
        viewReady={!!isioloWards || view === "counties"}
      />

      <div className="relative h-[46vh] min-h-[380px] bg-gray-950">
        {geoLoading && (
          <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-gray-950/80 text-gray-300 text-sm">
            <Loader2 className="w-5 h-5 mr-2 animate-spin text-amber-400" />
            Loading ward + county boundaries…
          </div>
        )}
        {geoError && (
          <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-gray-950/80 text-red-300 text-sm p-4 text-center">
            <AlertTriangle className="w-5 h-5 mr-2 shrink-0" />
            {geoError}
          </div>
        )}

        <MapContainer
          center={view === "wards" ? [0.49, 38.0] : [0.0236, 37.9062]}
          zoom={view === "wards" ? 8 : 6}
          minZoom={5}
          maxZoom={13}
          maxBounds={[
            [-5.0, 33.5],
            [5.0, 42.0],
          ]}
          maxBoundsViscosity={0.6}
          zoomControl={false}
          className="h-full w-full"
          style={{ background: "#0b1220" }}
        >
          <TileLayer
            attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · wards from GADM v4.1'
            url="https://tile.openstreetmap.org/{z}/{y}/{x}.png"
            maxZoom={19}
          />
          <ZoomControl position="bottomright" />

          {view === "wards" && isioloWards && (
            <>
              <WardsLayer
                wards={isioloWards}
                metric={metric}
                aggregates={wardAggregates.data ?? null}
                presets={wardPresets.data ?? null}
              />
              {layerShowHerderPins && (
                <PastoralistPinsLayer pins={pastoralistPins.data?.pins ?? []} />
              )}
              {layerShowReportPins && (
                <ReportPinsLayer pins={reportPins.data?.pins ?? []} />
              )}
              <AlertMarkersLayer markers={alerts.data?.markers ?? []} />
              <WardsStoreUpdater wards={isioloWards} />
            </>
          )}

          {view === "counties" && geo && (
            <>
              <CountiesLayer
                counties={geo}
                metric={metric}
                aggregates={countyAggregates.data ?? null}
              />
              {alerts.data?.markers && alerts.data.markers.length > 0 && (
                <AlertMarkersLayer markers={alerts.data.markers} />
              )}
            </>
          )}

          <SelectedFit view={view} slice={slice} metric={metric} />
          <MapBridge />
        </MapContainer>

        <Legend
          metric={metric}
          isioloValue={
            view === "wards"
              ? null
              : countyAggregates.data?.byCounty?.["ISIOLO"] ?? null
          }
        />

        <FlightHUD slice={slice} touring={touring} view={view} />
      </div>

      {/* Side-by-side analysis panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-px bg-gray-800">
        <ComparisonPanel
          metric={metric}
          view={view}
          wardData={wardAggregates.data ?? null}
          wardPresets={wardPresets.data?.wards ?? []}
          countyData={countyAggregates.data ?? null}
          slice={slice}
        />
        <SeverityBars
          rows={rankings.data?.rows ?? []}
          metric={rankings.data?.metric ?? metric}
        />
        <TimeTravelSparkline
          timeTravel={timeTravel.data ?? null}
          metric={metric}
        />
        <InsightsPanel
          insights={insights.data ?? null}
          alerts={alerts.data ?? null}
        />
      </div>
    </div>
  );
}

// ── Header (controls) ──────────────────────────────────────────────────

function ChoroplethHeader({
  metric,
  onMetricChange,
  slice,
  onSliceChange,
  view,
  onViewChange,
  layerShowHerderPins,
  onToggleHerderPins,
  layerShowReportPins,
  onToggleReportPins,
  wardCount,
  pastoralistCount,
  reportCount,
  onStartTour,
  touring,
  viewReady,
}: {
  metric: ChoroplethMetric;
  onMetricChange: (m: ChoroplethMetric) => void;
  slice: TimeSlice;
  onSliceChange: (s: TimeSlice) => void;
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  layerShowHerderPins: boolean;
  onToggleHerderPins: (b: boolean) => void;
  layerShowReportPins: boolean;
  onToggleReportPins: (b: boolean) => void;
  wardCount: number;
  pastoralistCount: number;
  reportCount: number;
  onStartTour: () => void;
  touring: boolean;
  viewReady: boolean;
}) {
  const sliceOrder: TimeSlice[] = ["live", "7d", "30d", "90d", "1y", "all"];
  const metricOptions: Array<{ value: ChoroplethMetric; label: string }> = [
    { value: "reports", label: "Reports" },
    { value: "bcs", label: "Avg BCS" },
    { value: "ndvi", label: "NDVI Δ" },
    { value: "herd", label: "Herd total" },
  ];

  return (
    <div className="border-b border-gray-800 bg-gray-950/40">
      <div className="px-3 sm:px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Compass className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">
            Live Choropleth
          </h2>
        </div>

        <div
          className="inline-flex rounded-md bg-gray-800 border border-gray-700 p-0.5"
          role="group"
          aria-label="View scope"
        >
          <button
            type="button"
            aria-pressed={view === "wards"}
            data-testid="choropleth-view-wards"
            onClick={() => onViewChange("wards")}
            className={
              "px-2.5 py-1 text-[11px] font-semibold rounded transition-colors " +
              (view === "wards"
                ? "bg-amber-600 text-white"
                : "text-gray-400 hover:text-gray-200")
            }
          >
            <Layers className="w-3 h-3 inline mr-1" />
            Wards
          </button>
          <button
            type="button"
            aria-pressed={view === "counties"}
            data-testid="choropleth-view-counties"
            onClick={() => onViewChange("counties")}
            className={
              "px-2.5 py-1 text-[11px] font-semibold rounded transition-colors " +
              (view === "counties"
                ? "bg-amber-600 text-white"
                : "text-gray-400 hover:text-gray-200")
            }
          >
            <Globe className="w-3 h-3 inline mr-1" />
            Counties
          </button>
        </div>

        <SliceSlider value={slice} onChange={onSliceChange} slices={sliceOrder} />

        <div
          className="inline-flex rounded-md bg-gray-800 border border-gray-700 p-0.5 flex-wrap"
          role="group"
          aria-label="Metric"
        >
          {metricOptions.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={metric === m.value}
              data-testid={`choropleth-metric-${m.value}`}
              onClick={() => onMetricChange(m.value)}
              className={
                "px-2.5 py-1 text-[11px] font-semibold rounded transition-colors " +
                (metric === m.value
                  ? "bg-amber-600 text-white"
                  : "text-gray-400 hover:text-gray-200")
              }
            >
              {m.label}
            </button>
          ))}
        </div>

        {view === "wards" && (
          <button
            type="button"
            onClick={onStartTour}
            disabled={touring || !viewReady}
            data-testid="choropleth-tour"
            aria-pressed={touring}
            className={
              "ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold border transition-colors " +
              (touring
                ? "bg-amber-600/30 border-amber-500 text-amber-200"
                : "bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-200 hover:text-amber-200 disabled:opacity-50")
            }
          >
            {touring ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Touring…
              </>
            ) : (
              <>
                <Plane className="w-3 h-3" />
                Tour wards
              </>
            )}
          </button>
        )}
      </div>

      {view === "wards" && (
        <div className="px-3 sm:px-4 pb-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
            Layers:
          </span>
          <LayerToggle
            label="Herder pins"
            icon={<Users className="w-3 h-3" />}
            active={layerShowHerderPins}
            count={pastoralistCount}
            onToggle={onToggleHerderPins}
            color="emerald"
          />
          <LayerToggle
            label="Report pins"
            icon={<MapPin className="w-3 h-3" />}
            active={layerShowReportPins}
            count={reportCount}
            onToggle={onToggleReportPins}
            color="amber"
          />
          <span className="text-[10px] text-gray-500 ml-auto">
            {wardCount > 0 && (
              <>
                <span className="font-mono">{wardCount}</span> wards ·{" "}
                <span className="font-mono">{pastoralistCount}</span> herders ·{" "}
                <span className="font-mono">{reportCount}</span> reports
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function LayerToggle({
  label,
  icon,
  active,
  count,
  onToggle,
  color,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  count: number;
  onToggle: (b: boolean) => void;
  color: "emerald" | "amber";
}) {
  const colors = {
    emerald: {
      active: "bg-emerald-600/30 border-emerald-600 text-emerald-200",
      inactive: "bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200",
    },
    amber: {
      active: "bg-amber-600/30 border-amber-600 text-amber-200",
      inactive: "bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200",
    },
  };
  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      aria-pressed={active}
      data-testid={`choropleth-layer-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={
        "px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors flex items-center gap-1.5 " +
        (active ? colors[color].active : colors[color].inactive)
      }
    >
      {icon}
      <span>{label}</span>
      {count > 0 && (
        <span className="font-mono opacity-70">({count})</span>
      )}
    </button>
  );
}

// ── Time slider (the "time travel" control) ────────────────────────────

function SliceSlider({
  value,
  onChange,
  slices,
}: {
  value: TimeSlice;
  onChange: (s: TimeSlice) => void;
  slices: TimeSlice[];
}) {
  const idx = slices.indexOf(value);
  return (
    <div className="flex flex-col gap-1 min-w-[260px] flex-1 max-w-[480px]">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
        <span className="inline-flex items-center gap-1">
          <Plane className="w-3 h-3" />
          Time travel
        </span>
        <span
          className="font-mono text-amber-300 normal-case tracking-normal"
          data-testid="choropleth-slice-label"
        >
          {TIME_SLICE_LABELS[value]}
        </span>
      </div>
      <div className="relative">
        <div
          aria-hidden
          className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-gradient-to-r from-emerald-500/30 via-amber-500/30 to-red-500/40 pointer-events-none"
        />
        <input
          type="range"
          min={0}
          max={slices.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(slices[Number(e.target.value)]!)}
          data-testid="choropleth-slice-slider"
          aria-label="Time travel"
          className="relative w-full appearance-none bg-transparent cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-amber-400
            [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_rgba(251,191,36,0.25)]
            [&::-webkit-slider-thumb]:cursor-grab
            [&::-webkit-slider-thumb]:transition-shadow
            [&::-webkit-slider-thumb]:hover:shadow-[0_0_0_6px_rgba(251,191,36,0.35)]
            [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:h-4
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-amber-400
            [&::-moz-range-thumb]:border-0
            [&::-moz-range-thumb]:cursor-grb"
        />
        <div className="flex justify-between mt-1 text-[9px] text-gray-500 font-mono">
          {slices.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange(s)}
              className={
                "px-1 rounded transition-colors " +
                (s === value
                  ? "text-amber-300"
                  : "hover:text-gray-300")
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Map layers ─────────────────────────────────────────────────────────

function WardsLayer({
  wards,
  metric,
  aggregates,
  presets,
}: {
  wards: IsioloWardsFeatureCollection;
  metric: ChoroplethMetric;
  aggregates:
    | { byWard: Record<string, number | null>; unit: string }
    | null;
  presets: { wards: Array<{ name: string; displayName: string; isDemoHome: boolean }> } | null;
}) {
  const meta = getMetricMeta(metric);
  return (
    <GeoJSON
      key={`wards-${metric}`}
      data={wards as unknown as GeoJSON.GeoJsonObject}
      style={(f) => safeStyle(() => styleForWard(f, aggregates, meta))}
      onEachFeature={(feature, layer) => {
        try {
          const name = String(feature.properties["NAME_3"] ?? "");
          const preset = presets?.wards.find((w) => w.name === name);
          const value = aggregates?.byWard[name] ?? null;
          const isHome = preset?.isDemoHome ?? false;
          const lines = [
            `<div style="font-weight:600">${escapeHtml(preset?.displayName ?? name)} ${isHome ? "★" : ""}</div>`,
            isHome
              ? `<div style="opacity:0.7">Demo home ward · ${escapeHtml(meta.label)} · ${escapeHtml(meta.unit)}</div>`
              : `<div style="opacity:0.7">${escapeHtml(meta.label)} · ${escapeHtml(meta.unit)}</div>`,
            value == null
              ? '<div style="color:#9ca3af">No data</div>'
              : `<div style="color:${valueColor(value, meta)};font-weight:600">${formatValue(value, meta)}</div>`,
          ];
          layer.bindTooltip(lines.join(""), {
            sticky: true,
            direction: "top",
            className: "ardalink-tooltip",
          });
          layer.on?.("mouseover", () => {
            try {
              (layer as L.Path).setStyle({
                weight: 3.5,
                color: "#fbbf24",
                fillOpacity: 0.95,
              });
            } catch {
              /* noop — a stale layer from a re-mount may be detached */
            }
          });
          layer.on?.("mouseout", () => {
            try {
              const cur = safeStyle(() => styleForWard(feature, aggregates, meta));
              (layer as L.Path).setStyle(cur);
            } catch {
              /* noop */
            }
          });
          layer.on?.("click", () => {
            if (name) {
              try {
                dispatchFlyToWard(name, 1200);
              } catch {
                /* noop */
              }
            }
          });
        } catch (err) {
          // Don't let a bad feature object blank the page.
          // eslint-disable-next-line no-console
          console.warn("[Choropleth] onEachFeature skipped a ward:", err);
        }
      }}
    />
  );
}

function CountiesLayer({
  counties,
  metric,
  aggregates,
}: {
  counties: KenyaCountiesFeatureCollection;
  metric: ChoroplethMetric;
  aggregates: { byCounty: Record<string, number | null> } | null;
}) {
  const meta = getMetricMeta(metric);
  return (
    <GeoJSON
      key={`counties-${metric}`}
      data={counties as unknown as GeoJSON.GeoJsonObject}
      style={(f) => safeStyle(() => styleForCounty(f, aggregates, meta))}
      onEachFeature={(feature, layer) => {
        try {
          const name = String(feature.properties["COUNTY_NAM"] ?? "").toUpperCase();
          const value = aggregates?.byCounty[name] ?? null;
          layer.bindTooltip(
            `<div style="font-weight:600">${escapeHtml(name)} County</div>` +
              (value == null
                ? '<div style="color:#9ca3af">No data</div>'
                : `<div style="color:${valueColor(value, meta)};font-weight:600">${formatValue(value, meta)}</div>`),
            { sticky: true, direction: "top", className: "ardalink-tooltip" },
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[Choropleth] onEachFeature skipped a county:", err);
        }
      }}
    />
  );
}

function PastoralistPinsLayer({ pins }: { pins: PastoralistPin[] }) {
  return (
    <>
      {pins.map((p) => {
        const herdSize = p.cattle + p.goats + p.camels;
        const radius = Math.min(12, Math.max(5, 5 + Math.log10(herdSize + 1) * 3));
        const color = p.mapped ? "#22c55e" : "#6b7280";
        return (
          <CircleMarker
            key={`herder-${p.id}`}
            center={[p.lat, p.lon]}
            radius={radius}
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: 0.55,
              weight: 1.5,
            }}
          >
            <LeafletTooltip direction="top" sticky>
              <div style="font-weight:600">{escapeHtml(p.name)}</div>
              <div style="opacity:0.7">{escapeHtml(p.placeName)} · {escapeHtml(p.ward)}</div>
              <div style="font-family:monospace;font-size:11px">
                cattle {p.cattle} · goats {p.goats} · camels {p.camels}
                {p.alertsSent > 0 && (
                  <span style="color:#facc15"> · {p.alertsSent} alerts</span>
                )}
              </div>
              {!p.mapped && (
                <div style="color:#9ca3af;font-style:italic">unmapped — ward centre</div>
              )}
            </LeafletTooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

function ReportPinsLayer({ pins }: { pins: ReportPin[] }) {
  return (
    <>
      {pins.map((p) => {
        const bcs = p.bcsScore;
        const ndvi = p.ndviVsBaselinePercent;
        const isAlert = p.mortalityRate === "4-plus" || (bcs != null && bcs <= 2);
        const color = isAlert
          ? "#ef4444"
          : bcs != null
            ? bcs < 2.5
              ? "#fb923c"
              : bcs < 3
                ? "#facc15"
                : "#a3e635"
            : ndvi != null
              ? ndvi <= -30
                ? "#ef4444"
                : ndvi <= -15
                  ? "#fb923c"
                  : "#facc15"
              : "#3b82f6";
        return (
          <CircleMarker
            key={`report-${p.id}`}
            center={[p.lat, p.lon]}
            radius={5}
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: 0.9,
              weight: 1,
              className: isAlert ? "ardalink-pulse" : undefined,
            }}
          >
            <LeafletTooltip direction="top" sticky>
              <div style="font-weight:600">
                Report #{p.id} · {escapeHtml(p.ward)}
              </div>
              <div style="opacity:0.7">{escapeHtml(p.placeName)}{p.quadrant ? ` · ${escapeHtml(p.quadrant)}` : ""}</div>
              <div style="font-family:monospace;font-size:11px">
                {bcs != null && <>BCS {bcs.toFixed(1)} </>}
                {ndvi != null && <>NDVI {ndvi >= 0 ? "+" : ""}{ndvi.toFixed(1)}% </>}
                {p.mortalityRate === "4-plus" && <span style="color:#ef4444"> · 4+ deaths</span>}
              </div>
            </LeafletTooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

function AlertMarkersLayer({ markers }: { markers: AlertMarker[] }) {
  const ISioloCenter: [number, number] = [0.355, 37.583];
  if (!markers.length) return null;
  return (
    <>
      {markers.map((m, i) => {
        const angle = (i / Math.max(1, markers.length)) * 2 * Math.PI;
        const radius = 0.06 + (i % 3) * 0.02;
        const lat = ISioloCenter[0] + Math.sin(angle) * radius;
        const lon = ISioloCenter[1] + Math.cos(angle) * radius * 1.2;
        const isRed = m.severity === "red";
        const color = isRed ? "#ef4444" : "#eab308";
        return (
          <CircleMarker
            key={m.id}
            center={[lat, lon]}
            radius={isRed ? 14 : 11}
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: 0.5,
              weight: 1.5,
              className: "ardalink-pulse",
            }}
          >
            <LeafletTooltip direction="top" sticky>
              <div style="font-weight:600">
                [{m.severity.toUpperCase()}] {m.kind.replace(/_/g, " ")}
              </div>
              <div style="opacity:0.8">{m.message}</div>
              <div style="opacity:0.6">
                Quadrant: {m.quadrant ?? "—"} · {new Date(m.createdAt).toLocaleDateString()}
              </div>
            </LeafletTooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

// ── Camera controller — fit to selected + fly on changes ──────────────

function SelectedFit({
  view,
  slice,
  metric,
}: {
  view: ViewMode;
  slice: TimeSlice;
  metric: ChoroplethMetric;
}) {
  const map = useMap();
  const lastSig = useRef<string>("");

  useEffect(() => {
    if (lastSig.current) {
      const sig = `${view}|${slice}|${metric}`;
      if (sig === lastSig.current) return;
      lastSig.current = sig;
    } else {
      lastSig.current = `${view}|${slice}|${metric}`;
    }
    if (view === "wards") {
      map.flyToBounds(WARDS_BBOX, { duration: 1.2, maxZoom: 9 });
    } else {
      map.flyToBounds(KENYA_BBOX, { duration: 1.2, maxZoom: 6 });
    }
  }, [view, slice, metric, map]);

  return null;
}

const WARDS_BBOX: LatLngBoundsExpression = [
  [0.0, 36.0],
  [1.2, 39.5],
];
const KENYA_BBOX: LatLngBoundsExpression = [
  [-5.0, 33.5],
  [5.0, 42.0],
];

// ── Legend (bottom-left) ───────────────────────────────────────────────

function Legend({
  metric,
  isioloValue,
}: {
  metric: ChoroplethMetric;
  isioloValue: number | null;
}) {
  const meta = getMetricMeta(metric);
  const stops = buildStops(meta);
  return (
    <div
      data-testid="choropleth-legend"
      className="absolute left-3 bottom-12 z-[500] bg-gray-950/85 backdrop-blur border border-gray-700 rounded-lg p-2.5 text-[10px] text-gray-300 shadow-lg max-w-[220px]"
    >
      <div className="text-[9px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">
        {meta.label} · {meta.unit}
      </div>
      <div className="space-y-1">
        {stops.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5">
            <span
              className="w-4 h-3 rounded-sm border border-gray-700"
              style={{ background: s.color }}
            />
            <span>{s.label}</span>
          </div>
        ))}
      </div>
      {isioloValue != null && (
        <div className="mt-2 pt-2 border-t border-gray-800 flex items-center gap-1">
          <ChevronRight className="w-3 h-3 text-amber-400 shrink-0" />
          <span className="font-mono text-amber-300 truncate">
            Isiolo: {formatValue(isioloValue, meta)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Flight HUD overlay ────────────────────────────────────────────────

function FlightHUD({
  slice,
  touring,
  view,
}: {
  slice: TimeSlice;
  touring: boolean;
  view: ViewMode;
}) {
  return (
    <div
      data-testid="choropleth-flight-hud"
      className="absolute right-3 top-3 z-[500] bg-gray-950/80 backdrop-blur border border-gray-700 rounded-lg px-3 py-2 text-[10px] text-gray-300 shadow-lg flex items-center gap-2"
    >
      <Compass
        className={
          "w-4 h-4 text-amber-400 " + (touring ? "animate-spin" : "")
        }
        style={touring ? { animationDuration: "3s" } : undefined}
      />
      <span className="font-mono">
        ALT {TimeAltitudes[slice]}ft · HDG {TimeHeadings[slice]}
      </span>
      {touring && (
        <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-600/30 text-amber-200 font-semibold">
          IN-FLIGHT
        </span>
      )}
      <span className="ml-1 px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 font-mono">
        {view === "wards" ? "WARDS" : "COUNTIES"}
      </span>
    </div>
  );
}

const TimeAltitudes: Record<TimeSlice, number> = {
  live: 12000,
  "7d": 18000,
  "30d": 24000,
  "90d": 31000,
  "1y": 38000,
  all: 41000,
};

const TimeHeadings: Record<TimeSlice, string> = {
  live: "000°",
  "7d": "045°",
  "30d": "090°",
  "90d": "180°",
  "1y": "270°",
  all: "315°",
};

// ── Analysis panels (4 across) ─────────────────────────────────────────

function ComparisonPanel({
  metric,
  view,
  wardData,
  wardPresets,
  countyData,
  slice,
}: {
  metric: ChoroplethMetric;
  view: ViewMode;
  wardData: { byWard: Record<string, number | null>; unit: string } | null;
  wardPresets: Array<{ name: string; displayName: string; isDemoHome: boolean }>;
  countyData: { byCounty: Record<string, number | null>; unit: string } | null;
  slice: TimeSlice;
}) {
  const meta = getMetricMeta(metric);
  const rows: Array<{ name: string; displayName: string; value: number | null; isHome?: boolean }> = view === "wards"
    ? wardPresets.map((w) => ({
        name: w.name,
        displayName: w.displayName,
        value: wardData?.byWard[w.name] ?? null,
        isHome: w.isDemoHome,
      }))
    : Object.entries(countyData?.byCounty ?? {}).map(([name, value]) => ({
        name,
        displayName: name,
        value,
      }));
  return (
    <div
      data-testid="choropleth-comparison"
      className="bg-gray-900 p-3 min-h-[180px]"
    >
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <Activity className="w-3 h-3" />
        {view === "wards" ? "Wards" : "Counties"} · {meta.label} · {TIME_SLICE_LABELS[slice]}
      </h3>
      {rows.length === 0 ? (
        <Skeleton />
      ) : (
        <div className="overflow-y-auto max-h-[180px]">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-500 text-[9px] uppercase tracking-wider sticky top-0 bg-gray-900">
                <th className="text-left py-1 pr-2">Name</th>
                <th className="text-right py-1 pl-2">{meta.unit}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t border-gray-800">
                  <td className="py-1 pr-2 font-mono text-gray-200 truncate">
                    {r.displayName}
                    {r.isHome && (
                      <span className="ml-1 text-amber-400" title="Demo home ward">
                        ★
                      </span>
                    )}
                  </td>
                  <td
                    className="py-1 pl-2 text-right font-mono"
                    style={{
                      color:
                        r.value == null ? "#9ca3af" : valueColor(r.value, meta),
                      fontWeight: 600,
                    }}
                  >
                    {r.value == null ? "—" : formatValue(r.value, meta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SeverityBars({
  rows,
  metric,
}: {
  rows: Array<{ county: string; value: number | null; rank: number; normalised: number }>;
  metric: string;
}) {
  const meta = getMetricMeta(metric as ChoroplethMetric);
  return (
    <div
      data-testid="choropleth-severity"
      className="bg-gray-900 p-3 min-h-[180px]"
    >
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <TrendingUp className="w-3 h-3" />
        Severity ranking
      </h3>
      {rows.length === 0 ? (
        <Skeleton />
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.county} className="flex items-center gap-2">
              <span className="w-16 text-[10px] font-mono text-gray-400 truncate">
                {r.county}
              </span>
              <div className="flex-1 h-2 bg-gray-800 rounded-sm overflow-hidden">
                <div
                  className="h-full transition-all duration-700 ease-out"
                  style={{
                    width: `${Math.max(2, r.normalised * 100)}%`,
                    background:
                      r.value == null
                        ? "#374151"
                        : valueColor(r.value, meta),
                  }}
                />
              </div>
              <span className="w-10 text-[10px] font-mono text-right text-gray-300">
                {r.value == null ? "—" : `#${r.rank}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimeTravelSparkline({
  timeTravel,
  metric,
}: {
  timeTravel: {
    series: Record<string, Record<string, number | null>>;
    slice_labels: Record<string, string>;
  } | null;
  metric: ChoroplethMetric;
}) {
  const meta = getMetricMeta(metric);
  const slices = ["7d", "30d", "90d", "1y", "all"];
  if (!timeTravel) return (
    <div className="bg-gray-900 p-3 min-h-[180px]">
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <Plane className="w-3 h-3" />
        Time travel
      </h3>
      <Skeleton />
    </div>
  );
  const countiesWithData = Object.entries(timeTravel.series["30d"] ?? {})
    .filter(([, v]) => v != null)
    .map(([c]) => c);
  if (countiesWithData.length === 0) {
    return (
      <div className="bg-gray-900 p-3 min-h-[180px]">
        <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
          <Plane className="w-3 h-3" />
          Time travel
        </h3>
        <p className="text-[11px] text-gray-500">No data points yet.</p>
      </div>
    );
  }
  return (
    <div
      data-testid="choropleth-time-travel"
      className="bg-gray-900 p-3 min-h-[180px]"
    >
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <Plane className="w-3 h-3" />
        Time travel · {meta.label}
      </h3>
      <div className="space-y-2.5">
        {countiesWithData.map((county) => {
          const values = slices.map(
            (s) => timeTravel.series[s]?.[county] ?? null,
          );
          const nums = values.filter((v): v is number => v != null);
          if (!nums.length) return null;
          return (
            <Sparkline key={county} values={values} meta={meta} label={county} />
          );
        })}
      </div>
      <div className="mt-2 pt-2 border-t border-gray-800 flex justify-between text-[9px] text-gray-500 font-mono">
        {slices.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
    </div>
  );
}

function Sparkline({
  values,
  meta,
  label,
}: {
  values: (number | null)[];
  meta: MetricMeta;
  label: string;
}) {
  const W = 120;
  const H = 28;
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * W;
    const y =
      v == null ? null : H - ((v - min) / range) * (H - 4) - 2;
    return { x, y, v };
  });
  const path = points
    .filter((p) => p.y != null)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y!.toFixed(1)}`)
    .join(" ");
  const first = nums[0]!;
  const last = nums[nums.length - 1]!;
  const delta = last - first;
  const Trend = delta > 0.5 ? TrendingUp : delta < -0.5 ? TrendingDown : Minus;
  const trendColor = delta > 0.5 ? "#22c55e" : delta < -0.5 ? "#ef4444" : "#9ca3af";
  const trendLabel = delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat";
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-[10px] font-mono text-gray-400 truncate">
        {label}
      </span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="flex-1 h-7"
        aria-label={`${label} trend across time slices`}
      >
        <path
          d={path}
          fill="none"
          stroke={trendColor}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) =>
          p.y == null ? null : (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={1.6}
              fill={trendColor}
              opacity={i === points.length - 1 ? 1 : 0.5}
            />
          ),
        )}
      </svg>
      <span
        className="w-12 text-[10px] font-mono text-right flex items-center justify-end gap-1"
        style={{ color: trendColor }}
      >
        <Trend className="w-3 h-3" />
        {trendLabel}
      </span>
    </div>
  );
}

function InsightsPanel({
  insights,
  alerts,
}: {
  insights: { bullets: string[]; generatedAt: string } | null;
  alerts: { count: number; markers: AlertMarker[] } | null;
}) {
  return (
    <div
      data-testid="choropleth-insights"
      className="bg-gray-900 p-3 min-h-[180px]"
    >
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" />
        Live interpretation
        {alerts && alerts.count > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-red-300">
            <span
              aria-hidden
              className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"
            />
            {alerts.count} active alert{alerts.count === 1 ? "" : "s"}
          </span>
        )}
      </h3>
      {!insights ? (
        <Skeleton />
      ) : (
        <ul className="space-y-1.5 text-[11px] text-gray-200 leading-snug">
          {insights.bullets.map((b, i) => (
            <li key={i} className="flex gap-1.5">
              <ChevronRight className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
      {insights && (
        <p className="mt-2 pt-2 border-t border-gray-800 text-[9px] text-gray-500 font-mono">
          computed {new Date(insights.generatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-3 bg-gray-800 rounded w-3/4" />
      <div className="h-3 bg-gray-800 rounded w-2/3" />
      <div className="h-3 bg-gray-800 rounded w-1/2" />
    </div>
  );
}

// ── Metric metadata + colour scales ────────────────────────────────────

interface MetricMeta {
  label: string;
  unit: string;
  color: (value: number) => string;
  format?: (value: number) => string;
}

function getMetricMeta(metric: ChoroplethMetric): MetricMeta {
  switch (metric) {
    case "reports":
      return {
        label: "Ground-truth reports",
        unit: "reports",
        color: (v) => {
          if (v <= 0) return "#374151";
          if (v < 5) return "#a3e635";
          if (v < 20) return "#facc15";
          if (v < 50) return "#fb923c";
          return "#ef4444";
        },
      };
    case "bcs":
      return {
        label: "Avg Body Condition Score",
        unit: "BCS (1-5)",
        color: (v) => {
          if (v < 2) return "#ef4444";
          if (v < 2.5) return "#fb923c";
          if (v < 3) return "#facc15";
          if (v < 3.5) return "#a3e635";
          return "#22c55e";
        },
        format: (v) => v.toFixed(2),
      };
    case "ndvi":
      return {
        label: "NDVI vs 11-yr baseline",
        unit: "% delta",
        color: (v) => {
          if (v >= 5) return "#22c55e";
          if (v >= -5) return "#84cc16";
          if (v >= -15) return "#facc15";
          if (v >= -30) return "#fb923c";
          return "#ef4444";
        },
        format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
      };
    case "herd":
      return {
        label: "Registered herd",
        unit: "animals",
        color: (v) => {
          if (v <= 0) return "#374151";
          if (v < 50) return "#a3e635";
          if (v < 200) return "#facc15";
          if (v < 1000) return "#fb923c";
          return "#ef4444";
        },
      };
  }
}

function buildStops(meta: MetricMeta): Array<{ label: string; color: string }> {
  switch (meta.unit) {
    case "reports":
      return [
        { label: "0", color: meta.color(0) },
        { label: "<5", color: meta.color(3) },
        { label: "5–19", color: meta.color(15) },
        { label: "20–49", color: meta.color(35) },
        { label: "≥50", color: meta.color(80) },
      ];
    case "BCS (1-5)":
      return [
        { label: "<2 (emaciated)", color: meta.color(1.8) },
        { label: "2–2.5", color: meta.color(2.3) },
        { label: "2.5–3", color: meta.color(2.8) },
        { label: "3–3.5", color: meta.color(3.2) },
        { label: "≥3.5", color: meta.color(3.8) },
      ];
    case "% delta":
      return [
        { label: "≥+5% (greening)", color: meta.color(10) },
        { label: "−5 to +5%", color: meta.color(0) },
        { label: "−15 to −5%", color: meta.color(-10) },
        { label: "−30 to −15%", color: meta.color(-22) },
        { label: "<−30% (critical)", color: meta.color(-40) },
      ];
    case "animals":
      return [
        { label: "0", color: meta.color(0) },
        { label: "<50", color: meta.color(30) },
        { label: "50–199", color: meta.color(150) },
        { label: "200–999", color: meta.color(600) },
        { label: "≥1000", color: meta.color(1500) },
      ];
  }
  return [];
}

function valueColor(v: number, meta: MetricMeta): string {
  return meta.color(v);
}

function formatValue(v: number, meta: MetricMeta): string {
  return meta.format ? meta.format(v) : v.toFixed(0);
}

// ── GeoJSON helpers ──────────────────────────────────────────────────────

/**
 * Defensive wrapper around the style callback Leaflet calls per
 * feature. If anything throws, we return a neutral gray so a bad
 * data shape can't blank the map.
 */
function safeStyle(fn: () => L.PathOptions): L.PathOptions {
  try {
    return fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[Choropleth] style fn failed, using fallback:", err);
    return {
      color: "#1f2937",
      weight: 1,
      fillColor: "#374151",
      fillOpacity: 0.4,
    };
  }
}

function styleForWard(
  feature: GeoJSON.Feature | undefined,
  aggregates: { byWard: Record<string, number | null> } | null,
  meta: MetricMeta,
): L.PathOptions {
  const base: L.PathOptions = {
    color: "#1f2937",
    weight: 1.5,
    fillColor: "#1f2937",
    fillOpacity: 0.5,
  };
  if (!feature) return base;
  const name = String(feature.properties?.["NAME_3"] ?? "");
  const value = aggregates?.byWard[name] ?? null;
  if (value == null) {
    return {
      ...base,
      color: "#1f2937",
      fillColor: "#374151",
      fillOpacity: 0.45,
      weight: 1,
    };
  }
  return {
    ...base,
    fillColor: meta.color(value),
    fillOpacity: 0.85,
    weight: 2.5,
    color: "#0b1220",
  };
}

function styleForCounty(
  feature: GeoJSON.Feature | undefined,
  aggregates: { byCounty: Record<string, number | null> } | null,
  meta: MetricMeta,
): L.PathOptions {
  const base: L.PathOptions = {
    color: "#1f2937",
    weight: 1,
    fillColor: "#1f2937",
    fillOpacity: 0.5,
  };
  if (!feature) return base;
  const name = String(feature.properties?.["COUNTY_NAM"] ?? "").toUpperCase();
  const value = aggregates?.byCounty[name] ?? null;
  if (value == null) {
    return {
      ...base,
      fillColor: "#111827",
      fillOpacity: 0.55,
      weight: 0.5,
      dashArray: "2 3",
    };
  }
  return {
    ...base,
    fillColor: meta.color(value),
    fillOpacity: 0.85,
    weight: 2.5,
    color: "#0b1220",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Programmatic camera flight (for the Tour button) ──────────────────

let activeMap: L.Map | null = null;
let activeWards: IsioloWardsFeatureCollection | null = null;

function dispatchFlyToWard(name: string, durationMs = 1500) {
  if (!activeMap || !activeWards) return;
  const feat = activeWards.features.find(
    (f) => String(f.properties["NAME_3"] ?? "") === name,
  );
  if (!feat) return;
  const coords = feat.geometry.coordinates;
  const lats: number[] = [];
  const lons: number[] = [];
  const visit = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    if (typeof arr[0] === "number") {
      const a = arr as number[];
      lons.push(a[0]!);
      lats.push(a[1]!);
      return;
    }
    for (const x of arr) visit(x);
  };
  visit(coords);
  if (!lats.length) return;
  const bbox: L.LatLngBoundsExpression = [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
  activeMap.flyToBounds(bbox, {
    duration: durationMs / 1000,
    easeLinearity: 0.25,
    maxZoom: 10,
  });
}

function MapBridge() {
  const map = useMap();
  useEffect(() => {
    activeMap = map;
    return () => {
      activeMap = null;
    };
  }, [map]);
  return null;
}

// Module-level cache for the active wards GeoJSON. Used by the
// Tour button's dispatchFlyToWard() helper to find the bbox of the
// ward it's about to fly to. Stored here (rather than passed through
// a context) because only one component writes to it.
function WardsStoreUpdater({ wards }: { wards: IsioloWardsFeatureCollection }) {
  useEffect(() => {
    activeWards = wards;
    return () => {
      activeWards = null;
    };
  }, [wards]);
  return null;
}

export default Choropleth;
