/**
 * ReportPinsLayer — CircleMarker per ground-truth report, coloured by
 * alert severity (BCS, NDVI, or mortality).
 *
 * Pure presentational component.
 */
import { CircleMarker, Tooltip as LeafletTooltip } from "react-leaflet";
import type { ReportPin } from "./hooks";
import { escapeHtml } from "./utils";

type ReportPinsLayerProps = {
  pins: ReportPin[];
};

/** Resolve the marker colour from a report's BCS / NDVI / mortality. */
function reportColor(p: ReportPin): { color: string; isAlert: boolean } {
  const bcs = p.bcsScore;
  const ndvi = p.ndviVsBaselinePercent;
  const isAlert = p.mortalityRate === "4-plus" || (bcs != null && bcs <= 2);
  if (isAlert) return { color: "#ef4444", isAlert: true };
  if (bcs != null) {
    if (bcs < 2.5) return { color: "#fb923c", isAlert: false };
    if (bcs < 3) return { color: "#facc15", isAlert: false };
    return { color: "#a3e635", isAlert: false };
  }
  if (ndvi != null) {
    if (ndvi <= -30) return { color: "#ef4444", isAlert: false };
    if (ndvi <= -15) return { color: "#fb923c", isAlert: false };
    return { color: "#facc15", isAlert: false };
  }
  return { color: "#3b82f6", isAlert: false };
}

/**
 * ReportPinsLayer — overlay of ground-truth report markers.
 *
 * Marker colour: red if mortality "4+" or BCS ≤ 2, otherwise a traffic-
 * light scale on BCS or NDVI. Alert markers get a CSS pulse animation.
 */
export function ReportPinsLayer({ pins }: ReportPinsLayerProps) {
  return (
    <>
      {pins.map((p) => {
        const { color, isAlert } = reportColor(p);
        const bcs = p.bcsScore;
        const ndvi = p.ndviVsBaselinePercent;
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