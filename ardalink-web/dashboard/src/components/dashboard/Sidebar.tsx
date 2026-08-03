import { Satellite, Users, ClipboardList, Radio, AlertTriangle, Database } from "lucide-react";

interface SidebarProps {
  tab: "map" | "pastoralists" | "groundtruth" | "demos" | "admin";
  statusData: any;
  onNavigate: (next: "map" | "pastoralists" | "groundtruth" | "demos" | "admin") => void;
}

/** Navigation sidebar with system status and alert indicators */
export function Sidebar({ tab, statusData, onNavigate }: SidebarProps) {
  const d = statusData?.last_run as any;

  return (
    <>
      <div className="px-4 py-5 border-b border-gray-800">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shrink-0">
            <Satellite className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-base text-white tracking-wide">
            ArdaLink AI
          </span>
        </div>
        <div className="text-xs text-gray-500 pl-10">
          Bula Pesa Ward · Isiolo
        </div>
      </div>

      <div className="mx-3 mt-4 px-3 py-2 bg-green-900/30 border border-green-800/50 rounded-lg flex items-center gap-2">
        {statusData?.is_running ? (
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-green-400" />
        )}
        <span
          className={`text-xs font-medium ${
            statusData?.is_running ? "text-amber-400" : "text-green-400"
          }`}
        >
          {statusData?.is_running ? "Running Analysis..." : "System Live"}
        </span>
      </div>

      <nav className="flex-1 px-3 py-6 space-y-1">
        <button
          data-testid="nav-map"
          onClick={() => onNavigate("map")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
            tab === "map"
              ? "bg-amber-600/20 text-amber-400 border border-amber-600/30"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
          }`}
        >
          <Satellite className="w-4 h-4" /> Map & Conditions
        </button>
        <button
          data-testid="nav-pastoralists"
          onClick={() => onNavigate("pastoralists")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
            tab === "pastoralists"
              ? "bg-amber-600/20 text-amber-400 border border-amber-600/30"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
          }`}
        >
          <Users className="w-4 h-4" /> Herders
        </button>
        <button
          data-testid="nav-groundtruth"
          onClick={() => onNavigate("groundtruth")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
            tab === "groundtruth"
              ? "bg-amber-600/20 text-amber-400 border border-amber-600/30"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
          }`}
        >
          <ClipboardList className="w-4 h-4" /> Ground Truth
        </button>
        <button
          data-testid="nav-admin"
          onClick={() => onNavigate("admin")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
            tab === "admin"
              ? "bg-amber-600/20 text-amber-400 border border-amber-600/30"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
          }`}
        >
          <Database className="w-4 h-4" /> Data Management
        </button>
        <button
          data-testid="nav-demos"
          onClick={() => onNavigate("demos")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
            tab === "demos"
              ? "bg-purple-600/20 text-purple-400 border border-purple-600/30"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
          }`}
        >
          <Radio className="w-4 h-4" /> Demo Simulators
        </button>
      </nav>

      {d?.triggered && d?.live?.anomaly && (
        <div className="mx-3 mb-6 p-3 bg-red-950/40 border border-red-900/50 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            <span className="text-xs font-semibold text-red-400">Active Alert</span>
          </div>
          <div className="text-xs text-gray-400 leading-relaxed">
            {d.live.anomaly.wardStressedPixelPct?.toFixed(1)}% of ward stressed
            · {d.live.anomaly.worstQuadrant} critical
          </div>
        </div>
      )}
    </>
  );
}
