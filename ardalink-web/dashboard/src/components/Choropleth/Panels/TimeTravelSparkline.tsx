/**
 * TimeTravelSparkline — historical-trend panel. Renders one
 * {@link Sparkline} per ward/county with non-null data.
 *
 * Pure presentational component.
 */
import { Plane } from "lucide-react";
import type { ChoroplethMetric } from "@workspace/api-client-react";
import type { TimeTravelData } from "../hooks";
import { Skeleton } from "../Skeleton";
import { getMetricMeta } from "../utils";
import { Sparkline } from "./Sparkline";

/** The five long time slices shown in the trend panel. */
const SLICES = ["7d", "30d", "90d", "1y", "all"] as const;

type TimeTravelSparklineProps = {
  timeTravel: TimeTravelData;
  metric: ChoroplethMetric;
};

/**
 * TimeTravelSparkline — one Sparkline row per ward/county with data.
 *
 * Picks `series["30d"]` as the index of which wards to render, then
 * pulls the value at every slice in `SLICES` for that ward. Empty state
 * when no ward has data at `30d`.
 */
export function TimeTravelSparkline({ timeTravel, metric }: TimeTravelSparklineProps) {
  const meta = getMetricMeta(metric);
  if (!timeTravel) {
    return (
      <div className="bg-gray-900 p-3 min-h-[180px]">
        <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
          <Plane className="w-3 h-3" />
          Time travel
        </h3>
        <Skeleton />
      </div>
    );
  }
  const wardsWithData = Object.entries(timeTravel.series["30d"] ?? {})
    .filter(([, v]) => v != null)
    .map(([c]) => c);
  if (wardsWithData.length === 0) {
    return (
      <div className="bg-gray-900 p-3 min-h-[180px]">
        <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
          <Plane className="w-3 h-3" />
          Time travel
        </h3>
        <p className="text-[11px] text-gray-500">No data points yet.</p>
      </div>
    );
  }
  return (
    <div
      data-testid="choropleth-time-travel"
      className="bg-gray-900 p-3 min-h-[180px]"
    >
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <Plane className="w-3 h-3" />
        Time travel · {meta.label}
      </h3>
      <div className="space-y-2.5">
        {wardsWithData.map((name) => {
          const values = SLICES.map(
            (s) => timeTravel.series[s]?.[name] ?? null,
          );
          const nums = values.filter((v): v is number => v != null);
          if (!nums.length) return null;
          return (
            <Sparkline key={name} values={values} meta={meta} label={name} />
          );
        })}
      </div>
      <div className="mt-2 pt-2 border-t border-gray-800 flex justify-between text-[9px] text-gray-500 font-mono">
        {SLICES.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
    </div>
  );
}