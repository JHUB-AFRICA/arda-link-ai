import { useState, useEffect, useRef } from "react";
import {
  Phone,
  PhoneOff,
  Mic,
  Loader2,
  Radio,
  AlertTriangle,
  Globe,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  useTriggerCheck,
  getGetStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  BrowserVoiceClient,
  micErrorMessage,
  type VoiceState,
  type TranscriptEntry,
} from "@/lib/browserVoice";
import { ShareCallLinkButton } from "@/components/ShareCallLinkButton";

export function CallModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // --- AT Sandbox ---
  const [phone, setPhone] = useState("+254711XXXXXX");
  const triggerCheck = useTriggerCheck();
  const handleSandboxCall = () => {
    if (!phone.trim() || phone.includes("X")) {
      toast({ title: "Enter a real phone number", variant: "destructive" });
      return;
    }
    triggerCheck.mutate(
      { data: { phone: phone.trim(), forceAlert: true } },
      {
        onSuccess: (res) => {
          toast({
            title: res.triggered
              ? "Call placed via Africa's Talking sandbox"
              : "Satellite check ran (no alert)",
            description: res.triggered
              ? "Open the AT simulator to answer the call."
              : "No alert was triggered — vegetation is healthy.",
          });
          queryClient.invalidateQueries({ queryKey: getGetStatusQueryKey() });
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : "Call failed";
          toast({
            title: "AT call failed",
            description: message,
            variant: "destructive",
          });
        },
      },
    );
  };

  // --- Browser WebRTC ---
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const clientRef = useRef<BrowserVoiceClient | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  useEffect(() => {
    if (!open) {
      clientRef.current?.stop();
      clientRef.current = null;
      setVoiceState("idle");
      setVoiceError(null);
      setTranscript([]);
      setMicLevel(0);
    }
  }, [open]);

  const handleStartBrowserCall = async () => {
    setTranscript([]);
    setVoiceError(null);
    const client = new BrowserVoiceClient({
      onStateChange: (state, message) => {
        setVoiceState(state);
        if (state === "error" && message)
          setVoiceError(micErrorMessage(message) ?? message);
      },
      onTranscript: (entry) => setTranscript((prev) => [...prev, entry]),
      onLevel: (level) => setMicLevel(level),
    });
    clientRef.current = client;
    try {
      // Mint a one-shot token for the operator's own call so we can enforce
      // single-use on the WS upgrade uniformly across operator + recipient.
      const res = await fetch("/api/call-tokens", { method: "POST" });
      if (!res.ok) throw new Error(`Token mint failed: HTTP ${res.status}`);
      const { token } = (await res.json()) as { token: string };
      await client.start(token);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Failed to start";
      const message = micErrorMessage(raw) ?? raw;
      toast({
        title: "Could not start live call",
        description: message,
        variant: "destructive",
      });
    }
  };

  const handleStopBrowserCall = () => {
    clientRef.current?.stop();
    clientRef.current = null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-gray-950 border-gray-800 text-gray-100 max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Phone className="w-5 h-5 text-amber-500" /> Operator call console
          </DialogTitle>
          <DialogDescription className="text-gray-400">
            For the judge demo, use{" "}
            <span className="text-amber-300 font-medium">
              “Hear ArdaLink call you”
            </span>{" "}
            on the top bar — it opens the full incoming-call screen. This
            console is for operators: in-page WebRTC, AT sandbox to a real
            Kenyan number, and shareable call links.
          </DialogDescription>
          <div className="pt-2">
            <ShareCallLinkButton />
          </div>
        </DialogHeader>

        <Tabs defaultValue="browser" className="mt-2">
          <TabsList className="grid w-full grid-cols-2 bg-gray-900 border border-gray-800">
            <TabsTrigger
              value="browser"
              data-testid="tab-browser-call"
              className="data-[state=active]:bg-amber-600/20 data-[state=active]:text-amber-300"
            >
              <Globe className="w-4 h-4 mr-2" /> Browser Live (WebRTC)
            </TabsTrigger>
            <TabsTrigger
              value="sandbox"
              data-testid="tab-at-sandbox"
              className="data-[state=active]:bg-amber-600/20 data-[state=active]:text-amber-300"
            >
              <Radio className="w-4 h-4 mr-2" /> Africa's Talking Sandbox
            </TabsTrigger>
          </TabsList>

          {/* === Browser Live Tab === */}
          <TabsContent value="browser" className="mt-4 space-y-4">
            <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
              <div className="text-sm text-gray-400 mb-3">
                Talk to ArdaLink right here in this dialog. Same Realtime model
                the herder hears on their 2G phone — your mic streams to Azure
                OpenAI and you hear the AI back. No phone, no SIM, no app.
              </div>

              <div className="flex items-center gap-3 mb-4">
                <div
                  className={`w-3 h-3 rounded-full ${
                    voiceState === "live"
                      ? "bg-green-400 animate-pulse"
                      : voiceState === "connecting"
                        ? "bg-amber-400 animate-pulse"
                        : voiceState === "error"
                          ? "bg-red-500"
                          : "bg-gray-600"
                  }`}
                />
                <span className="text-xs uppercase tracking-wider text-gray-400">
                  {voiceState === "live"
                    ? "Live — speak naturally"
                    : voiceState === "connecting"
                      ? "Connecting to Azure Realtime…"
                      : voiceState === "stopped"
                        ? "Call ended"
                        : voiceState === "error"
                          ? `Error: ${voiceError ?? "unknown"}`
                          : "Idle"}
                </span>
                {voiceState === "live" && (
                  <div className="ml-auto flex items-center gap-1.5">
                    <Mic className="w-3.5 h-3.5 text-amber-500" />
                    <div className="w-24 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-500 transition-all"
                        style={{ width: `${Math.min(100, micLevel * 600)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                {voiceState === "idle" ||
                voiceState === "stopped" ||
                voiceState === "error" ? (
                  <Button
                    onClick={handleStartBrowserCall}
                    className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
                    data-testid="btn-start-browser-call"
                  >
                    <Phone className="w-4 h-4 mr-2" /> Start live conversation
                  </Button>
                ) : voiceState === "connecting" ? (
                  <Button disabled className="flex-1 bg-amber-700 text-white">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />{" "}
                    Connecting…
                  </Button>
                ) : (
                  <Button
                    onClick={handleStopBrowserCall}
                    variant="destructive"
                    className="flex-1"
                    data-testid="btn-stop-browser-call"
                  >
                    <PhoneOff className="w-4 h-4 mr-2" /> End call
                  </Button>
                )}
              </div>

              {voiceError && (
                <div className="mt-3 p-2 bg-red-950/40 border border-red-900/50 rounded-lg text-xs text-red-300 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{voiceError}</span>
                </div>
              )}
            </div>

            {(transcript.length > 0 || voiceState === "live") && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 max-h-64 overflow-y-auto">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  Live transcript
                </div>
                {transcript.length === 0 ? (
                  <div className="text-sm text-gray-600 italic">
                    Listening… speak when ready.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {transcript.map((t, i) => (
                      <div
                        key={i}
                        className={`text-sm ${t.role === "user" ? "text-amber-200" : "text-green-200"}`}
                      >
                        <span className="font-semibold mr-2">
                          {t.role === "user" ? "You:" : "ArdaLink:"}
                        </span>
                        {t.text}
                      </div>
                    ))}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          {/* === AT Sandbox Tab === */}
          <TabsContent value="sandbox" className="mt-4 space-y-4">
            <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
              <div className="text-sm text-gray-400 mb-3">
                Place a real outbound call through Africa's Talking sandbox.
                Open the AT simulator at{" "}
                <a
                  href="https://simulator.africastalking.com"
                  target="_blank"
                  rel="noreferrer"
                  className="text-amber-400 hover:underline"
                >
                  simulator.africastalking.com
                </a>{" "}
                with the same number to answer it.
              </div>

              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 block">
                Phone number
              </label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+254711XXXXXX"
                className="bg-gray-950 border-gray-700 text-white mb-3"
                data-testid="input-sandbox-phone"
              />

              <Button
                onClick={handleSandboxCall}
                disabled={triggerCheck.isPending}
                className="w-full bg-amber-600 hover:bg-amber-700 text-white"
                data-testid="btn-sandbox-call"
              >
                {triggerCheck.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running
                    full pipeline…
                  </>
                ) : (
                  <>
                    <Phone className="w-4 h-4 mr-2" /> Place sandbox call
                  </>
                )}
              </Button>
            </div>

            <div className="text-xs text-gray-500 leading-relaxed px-1">
              This runs the full intelligence cycle: live Sentinel-2 fetch →
              Cosmos baseline → GPT-4o script → outbound call. The AI conducts a
              Swahili/English conversation, transcribes it, and saves it to
              PostgreSQL as ground truth.
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
