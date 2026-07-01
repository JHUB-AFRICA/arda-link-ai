/**
 * utils — pure helpers for the Choropleth module.
 *
 * Public surface:
 *   - {@link MetricMeta}                       — display + colour metadata per metric
 *   - {@link getMetricMeta}                    — resolve metadata for a metric
 *   - {@link buildStops}                       — legend colour stops for a metric
 *   - {@link valueColor}                       — pick a colour for a single value
 *   - {@link formatValue}                      — format a value for display
 *   - {@link styleForWard}                     — Leaflet style callback for a ward feature
 *   - {@link safeStyle}                        — defensive wrapper around style callbacks
 *   - {@link escapeHtml}                       — escape strings for Leaflet HTML tooltips
 *
 * Depends on: react-leaflet types, leaflet (for {@link L.PathOptions}).
 *
 * Pure module — no React, no hooks, no I/O.
 */
import type { ChoroplethMetric } from "@workspace/api-client-react";
import type { PathOptions } from "leaflet";

// ────────────────────────────────────────────────────────────────────────
//  Metric metadata
// ────────────────────────────────────────────────────────────────────────

/** Per-metric display label, unit, colour function, and optional formatter. */
export interface MetricMeta {
  /** Human-readable metric name shown in the legend and tooltips. */
  label: string;
  /** Unit shown in the column header and tooltip suffix. */
  unit: string;
  /** Pick a colour for a numeric value on this metric's scale. */
  color: (value: number) => string;
  /** Optional format override — defaults to `n.toFixed(0)`. */
  format?: (value: number) => string;
}

/**
 * Resolve the display metadata for a metric.
 *
 * @param metric The active metric key from the typed API surface.
 * @returns      A {@link MetricMeta} with label, unit, and colour function.
 */
export function getMetricMeta(metric: ChoroplethMetric): MetricMeta {
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

/**
 * Build the legend colour stops for a metric — five buckets keyed off the
 * metric's domain so the operator can read the scale at a glance.
 */
export function buildStops(
  meta: MetricMeta,
): Array<{ label: string; color: string }> {
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

/** Pick the colour for a single value on the active metric's scale. */
export function valueColor(v: number, meta: MetricMeta): string {
  return meta.color(v);
}

/** Format a value for display in tooltips and panel cells. */
export function formatValue(v: number, meta: MetricMeta): string {
  return meta.format ? meta.format(v) : v.toFixed(0);
}

// ────────────────────────────────────────────────────────────────────────
//  Leaflet style helpers
// ────────────────────────────────────────────────────────────────────────

/** Aggregates shape used by both {@link styleForWard} and the panels. */
export interface WardAggregatesLike {
  byWard: Record<string, number | null>;
}

/**
 * Defensive wrapper around the style callback Leaflet calls per feature.
 * If anything throws, we return a neutral gray so a bad data shape
 * can't blank the map.
 */
export function safeStyle(fn: () => PathOptions): PathOptions {
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

/**
 * Compute the Leaflet path style for a single ward feature.
 *
 * - No data → gray, thin
 * - Has value → fill colour from the active metric's scale
 */
export function styleForWard(
  feature: GeoJSON.Feature | undefined,
  aggregates: WardAggregatesLike | null,
  meta: MetricMeta,
): PathOptions {
  const base: PathOptions = {
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

// ────────────────────────────────────────────────────────────────────────
//  HTML escaping (Leaflet tooltips accept raw HTML)
// ────────────────────────────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in a Leaflet HTML tooltip.
 *
 * Leaflet binds tooltips as innerHTML, so any user-controlled value
 * (herder name, place name, ward display name) must be escaped.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}