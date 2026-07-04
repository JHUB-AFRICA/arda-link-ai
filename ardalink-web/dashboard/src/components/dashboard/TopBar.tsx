import { Satellite, PhoneCall, ExternalLink, Radio, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { riskBadge } from "@/lib/dashboard-colors";
import { UserMenu } from "@/components/UserMenu";
import type { SessionInfo } from "@/components/AuthGate";

interface TopBarProps {
  tab: "map" | "pastoralists" | "groundtruth" | "demos";
  statusData: any;
  forecastData: any;
  handleTriggerCheck: () => void;
  checkInFlight: boolean;
  waitingForBackgroundRun: boolean;
  handleHearTheCall: () => void;
  mintingCall: boolean;
  setCallOpen: (open: boolean) => void;
  refetchStatus: () => void;
  loadingStatus: boolean;
  session?: SessionInfo;
}

/** Top bar with page title, risk badge, and action buttons */
export function TopBar({
  tab,
  statusData,
  forecastData,
  handleTriggerCheck,
  checkInFlight,
  waitingForBackgroundRun,
  handleHearTheCall,
  mintingCall,
  setCallOpen,
  refetchStatus,
  loadingStatus,
  session,
}: TopBarProps) {
  const d = statusData?.last_run as any;
  const f = forecastData as any;

  return (
    <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-gray-800 bg-gray-900/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
      <div className="min-w-0">
        <h1 className="text-base sm:text-lg font-semibold text-white">
          {tab === "map"
            ? "Live Vegetation Intelligence"
            : tab === "pastoralists"
              ? "Herder Registry"
              : tab === "groundtruth"
                ? "Ground Truth Intelligence"
                : "Demo Simulators"}
        </h1>
        <p className="text-xs sm:text-sm text-gray-500">
          {tab === "map" && d
            ? `Last updated: ${new Date(d.timestamp).toLocaleString()}`
            : tab === "pastoralists"
              ? "Manage herders and alerts"
              : tab === "groundtruth"
                ? "Herder voice reports → ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI standards"
                : "Test USSD, SMS, and Voice simulators with live AI"}
        </p>
      </div>
      <div className="flex items-center flex-wrap gap-2 sm:gap-3">
        {f?.forecast?.outlook?.riskLevel && (
          <span
            className={`px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-full text-[10px] sm:text-xs font-semibold border ${riskBadge(
              f.forecast.outlook.riskLevel.toUpperCase(),
            )}`}
          >
            {f.forecast.outlook.riskLevel.toUpperCase()} RISK
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={handleTriggerCheck}
          disabled={checkInFlight}
          className="bg-amber-600/20 border-amber-700/50 text-amber-300 hover:bg-amber-600/30 hover:text-amber-200"
          data-testid="btn-trigger-check"
        >
          {checkInFlight ? (
            <>
              <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" />{" "}
              <span className="hidden sm:inline">
                {waitingForBackgroundRun ? "Waiting…" : "Running…"}
              </span>
            </>
          ) : (
            <>
              <Satellite className="w-4 h-4 sm:mr-2" />{" "}
              <span className="hidden sm:inline">Run satellite check</span>
              <span className="sm:hidden ml-1">Check</span>
            </>
          )}
        </Button>
        <Button
          size="sm"
          onClick={handleHearTheCall}
          disabled={mintingCall}
          className="bg-green-600 hover:bg-green-700 text-white border border-green-500/60 shadow-lg shadow-green-900/40"
          data-testid="btn-hear-the-call"
          aria-label="Hear ArdaLink call you — opens an incoming-call demo in a new tab"
        >
          {mintingCall ? (
            <>
              <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" />{" "}
              <span className="hidden sm:inline">Dialling…</span>
            </>
          ) : (
            <>
              <PhoneCall className="w-4 h-4 sm:mr-2" />{" "}
              <span className="hidden sm:inline">
                Hear ArdaLink call you
              </span>
              <span className="sm:hidden ml-1">Ring me</span>{" "}
              <ExternalLink className="w-3 h-3 ml-1.5 opacity-70 hidden sm:inline" />
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCallOpen(true)}
          className="bg-gray-900 border-gray-700 text-gray-400 hover:text-white hidden md:inline-flex"
          data-testid="btn-open-call"
          aria-label="Open operator call console"
          title="Operator console — in-page WebRTC, AT sandbox, share link"
        >
          <Radio className="w-4 h-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => refetchStatus()}
          disabled={loadingStatus}
          className="bg-gray-900 border-gray-700 text-gray-400 hover:text-white"
          data-testid="btn-refresh"
        >
          <RefreshCw
            className={`w-4 h-4 ${loadingStatus ? "animate-spin" : ""}`}
          />
        </Button>
        {session && <UserMenu session={session} />}
      </div>
    </div>
  );
}
