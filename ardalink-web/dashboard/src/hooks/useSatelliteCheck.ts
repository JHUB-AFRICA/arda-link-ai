import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useTriggerCheck,
  getStatus,
  getGetStatusQueryKey,
  getGetForecastQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

/**
 * Custom hook for handling satellite check triggering with retry/polling logic.
 *
 * Handles:
 * - Triggering satellite checks
 * - 409 conflict handling (when another run is in progress)
 * - Polling for completion when a background run is detected
 * - Toast notifications for success/failure
 */
export function useSatelliteCheck() {
  const [waitingForBackgroundRun, setWaitingForBackgroundRun] = useState(false);
  const triggerCheck = useTriggerCheck();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const checkInFlight = triggerCheck.isPending || waitingForBackgroundRun;

  const handleTriggerCheck = () => {
    triggerCheck.mutate(
      { dryRun: true, forceAlert: false },
      {
        onSuccess: () => {
          toast({ title: "Satellite check complete" });
          queryClient.invalidateQueries({ queryKey: getGetStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
        },
        onError: async (err: Error) => {
          // Surface the real reason instead of a generic "failed" toast.
          // ApiError carries the server's { error: "..." } body in .data.
          const apiErr = err as {
            status?: number;
            data?: { error?: string };
            message?: string;
          };
          const status = apiErr.status;
          const serverMsg =
            (apiErr.data && typeof apiErr.data.error === "string"
              ? apiErr.data.error
              : undefined) ?? apiErr.message;

          // 409 = scheduler (or a previous click) is already running the pipeline.
          // Don't fail — wait for it to finish and refresh the dashboard.
          if (status === 409) {
            toast({
              title: "Satellite run already in progress",
              description: "Waiting for the current run to finish…",
            });
            setWaitingForBackgroundRun(true);
            const startedAt = Date.now();
            try {
              while (Date.now() - startedAt < 90_000) {
                await new Promise((r) => setTimeout(r, 2000));
                try {
                  const s = await getStatus();
                  if (!s.is_running) {
                    queryClient.invalidateQueries({
                      queryKey: getGetStatusQueryKey(),
                    });
                    queryClient.invalidateQueries({
                      queryKey: getGetForecastQueryKey(),
                    });
                    toast({ title: "Satellite check complete" });
                    return;
                  }
                } catch {
                  // transient — keep polling
                }
              }
              toast({
                title: "Satellite check timed out",
                description:
                  "The background run is taking longer than usual. Try again in a moment.",
                variant: "destructive",
              });
            } finally {
              setWaitingForBackgroundRun(false);
            }
            return;
          }

          toast({
            title: "Satellite check failed",
            description: serverMsg ?? "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return { handleTriggerCheck, checkInFlight, waitingForBackgroundRun };
}
