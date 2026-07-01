/**
 * Sparkline — single-line mini SVG trend across the five time slices.
 *
 * Pure presentational component.
 */
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { MetricMeta } from "../utils";

type SparklineProps = {
  /** Value per time slice (in order). `null` for missing. */
  values: (number | null)[];
  meta: MetricMeta;
  /** Row label (ward or county name). */
  label: string;
};

const W = 120;
const H = 28;

/**
 * Sparkline — 5-point trend across the five long time slices.
 *
 * Trend direction is computed from first → last non-null value:
 * `up` if delta > 0.5, `down` if < -0.5, else `flat`. The SVG path is
 * drawn directly; no charting library.
 */
export function Sparkline({ values, meta: _meta, label }: SparklineProps) {
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * W;
    const y = v == null ? null : H - ((v - min) / range) * (H - 4) - 2;
    return { x, y, v };
  });
  const path = points
    .filter((p) => p.y != null)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y!.toFixed(1)}`)
    .join(" ");
  const first = nums[0]!;
  const last = nums[nums.length - 1]!;
  const delta = last - first;
  const Trend = delta > 0.5 ? TrendingUp : delta < -0.5 ? TrendingDown : Minus;
  const trendColor = delta > 0.5 ? "#22c55e" : delta < -0.5 ? "#ef4444" : "#9ca3af";
  const trendLabel = delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat";
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-[10px] font-mono text-gray-400 truncate">
        {label}
      </span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="flex-1 h-7"
        aria-label={`${label} trend across time slices`}
      >
        <path
          d={path}
          fill="none"
          stroke={trendColor}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) =>
          p.y == null ? null : (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={1.6}
              fill={trendColor}
              opacity={i === points.length - 1 ? 1 : 0.5}
            />
          ),
        )}
      </svg>
      <span
        className="w-12 text-[10px] font-mono text-right flex items-center justify-end gap-1"
        style={{ color: trendColor }}
      >
        <Trend className="w-3 h-3" />
        {trendLabel}
      </span>
    </div>
  );
}