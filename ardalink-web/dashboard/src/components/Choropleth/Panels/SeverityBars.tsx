/**
 * SeverityBars — ranked horizontal-bar list of the worst wards
 * (or counties, when the API returns them).
 *
 * Pure presentational component.
 */
import { TrendingUp } from "lucide-react";
import type { ChoroplethMetric } from "@workspace/api-client-react";
import { Skeleton } from "../Skeleton";
import type { RankingRow } from "../hooks";
import { getMetricMeta, valueColor } from "../utils";

type SeverityBarsProps = {
  rows: RankingRow[];
  metric: ChoroplethMetric;
};

/**
 * SeverityBars — horizontal-bar ranking.
 *
 * Bar width is the normalised value (0..1) so the worst item always
 * fills the row. Bar colour comes from the active metric's scale.
 */
export function SeverityBars({ rows, metric }: SeverityBarsProps) {
  const meta = getMetricMeta(metric);
  return (
    <div
      data-testid="choropleth-severity"
      className="bg-gray-900 p-3 min-h-[180px]"
    >
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <TrendingUp className="w-3 h-3" />
        Severity ranking
      </h3>
      {rows.length === 0 ? (
        <Skeleton />
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.county} className="flex items-center gap-2">
              <span className="w-16 text-[10px] font-mono text-gray-400 truncate">
                {r.county}
              </span>
              <div className="flex-1 h-2 bg-gray-800 rounded-sm overflow-hidden">
                <div
                  className="h-full transition-all duration-700 ease-out"
                  style={{
                    width: `${Math.max(2, r.normalised * 100)}%`,
                    background:
                      r.value == null
                        ? "#374151"
                        : valueColor(r.value, meta),
                  }}
                />
              </div>
              <span className="w-10 text-[10px] font-mono text-right text-gray-300">
                {r.value == null ? "—" : `#${r.rank}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}