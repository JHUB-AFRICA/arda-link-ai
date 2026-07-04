import React from "react";

interface MetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | React.ReactNode;
  sub?: string;
  accent?: string;
}

/** Metric display card with icon, label, value, and optional subtitle */
export function MetricCard({ icon, label, value, sub, accent = "text-amber-400" }: MetricCardProps) {
  return (
    <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-3 flex items-start gap-3">
      <div className="text-gray-500 mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-gray-500 mb-0.5">{label}</div>
        <div className={`text-base font-bold font-mono ${accent} leading-tight`}>
          {value}
        </div>
        {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}
