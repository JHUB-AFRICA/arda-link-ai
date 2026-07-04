import React from "react";

interface KpiCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
}

/** KPI display card with icon and accent color */
export function KpiCard({ label, value, icon, accent }: KpiCardProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-semibold ${accent ?? "text-white"}`}>
        {value}
      </div>
    </div>
  );
}
