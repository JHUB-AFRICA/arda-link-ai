/**
 * WardsLayer — renders the 10 Isiolo wards as a Leaflet GeoJSON layer,
 * coloured by the active metric. Hover highlights a ward; click selects
 * it (calls `onSelectWard` with the ward's NAME_3).
 *
 * Pure presentational component (plus the click handler).
 */
import { GeoJSON, Tooltip as LeafletTooltip } from "react-leaflet";
import L from "leaflet";
import type { ChoroplethMetric } from "@workspace/api-client-react";
import type { IsioloWardsFeatureCollection, WardAggregates } from "./hooks";
import { escapeHtml, formatValue, getMetricMeta, safeStyle, styleForWard, valueColor } from "./utils";

type WardsLayerProps = {
  wards: IsioloWardsFeatureCollection;
  metric: ChoroplethMetric;
  aggregates: WardAggregates;
  presets:
    | { wards: Array<{ name: string; displayName: string; isDemoHome: boolean }> }
    | null;
  /** Currently selected ward (NAME_3) — drawn with a thicker outline. */
  selectedWardId: string | null;
  /** Called when an operator clicks a ward. Called with null on re-click of the selected ward. */
  onSelectWard: (wardId: string | null) => void;
};

/**
 * WardsLayer — the choropleth itself.
 *
 * Tooltip shows the ward display name + active metric value. Mouseover
 * thickens the outline; mouseout restores the original style. Click
 * toggles selection in the parent.
 */
export function WardsLayer({
  wards,
  metric,
  aggregates,
  presets,
  selectedWardId,
  onSelectWard,
}: WardsLayerProps) {
  const meta = getMetricMeta(metric);
  return (
    <GeoJSON
      key={`wards-${metric}`}
      data={wards as unknown as GeoJSON.GeoJsonObject}
      style={(f) =>
        safeStyle(() => {
          const base = styleForWard(f, aggregates, meta);
          const name = String(f?.properties?.["NAME_3"] ?? "");
          if (name === selectedWardId) {
            return { ...base, weight: 4, color: "#fbbf24", dashArray: undefined };
          }
          return base;
        })
      }
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
            if (!name) return;
            onSelectWard(name === selectedWardId ? null : name);
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