/**
 * PastoralistPinsLayer — CircleMarker per herder, sized by herd total.
 *
 * Pure presentational component. Reads from the typed API surface.
 */
import { CircleMarker, Tooltip as LeafletTooltip } from "react-leaflet";
import type { PastoralistPin } from "./hooks";
import { escapeHtml } from "./utils";

type PastoralistPinsLayerProps = {
  pins: PastoralistPin[];
};

/**
 * PastoralistPinsLayer — overlay of herder markers.
 *
 * Marker radius scales with log10(herd total). Unmapped herders
 * (ward centre only) are drawn grey; mapped herders are green.
 */
export function PastoralistPinsLayer({ pins }: PastoralistPinsLayerProps) {
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