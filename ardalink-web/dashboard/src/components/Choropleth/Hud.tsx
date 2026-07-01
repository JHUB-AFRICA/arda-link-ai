/**
 * Hud — fixed-position overlay that shows the current time-slice
 * context (altitude + heading) and the view scope.
 *
 * Always visible. Non-interactive. Positioned top-right of the map.
 */
import { Compass } from "lucide-react";
import type { TimeSlice } from "@workspace/api-client-react";

/** Altitudes per time slice, in flight-deck "feet". Decorative only. */
const ALTITUDES: Record<TimeSlice, number> = {
  live: 12000,
  "7d": 18000,
  "30d": 24000,
  "90d": 31000,
  "1y": 38000,
  all: 41000,
};

/** Heading per time slice, also decorative. */
const HEADINGS: Record<TimeSlice, string> = {
  live: "000°",
  "7d": "045°",
  "30d": "090°",
  "90d": "180°",
  "1y": "270°",
  all: "315°",
};

type HudProps = {
  /** The currently selected time slice — drives the altitude + heading readouts. */
  slice: TimeSlice;
};

/**
 * Hud — current time-slice indicator.
 *
 * Pure presentational component. No state, no effects.
 */
export function Hud({ slice }: HudProps) {
  return (
    <div
      data-testid="choropleth-flight-hud"
      className="absolute right-3 top-3 z-[500] bg-gray-950/80 backdrop-blur border border-gray-700 rounded-lg px-3 py-2 text-[10px] text-gray-300 shadow-lg flex items-center gap-2"
    >
      <Compass className="w-4 h-4 text-amber-400" />
      <span className="font-mono">
        ALT {ALTITUDES[slice]}ft · HDG {HEADINGS[slice]}
      </span>
      <span className="ml-1 px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 font-mono">
        WARDS
      </span>
    </div>
  );
}