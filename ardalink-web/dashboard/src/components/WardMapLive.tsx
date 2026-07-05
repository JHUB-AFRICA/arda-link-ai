import "leaflet/dist/leaflet.css";
import {
  MapContainer,
  TileLayer,
  Polygon,
  CircleMarker,
  Tooltip,
  LayersControl,
} from "react-leaflet";
import {
  BULA_PESA_MAP_LANDMARKS,
  type MapLandmarkCategory,
} from "../data/bulaPesaLandmarks";

export interface PastoralistPin {
  id: number;
  name: string;
  phone: string;
  location: string | null;
  lastContactAt: string | null;
  cattle: number;
  goats: number;
  camels: number;
}

// Bula Pesa Ward bounding box — matches artifacts/api-server/src/lib/satellite.ts
const BBOX = {
  west: 37.51149,
  south: 0.28284,
  east: 37.65473,
  north: 0.42715,
} as const;
const MID_LAT = (BBOX.north + BBOX.south) / 2;
const MID_LON = (BBOX.east + BBOX.west) / 2;
const CENTER: [number, number] = [MID_LAT, MID_LON];

type Q = "NW" | "NE" | "SW" | "SE";

function quadBounds(q: Q): [number, number][] {
  if (q === "NW")
    return [
      [BBOX.north, BBOX.west],
      [BBOX.north, MID_LON],
      [MID_LAT, MID_LON],
      [MID_LAT, BBOX.west],
    ];
  if (q === "NE")
    return [
      [BBOX.north, MID_LON],
      [BBOX.north, BBOX.east],
      [MID_LAT, BBOX.east],
      [MID_LAT, MID_LON],
    ];
  if (q === "SW")
    return [
      [MID_LAT, BBOX.west],
      [MID_LAT, MID_LON],
      [BBOX.south, MID_LON],
      [BBOX.south, BBOX.west],
    ];
  return [
    [MID_LAT, MID_LON],
    [MID_LAT, BBOX.east],
    [BBOX.south, BBOX.east],
    [BBOX.south, MID_LON],
  ];
}

// Real sub-areas of / adjacent to Bula Pesa Ward, Isiolo
const QUAD_INFO: Record<Q, { name: string; sub: string }> = {
  NW: { name: "Toward Wabera", sub: "Northwest pastures" },
  NE: { name: "Toward Ngare Mara", sub: "Northeast highlands" },
  SW: { name: "Bulla Pesa town & water", sub: "Southwest" },
  SE: { name: "Toward Kambi Garba", sub: "Southeast dryland" },
};

// Approximate locations of real settlements / features in/near Bula Pesa Ward
const PLACES: Array<{
  name: string;
  lat: number;
  lon: number;
  kind: "town" | "settlement" | "water" | "centre";
}> = [
  { name: "Bulla Pesa Town", lat: 0.352, lon: 37.5605, kind: "town" },
  { name: "Ward Centre", lat: MID_LAT, lon: MID_LON, kind: "centre" },
  { name: "Kambi Garba", lat: 0.305, lon: 37.628, kind: "settlement" },
  { name: "Ngare Mara", lat: 0.41, lon: 37.615, kind: "settlement" },
  { name: "Wabera", lat: 0.4, lon: 37.53, kind: "settlement" },
  { name: "Borehole · NW", lat: 0.385, lon: 37.54, kind: "water" },
  { name: "Borehole · SE", lat: 0.32, lon: 37.605, kind: "water" },
];

// Anomaly pct is signed: negative = below 11-yr baseline (stress),
// positive = above baseline (greening). Only deficit drives the stress scale.
function fillColor(pct: number) {
  if (pct >= -5) return "#22c55e"; // within ±5% of normal, or greening
  if (pct >= -15) return "#eab308"; // mild deficit
  if (pct >= -25) return "#f97316"; // high deficit
  return "#ef4444"; // critical deficit
}

function stressLabel(pct: number) {
  if (pct >= 5) return "Above baseline";
  if (pct >= -5) return "Normal";
  if (pct >= -15) return "Mild stress";
  if (pct >= -25) return "High stress";
  return "Critical";
}

// Mapping known location strings to coordinates inside the ward.
// Lowercased keys; substring match. Any pastoralist whose `location` does
// not match falls back to the ward centre with a dashed ring + "unmapped"
// tooltip — we never invent precise coordinates we do not have.
const LOCATION_COORDS: Array<{
  keys: string[];
  lat: number;
  lon: number;
  placeName: string;
}> = [
  {
    keys: ["bulla pesa", "bula pesa town", "bulla pesa town"],
    lat: 0.352,
    lon: 37.5605,
    placeName: "Bulla Pesa Town",
  },
  { keys: ["kambi garba"], lat: 0.305, lon: 37.628, placeName: "Kambi Garba" },
  {
    keys: ["ngare mara", "ngaremara"],
    lat: 0.41,
    lon: 37.615,
    placeName: "Ngare Mara",
  },
  { keys: ["wabera"], lat: 0.4, lon: 37.53, placeName: "Wabera" },
];

function resolvePastoralistCoords(loc: string | null): {
  lat: number;
  lon: number;
  placeName: string | null;
  mapped: boolean;
} {
  if (loc) {
    const l = loc.toLowerCase();
    for (const entry of LOCATION_COORDS) {
      if (entry.keys.some((k) => l.includes(k))) {
        return {
          lat: entry.lat,
          lon: entry.lon,
          placeName: entry.placeName,
          mapped: true,
        };
      }
    }
  }
  return { lat: MID_LAT, lon: MID_LON, placeName: null, mapped: false };
}

function formatLastContact(iso: string | null): string {
  if (!iso) return "no calls yet";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "no calls yet";
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function WardMapLive({
  quadrants,
  worstQuadrant,
  timestamp,
  pastoralists = [],
}: {
  quadrants: { NW: number; NE: number; SW: number; SE: number };
  worstQuadrant: string;
  /** ISO timestamp of the last satellite run from /api/status */
  timestamp?: string;
  pastoralists?: PastoralistPin[];
}) {
  // Group pastoralists by resolved coords so we can offset overlapping pins
  // in a small ring rather than stacking them invisibly on top of each other.
  const positioned = pastoralists.map((p) => ({
    ...p,
    coords: resolvePastoralistCoords(p.location),
  }));
  const groups = new Map<string, typeof positioned>();
  for (const p of positioned) {
    const key = `${p.coords.lat.toFixed(4)},${p.coords.lon.toFixed(4)}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }
  const placedPins: Array<
    (typeof positioned)[number] & { lat: number; lon: number }
  > = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      placedPins.push({
        ...arr[0],
        lat: arr[0].coords.lat,
        lon: arr[0].coords.lon,
      });
    } else {
      const radius = 0.004; // ~440m offset ring
      arr.forEach((p, i) => {
        const angle = (2 * Math.PI * i) / arr.length;
        placedPins.push({
          ...p,
          lat: p.coords.lat + Math.sin(angle) * radius,
          lon: p.coords.lon + Math.cos(angle) * radius,
        });
      });
    }
  }
  const mappedCount = pastoralists.filter(
    (p) => resolvePastoralistCoords(p.location).mapped,
  ).length;

  const snapshot = timestamp
    ? new Date(timestamp).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : new Date().toISOString().slice(0, 10);

  return (
    <div className="relative w-full h-full min-h-[380px] sm:min-h-[460px] rounded-xl overflow-hidden border border-gray-800 bg-gray-950">
      <MapContainer
        center={CENTER}
        zoom={12}
        scrollWheelZoom={false}
        zoomControl
        className="w-full h-full"
        style={{
          background: "#0a0a0a",
          minHeight: 380,
          height: "100%",
          zIndex: 0,
        }}
      >
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="Satellite">
            <TileLayer
              attribution="Imagery © Esri — Esri, USDA, USGS, AEX, GeoEye, IGN, IGP, GIS User Community"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              maxZoom={17}
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Terrain">
            <TileLayer
              attribution="© OpenTopoMap (CC-BY-SA)"
              url="https://a.tile.opentopomap.org/{z}/{x}/{y}.png"
              maxZoom={15}
            />
          </LayersControl.BaseLayer>
        </LayersControl>

        {(["NW", "NE", "SW", "SE"] as const).map((q) => {
          const pct = quadrants[q] ?? 0;
          const color = fillColor(pct);
          const isWorst = worstQuadrant === q;
          return (
            <Polygon
              key={q}
              positions={quadBounds(q)}
              pathOptions={{
                color: isWorst ? "#fca5a5" : color,
                weight: isWorst ? 3 : 1.5,
                fillColor: color,
                fillOpacity: 0.32,
                dashArray: isWorst ? "6 4" : undefined,
              }}
            >
              <Tooltip sticky direction="center" opacity={0.95}>
                <div className="text-xs leading-tight">
                  <div className="font-semibold text-gray-900">
                    {QUAD_INFO[q].name}
                  </div>
                  <div className="text-gray-600">{QUAD_INFO[q].sub}</div>
                  <div className="mt-1 font-mono">
                    {pct.toFixed(1)}% vs 11-yr norm ·{" "}
                    <span style={{ color: fillColor(pct) }}>
                      {stressLabel(pct)}
                    </span>
                  </div>
                  {isWorst && (
                    <div className="text-red-600 font-semibold mt-0.5">
                      ⚠ Worst quadrant
                    </div>
                  )}
                </div>
              </Tooltip>
            </Polygon>
          );
        })}

        <LayersControl.Overlay checked name="Landmarks (OSM)">
          <>
            {BULA_PESA_MAP_LANDMARKS.map((l) => {
              const styles: Record<
                MapLandmarkCategory,
                { color: string; fill: string; r: number; icon: string }
              > = {
                settlement: {
                  color: "#fde68a",
                  fill: "#f59e0b",
                  r: 5,
                  icon: "•",
                },
                river: { color: "#bae6fd", fill: "#0284c7", r: 4, icon: "~" },
                worship: { color: "#e9d5ff", fill: "#a855f7", r: 3, icon: "✦" },
                market: { color: "#fecaca", fill: "#dc2626", r: 4, icon: "▪" },
                civic: { color: "#cbd5e1", fill: "#475569", r: 3, icon: "■" },
                health: { color: "#fbcfe8", fill: "#ec4899", r: 4, icon: "✚" },
                fuel: { color: "#fed7aa", fill: "#ea580c", r: 3, icon: "⛽" },
              };
              const s = styles[l.category];
              return (
                <CircleMarker
                  key={`${l.category}-${l.name}-${l.lat}-${l.lon}`}
                  center={[l.lat, l.lon]}
                  radius={s.r}
                  pathOptions={{
                    color: s.color,
                    fillColor: s.fill,
                    fillOpacity: 0.85,
                    weight: 1,
                  }}
                >
                  <Tooltip
                    direction="top"
                    offset={[0, -2]}
                    opacity={0.95}
                    className="ward-place-label"
                  >
                    <span className="text-[10px]">
                      <span className="opacity-70 mr-1">{s.icon}</span>
                      {l.name}
                      <span className="ml-1 opacity-60 capitalize">
                        · {l.category}
                      </span>
                    </span>
                  </Tooltip>
                </CircleMarker>
              );
            })}
          </>
        </LayersControl.Overlay>

        {PLACES.map((p) => {
          const styles = {
            town: { color: "#fde68a", fill: "#f59e0b", r: 7 },
            centre: { color: "#fde68a", fill: "#f59e0b", r: 6 },
            settlement: { color: "#e5e7eb", fill: "#9ca3af", r: 4 },
            water: { color: "#bae6fd", fill: "#0ea5e9", r: 4 },
          }[p.kind];
          const showLabel = p.kind === "town" || p.kind === "settlement";
          return (
            <CircleMarker
              key={p.name}
              center={[p.lat, p.lon]}
              radius={styles.r}
              pathOptions={{
                color: styles.color,
                fillColor: styles.fill,
                fillOpacity: 0.95,
                weight: 1.5,
              }}
            >
              <Tooltip
                permanent={showLabel}
                direction="top"
                offset={[0, -4]}
                opacity={0.95}
                className="ward-place-label"
              >
                {p.name}
              </Tooltip>
            </CircleMarker>
          );
        })}

        {/* Pastoralist pins */}
        <LayersControl.Overlay
          checked
          name={`Pastoralists (${pastoralists.length})`}
        >
          <>
            {placedPins.map((p) => {
              const hasRecent = p.lastContactAt
                ? Date.now() - new Date(p.lastContactAt).getTime() <
                  24 * 60 * 60 * 1000
                : false;
              const fill = hasRecent
                ? "#10b981"
                : p.coords.mapped
                  ? "#a855f7"
                  : "#71717a";
              const stroke = hasRecent
                ? "#6ee7b7"
                : p.coords.mapped
                  ? "#e9d5ff"
                  : "#d4d4d8";
              return (
                <CircleMarker
                  key={`pastoralist-${p.id}`}
                  center={[p.lat, p.lon]}
                  radius={7}
                  pathOptions={{
                    color: stroke,
                    fillColor: fill,
                    fillOpacity: 0.95,
                    weight: 2,
                    dashArray: p.coords.mapped ? undefined : "3 2",
                  }}
                >
                  <Tooltip
                    direction="top"
                    offset={[0, -6]}
                    opacity={0.95}
                    className="ward-place-label"
                  >
                    <div className="text-[11px] leading-tight">
                      <div className="font-semibold text-gray-900">
                        👤 {p.name}
                      </div>
                      <div className="text-gray-600 font-mono text-[10px]">
                        {p.phone}
                      </div>
                      <div className="text-gray-700 mt-0.5">
                        📍 {p.coords.placeName ?? p.location ?? "Unmapped"}
                        {!p.coords.mapped && (
                          <span className="text-amber-700 ml-1">(approx)</span>
                        )}
                      </div>
                      <div className="text-gray-600 mt-0.5">
                        Last call:{" "}
                        <span className="font-mono">
                          {formatLastContact(p.lastContactAt)}
                        </span>
                      </div>
                      {(p.cattle > 0 || p.goats > 0 || p.camels > 0) && (
                        <div className="text-gray-600 mt-0.5 text-[10px]">
                          🐄 {p.cattle} · 🐐 {p.goats} · 🐪 {p.camels}
                        </div>
                      )}
                    </div>
                  </Tooltip>
                </CircleMarker>
              );
            })}
          </>
        </LayersControl.Overlay>
      </MapContainer>

      {/* Live ribbon */}
      <div className="absolute top-3 left-3 z-[400] flex flex-col gap-1.5 items-start pointer-events-none">
        <div className="bg-amber-900/85 border border-amber-700/70 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider text-amber-100 font-semibold backdrop-blur flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
          Live · Sentinel-2 · {snapshot}
        </div>
        {pastoralists.length > 0 && (
          <div className="bg-emerald-900/85 border border-emerald-700/70 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider text-emerald-100 font-semibold backdrop-blur flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
            Monitoring {pastoralists.length} herder
            {pastoralists.length === 1 ? "" : "s"}
            {mappedCount < pastoralists.length && (
              <span className="text-emerald-300/70 normal-case tracking-normal font-normal">
                · {pastoralists.length - mappedCount} unmapped
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
