/**
 * WardMap — pure-SVG choropleth of Isiolo's 5 active wards.
 *
 * We render Supabase's PostGIS geometry directly. With only 5 wards
 * pulling a full map library (leaflet/mapbox) is overkill — a bounded
 * SVG viewport works, is dependency-free, and stays crisp at any size.
 * Colour scales with NDVI (the same signal the deterministic voice
 * pipeline reads out to herders).
 *
 * Data source: `GET /api/wards/map` (public — served by
 * `ardalink-api/src/routes/wards.ts`). Falls back to an empty state
 * when Supabase is unconfigured or unreachable.
 */

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

interface WardMapWard {
  ward_id: string;
  name: string;
  county: string;
  centroid: {
    type: "Point";
    coordinates: [number, number];
  } | null;
  geometry: {
    type: "MultiPolygon";
    coordinates: number[][][][];
  } | null;
  ndvi_mean: number | null;
  vci_value: number | null;
  ndre_mean: number | null;
  period_end: string | null;
}

interface WardMapEdge {
  a: string;
  b: string;
  km: number;
}

interface WardMapResponse {
  ready: boolean;
  wards: WardMapWard[];
  edges: WardMapEdge[];
  supabase: { configured: boolean; reachable: boolean };
}

interface CellLatest {
  ward_cell_id: string;
  ward_id: string;
  cell_size_m: number;
  centroid_lat: number;
  centroid_lon: number;
  ndvi_mean: number | null;
  vci_value: number | null;
  ndvi_anomaly: number | null;
}

interface CellsResponse {
  ready: boolean;
  count: number;
  cells: CellLatest[];
}

/**
 * NDVI colour scale — brown (bare / stressed) → yellow → green (healthy).
 * Tuned to Isiolo drylands where the typical range is 0.10 – 0.40.
 */
function ndviColour(ndvi: number | null): string {
  if (ndvi == null) return "#374151"; // gray-700 — no data
  const clamped = Math.max(0.1, Math.min(0.5, ndvi));
  const t = (clamped - 0.1) / 0.4; // 0..1
  // Interpolate through brown → yellow → green.
  if (t < 0.5) {
    // brown (#78350f) → yellow (#eab308)
    const s = t / 0.5;
    const r = Math.round(0x78 + s * (0xea - 0x78));
    const g = Math.round(0x35 + s * (0xb3 - 0x35));
    const b = Math.round(0x0f + s * (0x08 - 0x0f));
    return `rgb(${r},${g},${b})`;
  }
  // yellow → green (#22c55e)
  const s = (t - 0.5) / 0.5;
  const r = Math.round(0xea + s * (0x22 - 0xea));
  const g = Math.round(0xb3 + s * (0xc5 - 0xb3));
  const b = Math.round(0x08 + s * (0x5e - 0x08));
  return `rgb(${r},${g},${b})`;
}

interface Bounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

function polygonBounds(coords: number[][][][]): Bounds | null {
  let minLon = Infinity,
    maxLon = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  let any = false;
  for (const poly of coords) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        any = true;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return any ? { minLon, maxLon, minLat, maxLat } : null;
}

function unionBounds(list: (Bounds | null)[]): Bounds | null {
  let b: Bounds | null = null;
  for (const cur of list) {
    if (!cur) continue;
    if (!b) b = { ...cur };
    else {
      b.minLon = Math.min(b.minLon, cur.minLon);
      b.maxLon = Math.max(b.maxLon, cur.maxLon);
      b.minLat = Math.min(b.minLat, cur.minLat);
      b.maxLat = Math.max(b.maxLat, cur.maxLat);
    }
  }
  return b;
}

export function WardMap() {
  const [heatmapOn, setHeatmapOn] = useState(false);

  const q = useQuery<WardMapResponse>({
    queryKey: ["wards-map"],
    queryFn: async () => {
      const res = await fetch("/api/wards/map");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as WardMapResponse;
    },
    // Ward polygons don't change. Cache aggressively.
    staleTime: 10 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const data = q.data;
  const wardIds = data?.wards.map((w) => w.ward_id) ?? [];

  // One query per ward for the ~1 km cell heatmap. Only fires when
  // the toggle is on so we don't pay the ~3300-cell payload cost by
  // default. Cell NDVI is monthly-updated so cache aggressively.
  const cellQueries = useQueries({
    queries: wardIds.map((wardId) => ({
      queryKey: ["ward-cells", wardId] as const,
      enabled: heatmapOn,
      staleTime: 30 * 60_000,
      queryFn: async (): Promise<CellsResponse> => {
        const res = await fetch(`/api/wards/${wardId}/cells/latest?limit=2000`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as CellsResponse;
      },
    })),
  });

  const allCells = useMemo(() => {
    if (!heatmapOn) return [];
    const out: CellLatest[] = [];
    for (const q of cellQueries) {
      if (q.data?.ready) out.push(...q.data.cells);
    }
    return out;
  }, [cellQueries, heatmapOn]);
  const cellsLoading = heatmapOn && cellQueries.some((q) => q.isLoading);

  const projected = useMemo(() => {
    if (!data?.wards || data.wards.length === 0) return null;
    const bounds = unionBounds(
      data.wards.map((w) => polygonBounds(w.geometry?.coordinates ?? [])),
    );
    if (!bounds) return null;

    const WIDTH = 400;
    const HEIGHT = 260;
    const pad = 12;
    const scaleX = (WIDTH - pad * 2) / (bounds.maxLon - bounds.minLon);
    const scaleY = (HEIGHT - pad * 2) / (bounds.maxLat - bounds.minLat);
    const scale = Math.min(scaleX, scaleY);
    const project = (lon: number, lat: number): [number, number] => {
      const x = pad + (lon - bounds.minLon) * scale;
      // SVG y grows downward — flip.
      const y = HEIGHT - pad - (lat - bounds.minLat) * scale;
      return [x, y];
    };
    return { WIDTH, HEIGHT, project };
  }, [data]);

  if (q.isLoading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-sm text-gray-500 italic">
        Loading ward map…
      </div>
    );
  }
  if (!data?.ready || !projected) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-sm text-gray-500 italic">
        Ward map unavailable — Supabase not configured or unreachable.
      </div>
    );
  }

  const { WIDTH, HEIGHT, project } = projected;

  const centroidById = new Map<string, [number, number]>();
  for (const w of data.wards) {
    if (!w.centroid) continue;
    const [lon, lat] = w.centroid.coordinates;
    centroidById.set(w.ward_id, project(lon, lat));
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Isiolo ward map</h3>
          <p className="text-[10px] text-gray-500">
            NDVI-coloured from Supabase — brown = stressed, green = healthy
          </p>
        </div>
        <div className="text-[10px] text-gray-400 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setHeatmapOn((v) => !v)}
            className={`px-2 py-1 rounded border text-[10px] font-medium transition ${
              heatmapOn
                ? "border-emerald-500 text-emerald-300 bg-emerald-950/30"
                : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"
            }`}
            aria-pressed={heatmapOn}
            title="Overlay per-cell NDVI heatmap (~1 km grid, up to 3 300 cells)"
          >
            {cellsLoading ? "Loading…" : heatmapOn ? "Cells: on" : "Cells: off"}
          </button>
          <span className="hidden sm:inline-flex items-center gap-2">
            <span
              className="inline-block w-3 h-3 rounded"
              style={{ background: ndviColour(0.1) }}
            />
            <span>0.10</span>
            <span
              className="inline-block w-3 h-3 rounded"
              style={{ background: ndviColour(0.3) }}
            />
            <span>0.30</span>
            <span
              className="inline-block w-3 h-3 rounded"
              style={{ background: ndviColour(0.5) }}
            />
            <span>0.50</span>
          </span>
        </div>
      </div>

      <div className="p-4 flex flex-col items-center">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full max-w-md"
          role="img"
          aria-label="Isiolo Sub-County active ward polygons coloured by NDVI"
        >
          {/* Adjacency edges — thin gray lines between ward centroids. */}
          {data.edges.map((e) => {
            const a = centroidById.get(e.a);
            const b = centroidById.get(e.b);
            if (!a || !b) return null;
            return (
              <line
                key={`${e.a}-${e.b}`}
                x1={a[0]}
                y1={a[1]}
                x2={b[0]}
                y2={b[1]}
                stroke="rgba(148,163,184,0.35)"
                strokeWidth={0.8}
                strokeDasharray="2 2"
              />
            );
          })}

          {/* Per-cell heatmap layer — rendered as centroid dots. Each
              cell is ~1 km wide; dot size 1.4 px in the 400 × 260
              viewport gives roughly the right visual scale for the 5
              wards' union bounding box. */}
          {heatmapOn &&
            allCells.map((c) => {
              const [x, y] = project(c.centroid_lon, c.centroid_lat);
              return (
                <circle
                  key={c.ward_cell_id}
                  cx={x}
                  cy={y}
                  r={1.4}
                  fill={ndviColour(c.ndvi_mean)}
                  fillOpacity={0.9}
                  stroke="none"
                >
                  <title>
                    {`${c.ward_cell_id} · NDVI ${
                      c.ndvi_mean == null ? "—" : c.ndvi_mean.toFixed(3)
                    }${
                      c.vci_value == null
                        ? ""
                        : ` · VCI ${c.vci_value.toFixed(0)}`
                    }${
                      c.ndvi_anomaly == null
                        ? ""
                        : ` · Δ ${c.ndvi_anomaly.toFixed(3)}`
                    }`}
                  </title>
                </circle>
              );
            })}

          {/* Ward polygons — filled by ward-mean NDVI when the heatmap
              layer is off; outline-only when the heatmap is on so the
              per-cell dots show through cleanly. */}
          {data.wards.map((w) => {
            const geom = w.geometry;
            if (!geom) return null;
            const fill = heatmapOn ? "transparent" : ndviColour(w.ndvi_mean);
            const paths = geom.coordinates.map((poly, i) => {
              const rings = poly.map((ring) =>
                ring
                  .map(([lon, lat], j) => {
                    const [x, y] = project(lon, lat);
                    return `${j === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(
                      2,
                    )}`;
                  })
                  .join(" ") + " Z",
              );
              return (
                <path
                  key={`${w.ward_id}-p${i}`}
                  d={rings.join(" ")}
                  fill={fill}
                  fillOpacity={0.85}
                  stroke="#0f172a"
                  strokeWidth={0.6}
                >
                  <title>
                    {`${w.name} (${w.ward_id}) · NDVI ${
                      w.ndvi_mean == null ? "—" : w.ndvi_mean.toFixed(3)
                    }`}
                  </title>
                </path>
              );
            });
            return <g key={w.ward_id}>{paths}</g>;
          })}

          {/* Ward labels. */}
          {data.wards.map((w) => {
            const c = centroidById.get(w.ward_id);
            if (!c) return null;
            return (
              <g key={`label-${w.ward_id}`}>
                <text
                  x={c[0]}
                  y={c[1] - 2}
                  fontSize={9}
                  textAnchor="middle"
                  fill="#f8fafc"
                  fontWeight={600}
                  style={{
                    textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                    pointerEvents: "none",
                  }}
                >
                  {w.name}
                </text>
                <text
                  x={c[0]}
                  y={c[1] + 8}
                  fontSize={7}
                  textAnchor="middle"
                  fill="#e2e8f0"
                  style={{
                    textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                    pointerEvents: "none",
                  }}
                >
                  {w.ndvi_mean == null ? "—" : w.ndvi_mean.toFixed(2)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
