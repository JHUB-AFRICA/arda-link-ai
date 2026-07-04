/**
 * Dashboard color and styling utilities
 * Extracted from dashboard.tsx for reusability
 */

/** Returns color scheme based on vegetation stress percentage */
export function stressColor(pct: number) {
  if (pct < 25) return { fill: "#166534", stroke: "#22c55e", text: "#4ade80" };
  if (pct < 40) return { fill: "#713f12", stroke: "#eab308", text: "#fde047" };
  if (pct < 55) return { fill: "#7c2d12", stroke: "#f97316", text: "#fb923c" };
  return { fill: "#7f1d1d", stroke: "#ef4444", text: "#f87171" };
}

/** Returns badge styling for risk levels */
export function riskBadge(level: string) {
  const map: Record<string, string> = {
    LOW: "bg-green-900 text-green-300 border-green-700",
    MODERATE: "bg-yellow-900 text-yellow-300 border-yellow-700",
    HIGH: "bg-orange-900 text-orange-300 border-orange-700",
    CRITICAL: "bg-red-900 text-red-300 border-red-700",
  };
  return map[level] ?? "bg-gray-800 text-gray-300 border-gray-600";
}

/** Returns bar color for Body Condition Score (BCS) charts */
export function bcsBarColor(score: number | null): string {
  if (score == null) return "#374151";
  if (score <= 2) return "#ef4444";
  if (score < 3) return "#f97316";
  if (score < 4) return "#eab308";
  return "#22c55e";
}
