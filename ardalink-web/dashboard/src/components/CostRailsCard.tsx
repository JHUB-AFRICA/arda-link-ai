import { useEffect, useState, useCallback } from "react";
import { Shield, ShieldOff, AlertTriangle, RefreshCw } from "lucide-react";

interface PublicTalkStatus {
  enabled: boolean;
  dailyBudgetMinutes: number;
  usedMinutesToday: number;
  remainingMinutes: number;
  callsToday: number;
  resetsAt: number;
  day: string;
}

export function CostRailsCard() {
  const [status, setStatus] = useState<PublicTalkStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/public-talk/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as PublicTalkStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const toggle = async () => {
    if (!status || loading) return;
    const next = !status.enabled;
    const confirmed = window.confirm(
      next
        ? "Re-enable public ArdaLink calls? Pastoralists will be able to call again."
        : "Pause ALL public ArdaLink calls? Existing in-flight calls finish; new calls are blocked until you re-enable. Use this if you spot abuse or want to stop spend immediately.",
    );
    if (!confirmed) return;
    setLoading(true);
    try {
      const res = await fetch("/api/public-talk/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as PublicTalkStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (!status) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-sm text-gray-500">
        {error ? `Cost rails unavailable: ${error}` : "Loading cost rails…"}
      </div>
    );
  }

  const pct = Math.min(
    100,
    (status.usedMinutesToday / status.dailyBudgetMinutes) * 100,
  );
  const barColor =
    pct >= 100 ? "bg-red-500" : pct >= 75 ? "bg-orange-400" : "bg-emerald-400";
  const resetsAt = new Date(status.resetsAt);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          {status.enabled ? (
            <Shield className="w-4 h-4 text-emerald-400" />
          ) : (
            <ShieldOff className="w-4 h-4 text-red-400" />
          )}
          Public talk · cost rails
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
          aria-label="Refresh"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      <div>
        <div className="flex items-baseline justify-between text-xs text-gray-400 mb-1">
          <span>
            <span className="text-white font-semibold">
              {status.usedMinutesToday.toFixed(1)}
            </span>{" "}
            / {status.dailyBudgetMinutes} call-minutes used today
          </span>
          <span>{status.callsToday} calls</span>
        </div>
        <div className="h-2 w-full rounded-full bg-gray-800 overflow-hidden">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-[11px] text-gray-500 mt-1">
          Resets at {resetsAt.toLocaleTimeString()} (
          {resetsAt.toLocaleDateString()} UTC midnight)
        </div>
      </div>

      {pct >= 100 && (
        <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950/40 border border-red-900/50 rounded-lg p-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Daily budget reached — public calls are auto-paused until UTC
            midnight.
          </span>
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-gray-800">
        <div className="text-xs">
          <div className="text-gray-400">Kill switch</div>
          <div
            className={
              status.enabled
                ? "text-emerald-400 font-medium"
                : "text-red-400 font-medium"
            }
          >
            {status.enabled ? "Public calls ACTIVE" : "Public calls PAUSED"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={loading}
          className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors disabled:opacity-50 ${
            status.enabled
              ? "bg-red-600 hover:bg-red-500 text-white"
              : "bg-emerald-600 hover:bg-emerald-500 text-white"
          }`}
        >
          {loading ? "…" : status.enabled ? "Pause" : "Resume"}
        </button>
      </div>

      {error && <div className="text-xs text-red-400">Error: {error}</div>}
    </div>
  );
}
