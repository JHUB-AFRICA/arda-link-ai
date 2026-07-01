/**
 * WardDetailLayer — rich-detail overlay for a selected ward.
 *
 * Renders three layers, all keyed off the same `WardDetail` payload:
 * - quadrants (4 polygons — NW / NE / SW / SE)
 * - landmarks (~50 OSM points per ward — settlements, rivers, worship,
 *   markets, civic, health, fuel)
 * - named places (~7 hardcoded per ward — towns, ward centre, boreholes)
 *
 * Pure presentational component — every Leaflet layer it mounts is a
 * direct render of props. The parent owns the selection state.
 */
import { Polygon, CircleMarker, Tooltip as LeafletTooltip } from "react-leaflet";
import type {
  WardDetail,
  WardLandmark,
  WardPlace,
  WardQuadrant,
} from "@workspace/api-client-react";

// ── Style tables (kept here, not in utils, because they are
//    presentation-only and only this file consumes them) ────────────

/** Colour + radius for each landmark category. */
const LANDMARK_STYLES: Record<
  string,
  { color: string; fill: string; r: number; icon: string }
> = {
  settlement: { color: "#fde68a", fill: "#f59e0b", r: 5, icon: "•" },
  river:      { color: "#bae6fd", fill: "#0284c7", r: 4, icon: "~" },
  worship:    { color: "#e9d5ff", fill: "#a855f7", r: 3, icon: "✦" },
  market:     { color: "#fecaca", fill: "#dc2626", r: 4, icon: "▪" },
  civic:      { color: "#cbd5e1", fill: "#475569", r: 3, icon: "■" },
  health:     { color: "#fbcfe8", fill: "#ec4899", r: 4, icon: "✚" },
  fuel:       { color: "#fed7aa", fill: "#ea580c", r: 3, icon: "⛽" },
};

/** Colour + radius for each named place kind. */
const PLACE_STYLES: Record<string, { color: string; fill: string; r: number }> = {
  town:       { color: "#fde68a", fill: "#f59e0b", r: 7 },
  centre:     { color: "#fde68a", fill: "#f59e0b", r: 6 },
  settlement: { color: "#e5e7eb", fill: "#9ca3af", r: 4 },
  water:      { color: "#bae6fd", fill: "#0ea5e9", r: 4 },
};

/** Default fill for a quadrant when no metric data is available. */
const QUADRANT_DEFAULT_FILL = "#475569";
const QUADRANT_DEFAULT_OPACITY = 0.18;

type LandmarkMarkerProps = {
  landmark: WardLandmark;
};

/** Single landmark marker — small circle with a tooltip showing the name + category. */
function LandmarkMarker({ landmark }: LandmarkMarkerProps) {
  const style = LANDMARK_STYLES[landmark.category] ?? {
    color: "#9ca3af",
    fill: "#6b7280",
    r: 3,
    icon: "?",
  };
  return (
    <CircleMarker
      key={`lm-${landmark.name}-${landmark.lat}-${landmark.lon}`}
      center={[landmark.lat, landmark.lon]}
      radius={style.r}
      pathOptions={{
        color: style.color,
        fillColor: style.fill,
        fillOpacity: 0.85,
        weight: 1,
      }}
    >
      <LeafletTooltip direction="top" offset={[0, -2]} opacity={0.95}>
        <span className="text-[10px]">
          <span className="opacity-70 mr-1">{style.icon}</span>
          {landmark.name}
          <span className="ml-1 opacity-60 capitalize">· {landmark.category}</span>
        </span>
      </LeafletTooltip>
    </CircleMarker>
  );
}

type PlaceMarkerProps = {
  place: WardPlace;
};

/** Single named place marker — bigger than landmarks, with kind-based styling. */
function PlaceMarker({ place }: PlaceMarkerProps) {
  const style = PLACE_STYLES[place.kind] ?? {
    color: "#9ca3af",
    fill: "#6b7280",
    r: 4,
  };
  const showLabel = place.kind === "town" || place.kind === "settlement";
  return (
    <CircleMarker
      key={`pl-${place.name}-${place.lat}-${place.lon}`}
      center={[place.lat, place.lon]}
      radius={style.r}
      pathOptions={{
        color: style.color,
        fillColor: style.fill,
        fillOpacity: 0.9,
        weight: 1.5,
      }}
    >
      <LeafletTooltip
        direction="right"
        offset={[8, 0]}
        permanent={showLabel}
        opacity={0.95}
        className="ward-place-label"
      >
        <span className="text-[10px] font-semibold">{place.name}</span>
      </LeafletTooltip>
    </CircleMarker>
  );
}

type QuadrantPolygonProps = {
  quadrant: WardQuadrant;
  isWorst?: boolean;
};

/** Single quadrant polygon — neutral fill with a tooltip naming it. */
function QuadrantPolygon({ quadrant, isWorst = false }: QuadrantPolygonProps) {
  // Leaflet accepts [lat, lon] tuples directly.
  const positions: Array<[number, number]> = quadrant.polygon;
  return (
    <Polygon
      key={`q-${quadrant.id}`}
      positions={positions}
      pathOptions={{
        color: isWorst ? "#fca5a5" : "#94a3b8",
        weight: isWorst ? 2.5 : 1.2,
        fillColor: isWorst ? "#fca5a5" : QUADRANT_DEFAULT_FILL,
        fillOpacity: isWorst ? 0.28 : QUADRANT_DEFAULT_OPACITY,
        dashArray: isWorst ? "6 4" : undefined,
      }}
    >
      <LeafletTooltip sticky direction="center" opacity={0.95}>
        <div className="text-xs leading-tight">
          <div className="font-semibold text-gray-900">{quadrant.name}</div>
          <div className="text-gray-600">{quadrant.sub}</div>
          {isWorst && (
            <div className="text-red-600 font-semibold mt-0.5">
              ⚠ Worst quadrant
            </div>
          )}
        </div>
      </LeafletTooltip>
    </Polygon>
  );
}

type WardDetailLayerProps = {
  /** Detail payload — pass `null` or undefined for "no detail yet / no detail data". */
  detail: WardDetail | null | undefined;
  /** Optional: which quadrant ID to highlight as worst. */
  worstQuadrantId?: string | null;
};

/**
 * WardDetailLayer — full-detail overlay for a selected ward.
 *
 * Mounts nothing when `detail` is null/undefined or when the ward has
 * no quadrants / landmarks / places. Otherwise mounts all three layer
 * groups inside whatever `<MapContainer>` this is rendered into.
 */
export function WardDetailLayer({ detail, worstQuadrantId }: WardDetailLayerProps) {
  if (!detail) return null;
  const { quadrants, landmarks, places } = detail;
  const hasContent =
    quadrants.length > 0 || landmarks.length > 0 || places.length > 0;
  if (!hasContent) return null;
  return (
    <>
      {quadrants.map((q) => (
        <QuadrantPolygon
          key={q.id}
          quadrant={q}
          isWorst={worstQuadrantId === q.id}
        />
      ))}
      {landmarks.map((lm) => (
        <LandmarkMarker key={`lm-${lm.name}-${lm.lat}-${lm.lon}`} landmark={lm} />
      ))}
      {places.map((p) => (
        <PlaceMarker key={`pl-${p.name}-${p.lat}-${p.lon}`} place={p} />
      ))}
    </>
  );
}