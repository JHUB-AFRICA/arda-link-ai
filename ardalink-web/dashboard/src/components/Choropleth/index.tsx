/**
 * Choropleth — ward-level choropleth with herder + report pins.
 *
 * Orchestrator component. Owns:
 * - the metric and slice state (synced to localStorage-friendly defaults)
 * - the layer-visibility state (herder pins, report pins)
 * - the selected-ward state (controlled)
 *
 * Reads data via {@link useChoroplethData} and delegates rendering to:
 * - {@link Header}            — control bar
 * - {@link WardsLayer}        — choropleth layer
 * - {@link PastoralistPinsLayer} — herder pins
 * - {@link ReportPinsLayer}   — report pins
 * - {@link AlertMarkersLayer} — alert pins
 * - {@link Legend}            — colour scale + selected-ward readout
 * - {@link Hud}               — time-slice indicator overlay
 * - {@link Comparison}        — ward-vs-ward panel
 * - {@link SeverityBars}      — ranked severity list
 * - {@link TimeTravelSparkline} — historical trend
 * - {@link InsightsPanel}     — narrative insights + alert count
 *
 * The selected ward is a controlled prop pair (`selectedWardId` /
 * `onSelectWard`) owned by the parent (`dashboard.tsx`).
 */
import { useEffect, useState } from "react";
import {
  MapContainer,
  TileLayer,
  ZoomControl,
  useMap,
} from "react-leaflet";
import { Loader2, AlertTriangle } from "lucide-react";
import type { LatLngBoundsExpression } from "leaflet";
import type {
  ChoroplethMetric,
  TimeSlice,
} from "@workspace/api-client-react";
import { Header } from "./Header";
import { Hud } from "./Hud";
import { Legend } from "./Legend";
import { WardsLayer } from "./WardsLayer";
import { PastoralistPinsLayer } from "./PastoralistPinsLayer";
import { ReportPinsLayer } from "./ReportPinsLayer";
import { AlertMarkersLayer } from "./AlertMarkersLayer";
import { Comparison } from "./Panels/Comparison";
import { SeverityBars } from "./Panels/SeverityBars";
import { TimeTravelSparkline } from "./Panels/TimeTravelSparkline";
import { InsightsPanel } from "./Panels/InsightsPanel";
import {
  useChoroplethData,
  type IsioloWardsFeatureCollection,
} from "./hooks";

type ChoroplethProps = {
  /** Ward the operator clicked. Drives map highlight + comparison panel. */
  selectedWardId: string | null;
  /** Called when the operator clicks a different (or the same) ward. */
  onSelectWard: (wardId: string | null) => void;
  /** Optional initial metric — defaults to "bcs". */
  initialMetric?: ChoroplethMetric;
  /** Optional initial slice — defaults to "30d". */
  initialSlice?: TimeSlice;
};

/** Initial view bounds for the Isiolo wards map. */
const ISIOLO_BBOX: LatLngBoundsExpression = [
  [0.0, 36.0],
  [1.2, 39.5],
];

/** Camera controller — fits the map to the Isiolo wards on mount. */
function FitOnMount() {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(ISIOLO_BBOX, { padding: [20, 20] });
  }, [map]);
  return null;
}

/**
 * Choropleth — ward-level choropleth for Isiolo.
 *
 * Responsibilities:
 * 1. Load the Isiolo wards GeoJSON once on mount.
 * 2. Drive all data hooks via {@link useChoroplethData}.
 * 3. Compose the header, map, and four analysis panels.
 * 4. Relay the operator's selected ward back to the parent.
 */
export function Choropleth({
  selectedWardId,
  onSelectWard,
  initialMetric = "bcs",
  initialSlice = "30d",
}: ChoroplethProps) {
  const [metric, setMetric] = useState<ChoroplethMetric>(initialMetric);
  const [slice, setSlice] = useState<TimeSlice>(initialSlice);
  const [showHerderPins, setShowHerderPins] = useState(true);
  const [showReportPins, setShowReportPins] = useState(true);
  const [isioloWards, setIsioloWards] =
    useState<IsioloWardsFeatureCollection | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoLoading, setGeoLoading] = useState(true);

  // Esc clears the selected ward (only when this tab owns focus).
  useEffect(() => {
    if (!selectedWardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSelectWard(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedWardId, onSelectWard]);

  // Load the Isiolo wards GeoJSON once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/open-data/geo/isiolo-wards");
        if (!res.ok) throw new Error(`isiolo-wards: HTTP ${res.status}`);
        const json = (await res.json()) as IsioloWardsFeatureCollection;
        if (!cancelled) {
          setIsioloWards(json);
          setGeoLoading(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setGeoError(
            e instanceof Error ? e.message : "Failed to load ward GeoJSON",
          );
          setGeoLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const data = useChoroplethData(metric, slice);
  const selectedWardPreset = selectedWardId
    ? data.wardPresets?.wards.find((w) => w.name === selectedWardId) ?? null
    : null;
  const selectedWardValue =
    selectedWardId && data.wardAggregates
      ? data.wardAggregates.byWard[selectedWardId] ?? null
      : null;

  return (
    <div
      data-testid="choropleth"
      className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-xl"
    >
      <Header
        metric={metric}
        onMetricChange={setMetric}
        slice={slice}
        onSliceChange={setSlice}
        showHerderPins={showHerderPins}
        onToggleHerderPins={setShowHerderPins}
        showReportPins={showReportPins}
        onToggleReportPins={setShowReportPins}
        wardCount={data.wardPresets?.wards.length ?? 0}
        pastoralistCount={data.pastoralistPins?.count ?? 0}
        reportCount={data.reportPins?.count ?? 0}
      />

      <div className="relative h-[46vh] min-h-[380px] bg-gray-950">
        {geoLoading && (
          <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-gray-950/80 text-gray-300 text-sm">
            <Loader2 className="w-5 h-5 mr-2 animate-spin text-amber-400" />
            Loading ward boundaries…
          </div>
        )}
        {geoError && (
          <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-gray-950/80 text-red-300 text-sm p-4 text-center">
            <AlertTriangle className="w-5 h-5 mr-2 shrink-0" />
            {geoError}
          </div>
        )}

        <MapContainer
          center={[0.49, 38.0]}
          zoom={8}
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

          {isioloWards && (
            <>
              <WardsLayer
                wards={isioloWards}
                metric={metric}
                aggregates={data.wardAggregates}
                presets={data.wardPresets}
                selectedWardId={selectedWardId}
                onSelectWard={onSelectWard}
              />
              {showHerderPins && (
                <PastoralistPinsLayer
                  pins={data.pastoralistPins?.pins ?? []}
                />
              )}
              {showReportPins && (
                <ReportPinsLayer pins={data.reportPins?.pins ?? []} />
              )}
              <AlertMarkersLayer markers={data.alerts?.markers ?? []} />
            </>
          )}

          <FitOnMount />
        </MapContainer>

        <Legend
          metric={metric}
          selectedWardValue={selectedWardValue}
          selectedWardName={selectedWardPreset?.displayName ?? null}
        />

        <Hud slice={slice} />
      </div>

      {/* Side-by-side analysis panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-px bg-gray-800">
        <Comparison
          metric={metric}
          slice={slice}
          wardAggregates={data.wardAggregates}
          wardPresets={data.wardPresets?.wards ?? []}
          selectedWardId={selectedWardId}
        />
        <SeverityBars
          rows={data.rankings?.rows ?? []}
          metric={(data.rankings?.metric ?? metric) as ChoroplethMetric}
        />
        <TimeTravelSparkline
          timeTravel={data.timeTravel}
          metric={metric}
        />
        <InsightsPanel
          insights={data.insights}
          alerts={data.alerts}
        />
      </div>
    </div>
  );
}

export default Choropleth;