/**
 * InsightsPanel — narrative bullet list + active-alert badge.
 *
 * Pure presentational component.
 */
import { Sparkles, ChevronRight } from "lucide-react";
import type { AlertMarker } from "../hooks";
import { Skeleton } from "../Skeleton";

type InsightsPanelProps = {
  insights: { bullets: string[]; generatedAt: string } | null;
  alerts: { count: number; markers: AlertMarker[] } | null;
};

/**
 * InsightsPanel — auto-generated narrative for the active slice.
 *
 * Header shows the bullet count + an active-alert pill when `alerts.count`
 * is non-zero. Footer shows the generation timestamp in locale time.
 */
export function InsightsPanel({ insights, alerts }: InsightsPanelProps) {
  return (
    <div
      data-testid="choropleth-insights"
      className="bg-gray-900 p-3 min-h-[180px]"
    >
      <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" />
        Live interpretation
        {alerts && alerts.count > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-red-300">
            <span
              aria-hidden
              className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"
            />
            {alerts.count} active alert{alerts.count === 1 ? "" : "s"}
          </span>
        )}
      </h3>
      {!insights ? (
        <Skeleton />
      ) : (
        <ul className="space-y-1.5 text-[11px] text-gray-200 leading-snug">
          {insights.bullets.map((b, i) => (
            <li key={i} className="flex gap-1.5">
              <ChevronRight className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
      {insights && (
        <p className="mt-2 pt-2 border-t border-gray-800 text-[9px] text-gray-500 font-mono">
          computed {new Date(insights.generatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}