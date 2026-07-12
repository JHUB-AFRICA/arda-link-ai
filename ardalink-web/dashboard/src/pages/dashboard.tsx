import { useState } from "react";
import {
  useGetStatus,
  useGetForecast,
  useListPastoralists,
  useDeletePastoralist,
  getGetStatusQueryKey,
  getListPastoralistsQueryKey,
  getGetForecastQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCallToken } from "@/hooks/useCallToken";
import { useSatelliteCheck } from "@/hooks/useSatelliteCheck";
import { CallModal } from "@/components/CallModal";
import { UserMenu } from "@/components/UserMenu";
import { ChatModal, ChatFloatingButton } from "@/components/ChatModal";
import { GroundTruthSection } from "@/components/dashboard/GroundTruthSection";
import LeadsSection from "@/components/dashboard/LeadsSection";
import CallbackLog from "@/components/dashboard/CallbackLog";
import { MapTab } from "@/components/dashboard/MapTab";
import { PastoralistsTab } from "@/components/dashboard/PastoralistsTab";
import { DemosTab } from "@/components/dashboard/DemosTab";
import { SidebarLayout } from "@/components/dashboard/SidebarLayout";
import { TopBar } from "@/components/dashboard/TopBar";
import { IntelligenceBriefHeader } from "@/components/dashboard/IntelligenceBriefHeader";

// --- Main Dashboard ---
export default function Dashboard({ session }: { session?: import("@/components/AuthGate").SessionInfo }) {
  const [tab, setTab] = useState<
    "map" | "pastoralists" | "groundtruth" | "demos"
  >("map");
  const [navOpen, setNavOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [briefLang, setBriefLang] = useState<"en" | "sw">("en");
  const [briefExpanded, setBriefExpanded] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { handleHearTheCall, mintingCall } = useCallToken();
  const { handleTriggerCheck, checkInFlight, waitingForBackgroundRun } = useSatelliteCheck();

  const {
    data: statusData,
    isLoading: loadingStatus,
    refetch: refetchStatus,
  } = useGetStatus({
    query: {
      refetchInterval: (query: { state: { data?: { is_running?: boolean } } }) => (query.state.data?.is_running ? 5000 : 30000),
      queryKey: getGetStatusQueryKey(),
    },
  });

  const { data: forecastData, isError: forecastError } = useGetForecast({
    query: { retry: false, queryKey: getGetForecastQueryKey() },
  });

  const { data: pastoralistsData, isLoading: loadingPastoralists } =
    useListPastoralists({
      query: { queryKey: getListPastoralistsQueryKey() },
    });

  const deletePastoralist = useDeletePastoralist();

  const handleDeletePastoralist = (id: number) => {
    deletePastoralist.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Pastoralist removed" });
          queryClient.invalidateQueries({
            queryKey: getListPastoralistsQueryKey(),
          });
        },
        onError: () => {
          toast({
            title: "Failed to remove pastoralist",
            variant: "destructive",
          });
        },
      },
    );
  };

  const d = statusData?.last_run as any;
  const f = forecastData as any;

const navigate = (next: "map" | "pastoralists" | "groundtruth" | "demos") => {
    setTab(next);
    setNavOpen(false);
  };

  return (
    <div className="flex flex-col md:flex-row min-h-screen w-full bg-gray-950 text-gray-100 font-sans">
      <SidebarLayout
        tab={tab}
        statusData={statusData}
        onNavigate={navigate}
        navOpen={navOpen}
        setNavOpen={setNavOpen}
      />

      {/* --- Main Content --- */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          tab={tab}
          statusData={statusData}
          forecastData={forecastData}
          handleTriggerCheck={handleTriggerCheck}
          checkInFlight={checkInFlight}
          waitingForBackgroundRun={waitingForBackgroundRun}
          handleHearTheCall={handleHearTheCall}
          mintingCall={mintingCall}
          setCallOpen={setCallOpen}
          refetchStatus={refetchStatus}
          loadingStatus={loadingStatus}
          session={session}
        />
        <CallModal open={callOpen} onOpenChange={setCallOpen} />
        <ChatModal open={chatOpen} onOpenChange={setChatOpen} />

        {/* --- AI Intelligence Brief --- */}
        <IntelligenceBriefHeader
          briefExpanded={briefExpanded}
          setBriefExpanded={setBriefExpanded}
          briefLang={briefLang}
          setBriefLang={setBriefLang}
        />

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* --- Tab: Map --- */}
          {tab === "map" && (
            <MapTab
              loadingStatus={loadingStatus}
              statusData={statusData}
              forecastData={forecastData}
              pastoralistsData={pastoralistsData ?? []}
              handleTriggerCheck={handleTriggerCheck}
              checkInFlight={checkInFlight}
              waitingForBackgroundRun={waitingForBackgroundRun}
            />
          )}

          {/* --- Tab: Pastoralists --- */}
          {tab === "pastoralists" && (
            <PastoralistsTab
              pastoralistsData={pastoralistsData}
              loadingPastoralists={loadingPastoralists}
              handleDeletePastoralist={handleDeletePastoralist}
            />
          )}

          {/* --- Tab: Ground Truth Intelligence — leads + callback log + reports --- */}
          {tab === "groundtruth" && (
            <div className="flex-1 space-y-6 overflow-y-auto p-4">
              <LeadsSection />
              <CallbackLog />
              <GroundTruthSection />
            </div>
          )}

          {/* --- Tab: Demo Simulators --- */}
          {tab === "demos" && <DemosTab />}
        </div>
      </div>
      <ChatFloatingButton onClick={() => setChatOpen(true)} />
    </div>
  );
}
