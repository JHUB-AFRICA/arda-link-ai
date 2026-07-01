/**
 * AlertMarkersLayer — CircleMarker per active alert, jittered around
 * the Isiolo centroid so they don't overlap.
 *
 * Pure presentational component.
 */
import { CircleMarker, Tooltip as LeafletTooltip } from "react-leaflet";
import type { AlertMarker } from "./hooks";

type AlertMarkersLayerProps = {
  markers: AlertMarker[];
};

/** Isiolo centroid used as the alert jitter origin. */
const ISIOLO_CENTER: [number, number] = [0.355, 37.583];

/**
 * AlertMarkersLayer — overlay of alert markers.
 *
 * Markers are scattered on concentric rings around the Isiolo centroid
 * so multiple alerts in the same ward don't perfectly overlap. Red
 * markers get a larger radius than yellow ones.
 */
export function AlertMarkersLayer({ markers }: AlertMarkersLayerProps) {
  if (!markers.length) return null;
  return (
    <>
      {markers.map((m, i) => {
        const angle = (i / Math.max(1, markers.length)) * 2 * Math.PI;
        const radius = 0.06 + (i % 3) * 0.02;
        const lat = ISIOLO_CENTER[0] + Math.sin(angle) * radius;
        const lon = ISIOLO_CENTER[1] + Math.cos(angle) * radius * 1.2;
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
              <div style={{ fontWeight: 600 }}>
                [{m.severity.toUpperCase()}] {m.kind.replace(/_/g, " ")}
              </div>
              <div style={{ opacity: 0.8 }}>{m.message}</div>
              <div style={{ opacity: 0.6 }}>
                Quadrant: {m.quadrant ?? "—"} · {new Date(m.createdAt).toLocaleDateString()}
              </div>
            </LeafletTooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}