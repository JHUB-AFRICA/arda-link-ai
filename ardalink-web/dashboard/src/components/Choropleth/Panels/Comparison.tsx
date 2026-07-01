/**
 * Comparison — selected-ward-vs-others panel.
 *
 * Renders all 10 Isiolo wards with their value on the active metric.
 * The selected ward is highlighted; non-selected wards are dimmed.
 *
 * Pure presentational component.
 */
import { Activity } from "lucide-react";
import type { ChoroplethMetric, TimeSlice } from "@workspace/api-client-react";
import type { WardAggregates } from "../hooks";
import { Skeleton } from "../Skeleton";
import { formatValue, getMetricMeta, valueColor } from "../utils";

type ComparisonProps = {
  /** Active metric on the choropleth. */
  metric: ChoroplethMetric;
  /** Active time slice. */
  slice: TimeSlice;
  /** Ward aggregate payload (byWard + unit). */
  wardAggregates: WardAggregates;
  /** Ward presets from the API (used for display name + home-ward marker). */
  wardPresets: Array<{ name: string; displayName: string; isDemoHome: boolean }>;
  /** Currently selected ward — highlighted in the table. */
  selectedWardId: string | null;
};

/**
 * Comparison — ranked ward table for the active metric.
 *
 * Replaces the previous ward-vs-county view. Always shows the 10 Isiolo
 * wards; the selected ward is bold + amber; non-selected wards are dimmed.
 */
export function Comparison({
  metric,
  slice,
  wardAggregates,
  wardPresets,
  selectedWardId,
}: ComparisonProps) {
  const meta = getMetricMeta(metric);
  const rows = wardPresets.map((w) => ({
    name: w.name,
    displayName: w.displayName,
    value: wardAggregates?.byWard[w.name] ?? null,
    isHome: w.isDemoHome,
    isSelected: w.name === selectedWardId,
  }));
  return (
    <div
      data-testid="choropleth-comparison"
      className="bg-gray-900 p-3 min-h-[180px]"
    >
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <Activity className="w-3 h-3" />
        Wards · {meta.label} · {slice}
      </h3>
      {rows.length === 0 ? (
        <Skeleton />
      ) : (
        <div className="overflow-y-auto max-h-[180px]">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-500 text-[9px] uppercase tracking-wider sticky top-0 bg-gray-900">
                <th className="text-left py-1 pr-2">Name</th>
                <th className="text-right py-1 pl-2">{meta.unit}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.name}
                  className={
                    "border-t border-gray-800 " +
                    (r.isSelected ? "bg-amber-900/20" : "")
                  }
                >
                  <td
                    className={
                      "py-1 pr-2 font-mono truncate " +
                      (r.isSelected ? "text-amber-200" : "text-gray-200")
                    }
                  >
                    {r.displayName}
                    {r.isHome && (
                      <span className="ml-1 text-amber-400" title="Demo home ward">
                        ★
                      </span>
                    )}
                  </td>
                  <td
                    className="py-1 pl-2 text-right font-mono"
                    style={{
                      color:
                        r.value == null ? "#9ca3af" : valueColor(r.value, meta),
                      fontWeight: r.isSelected ? 700 : 600,
                    }}
                  >
                    {r.value == null ? "—" : formatValue(r.value, meta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}