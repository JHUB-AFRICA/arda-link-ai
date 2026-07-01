/**
 * Legend — bottom-left overlay that shows the colour scale for the
 * active metric, plus the currently selected ward's value if any.
 *
 * Pure presentational component. No state, no effects.
 */
import { ChevronRight } from "lucide-react";
import type { ChoroplethMetric } from "@workspace/api-client-react";
import { buildStops, formatValue, getMetricMeta } from "./utils";

type LegendProps = {
  /** Active metric — drives both the colour stops and the unit suffix. */
  metric: ChoroplethMetric;
  /** Selected ward's value on the active metric, or null when none is selected. */
  selectedWardValue: number | null;
  /** Display name for the selected ward (used in the trailing row). */
  selectedWardName: string | null;
};

/**
 * Legend — colour scale + selected-ward readout for the active metric.
 */
export function Legend({ metric, selectedWardValue, selectedWardName }: LegendProps) {
  const meta = getMetricMeta(metric);
  const stops = buildStops(meta);
  return (
    <div
      data-testid="choropleth-legend"
      className="absolute left-3 bottom-12 z-[500] bg-gray-950/85 backdrop-blur border border-gray-700 rounded-lg p-2.5 text-[10px] text-gray-300 shadow-lg max-w-[220px]"
    >
      <div className="text-[9px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">
        {meta.label} · {meta.unit}
      </div>
      <div className="space-y-1">
        {stops.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5">
            <span
              className="w-4 h-3 rounded-sm border border-gray-700"
              style={{ background: s.color }}
            />
            <span>{s.label}</span>
          </div>
        ))}
      </div>
      {selectedWardValue != null && selectedWardName != null && (
        <div className="mt-2 pt-2 border-t border-gray-800 flex items-center gap-1">
          <ChevronRight className="w-3 h-3 text-amber-400 shrink-0" />
          <span className="font-mono text-amber-300 truncate">
            {selectedWardName}: {formatValue(selectedWardValue, meta)}
          </span>
        </div>
      )}
    </div>
  );
}