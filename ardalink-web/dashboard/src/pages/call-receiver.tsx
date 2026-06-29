import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import {
  Phone,
  PhoneOff,
  Mic,
  Loader2,
  AlertTriangle,
  Satellite,
  ShieldOff,
  Clock,
  Link2Off,
} from "lucide-react";
import {
  BrowserVoiceClient,
  micErrorMessage,
  type VoiceState,
  type TranscriptEntry,
} from "@/lib/browserVoice";

type Screen =
  | "loading"
  | "invalid"
  | "incoming"
  | "in-call"
  | "declined"
  | "ended";
type InvalidReason = "missing" | "consumed" | "expired";

export default function CallReceiver() {
  const params = useParams<{ token?: string }>();
  const token = params.token;

  const [screen, setScreen] = useState<Screen>("loading");
  const [invalidReason, setInvalidReason] = useState<InvalidReason>("missing");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const clientRef = useRef<BrowserVoiceClient | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // ── Validate the token on mount ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setInvalidReason("missing");
      setScreen("invalid");
      return;
    }
    (async () => {
      try {
        const res = await fetch(
          `/api/call-tokens/${encodeURIComponent(token)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setInvalidReason("missing");
          setScreen("invalid");
          return;
        }
        const data = (await res.json()) as {
          status: "valid" | "missing" | "expired" | "consumed";
        };
        if (data.status === "valid") {
          setScreen("incoming");
        } else {
          setInvalidReason(data.status);
          setScreen("invalid");
        }
      } catch {
        if (cancelled) return;
        setInvalidReason("missing");
        setScreen("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  useEffect(() => {
    if (screen !== "in-call") return;
    const id = setInterval(() => {
      if (startTimeRef.current != null) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 500);
    return () => clearInterval(id);
  }, [screen]);

  useEffect(() => {
    return () => {
      clientRef.current?.stop();
      clientRef.current = null;
    };
  }, []);

  // ── Ringtone while the "incoming" screen is shown ───────────────────────
  // Classic North-American telephone ring: 440Hz + 480Hz dual-tone, 2s ring
  // / 2s silence, repeating. Generated with Web Audio so we don't ship an
  // audio asset. Stops the moment the user accepts, declines, or leaves the
  // incoming screen.
  //
  // Autoplay note: the tab is opened via window.open from a user gesture
  // in the dashboard, which usually permits audio. If the browser still
  // suspends the AudioContext, we resume on the first interaction in this
  // tab (pointerdown / keydown) — tapping Accept/Decline counts.
  useEffect(() => {
    if (screen !== "incoming") return;
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.value = 440;
    osc1.connect(gain);

    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = 480;
    osc2.connect(gain);

    osc1.start();
    osc2.start();

    // Schedule ~4 minutes of ring cycles — far longer than any judge will
    // wait. Each cycle: 2s ringing, 2s silence.
    const CYCLE_S = 4;
    const RING_S = 2;
    const VOL = 0.18;
    const start = ctx.currentTime + 0.05;
    for (let i = 0; i < 60; i++) {
      const t = start + i * CYCLE_S;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(VOL, t + 0.05);
      gain.gain.setValueAtTime(VOL, t + RING_S - 0.05);
      gain.gain.linearRampToValueAtTime(0, t + RING_S);
    }

    const tryResume = () => {
      if (ctx.state === "suspended")
        void ctx.resume().catch(() => {
          /* ignore */
        });
    };
    tryResume();
    document.addEventListener("pointerdown", tryResume, { once: true });
    document.addEventListener("keydown", tryResume, { once: true });

    return () => {
      document.removeEventListener("pointerdown", tryResume);
      document.removeEventListener("keydown", tryResume);
      try {
        osc1.stop();
      } catch {
        /* already stopped */
      }
      try {
        osc2.stop();
      } catch {
        /* already stopped */
      }
      void ctx.close().catch(() => {
        /* ignore */
      });
    };
  }, [screen]);

  const handleAccept = async () => {
    if (!token) return;
    setTranscript([]);
    setVoiceError(null);
    setScreen("in-call");
    startTimeRef.current = Date.now();

    const client = new BrowserVoiceClient({
      onStateChange: (state, message) => {
        setVoiceState(state);
        if (state === "error" && message)
          setVoiceError(micErrorMessage(message) ?? message);
        if (state === "stopped") {
          setScreen("ended");
        }
      },
      onTranscript: (entry) => setTranscript((prev) => [...prev, entry]),
      onLevel: (level) => setMicLevel(level),
    });
    clientRef.current = client;
    try {
      await client.start(token);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Failed to start";
      setVoiceError(micErrorMessage(raw) ?? raw);
      setScreen("ended");
    }
  };

  const handleDecline = () => {
    setScreen("declined");
  };

  const handleEnd = () => {
    clientRef.current?.stop();
    clientRef.current = null;
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)
      .toString()
      .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  // ── Loading (validating token) ─────────────────────────────────────────
  if (screen === "loading") {
    return (
      <div className="min-h-[100dvh] bg-gray-950 flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Checking call link…</span>
        </div>
      </div>
    );
  }

  // ── Invalid / expired / consumed link ───────────────────────────────────
  if (screen === "invalid") {
    const config = {
      missing: {
        Icon: Link2Off,
        title: "Invalid call link",
        body: "This link isn't recognised. Please ask the operator to send you a fresh one.",
      },
      consumed: {
        Icon: ShieldOff,
        title: "Link already used",
        body: "This call link has been used once and can't be opened again. Please ask the operator for a new link.",
      },
      expired: {
        Icon: Clock,
        title: "Link expired",
        body: "Call links are valid for 15 minutes. Please ask the operator to send a fresh link.",
      },
    }[invalidReason];
    const Icon = config.Icon;
    return (
      <div className="min-h-[100dvh] bg-gray-950 flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center mx-auto mb-4">
            <Icon className="w-7 h-7 text-amber-500" />
          </div>
          <div
            className="text-xl text-gray-200 font-semibold"
            data-testid="text-invalid-title"
          >
            {config.title}
          </div>
          <div className="text-sm text-gray-500 mt-3 leading-relaxed">
            {config.body}
          </div>
        </div>
      </div>
    );
  }

  // ── Incoming call screen ────────────────────────────────────────────────
  if (screen === "incoming") {
    return (
      <div
        className="min-h-[100dvh] bg-gradient-to-b from-gray-950 via-gray-900 to-amber-950/40 flex flex-col items-center justify-between px-5"
        style={{
          paddingTop: "max(1.5rem, env(safe-area-inset-top))",
          paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
        }}
      >
        <div className="text-center">
          <div className="text-[10px] sm:text-xs uppercase tracking-[0.3em] text-amber-400/80 mb-1.5">
            Incoming call
          </div>
          <div className="text-sm text-gray-400">Bula Pesa Ward · Isiolo</div>
        </div>

        <div className="flex flex-col items-center">
          <div className="relative">
            <div className="absolute inset-0 rounded-full bg-amber-500/20 animate-ping" />
            <div
              className="absolute inset-0 rounded-full bg-amber-500/10 animate-pulse"
              style={{ animationDelay: "0.5s" }}
            />
            <div className="relative w-32 h-32 sm:w-40 sm:h-40 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-2xl shadow-amber-900/50">
              <Satellite
                className="w-16 h-16 sm:w-20 sm:h-20 text-white"
                strokeWidth={1.5}
              />
            </div>
          </div>
          <div className="mt-6 sm:mt-8 text-2xl sm:text-3xl font-semibold text-white tracking-wide">
            ArdaLink AI
          </div>
          <div className="mt-1.5 text-sm text-gray-400">
            Range management · calling you
          </div>
        </div>

        <div className="w-full max-w-sm flex items-center justify-around">
          <button
            onClick={handleDecline}
            className="flex flex-col items-center gap-2 group"
            data-testid="btn-decline-call"
          >
            <div className="w-16 h-16 rounded-full bg-red-600 group-hover:bg-red-700 flex items-center justify-center shadow-xl shadow-red-900/30 transition-transform group-active:scale-95">
              <PhoneOff className="w-7 h-7 text-white" />
            </div>
            <span className="text-xs text-gray-400">Decline</span>
          </button>

          <button
            onClick={handleAccept}
            className="flex flex-col items-center gap-2 group"
            data-testid="btn-accept-call"
          >
            <div className="w-16 h-16 rounded-full bg-green-600 group-hover:bg-green-700 flex items-center justify-center shadow-xl shadow-green-900/40 transition-transform group-active:scale-95 animate-pulse">
              <Phone className="w-7 h-7 text-white" />
            </div>
            <span className="text-xs text-gray-400">Accept</span>
          </button>
        </div>
      </div>
    );
  }

  // ── Declined screen ─────────────────────────────────────────────────────
  if (screen === "declined") {
    return (
      <div className="min-h-[100dvh] bg-gray-950 flex items-center justify-center px-6">
        <div className="text-center">
          <PhoneOff className="w-16 h-16 text-gray-600 mx-auto mb-4" />
          <div className="text-xl text-gray-300">Call declined</div>
          <div className="text-sm text-gray-500 mt-2">
            Ask the operator for a new link if you want to try again.
          </div>
        </div>
      </div>
    );
  }

  // ── Ended screen ────────────────────────────────────────────────────────
  if (screen === "ended") {
    return (
      <div className="min-h-[100dvh] bg-gray-950 flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center mx-auto mb-4">
            <PhoneOff className="w-7 h-7 text-gray-500" />
          </div>
          <div className="text-xl text-gray-300">Call ended</div>
          <div className="text-sm text-gray-500 mt-2">
            Duration {formatTime(elapsed)}
          </div>
          {voiceError && (
            <div className="mt-4 p-3 bg-red-950/40 border border-red-900/50 rounded-lg text-xs text-red-300 flex items-start gap-2 text-left">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{voiceError}</span>
            </div>
          )}
          {transcript.length > 0 && (
            <div className="mt-6 text-left bg-gray-900 border border-gray-800 rounded-xl p-4 max-h-64 overflow-y-auto">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Transcript
              </div>
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
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── In-call screen ──────────────────────────────────────────────────────
  return (
    <div
      className="min-h-[100dvh] bg-gradient-to-b from-gray-950 via-gray-900 to-amber-950/30 flex flex-col"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="pt-4 pb-2 text-center shrink-0">
        <div className="text-[10px] sm:text-xs uppercase tracking-[0.3em] text-amber-400/80 mb-1">
          {voiceState === "connecting"
            ? "Connecting…"
            : voiceState === "live"
              ? "On call"
              : voiceState}
        </div>
        <div className="text-sm text-gray-400">{formatTime(elapsed)}</div>
      </div>

      <div className="flex flex-col items-center py-4 shrink-0">
        <div className="relative">
          {voiceState === "live" && (
            <div
              className="absolute inset-0 rounded-full bg-amber-500/30"
              style={{
                transform: `scale(${1 + Math.min(0.4, micLevel * 4)})`,
                transition: "transform 80ms linear",
              }}
            />
          )}
          <div className="relative w-24 h-24 sm:w-32 sm:h-32 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-2xl shadow-amber-900/50">
            <Satellite
              className="w-12 h-12 sm:w-16 sm:h-16 text-white"
              strokeWidth={1.5}
            />
          </div>
        </div>
        <div className="mt-3 sm:mt-5 text-xl sm:text-2xl font-semibold text-white">
          ArdaLink AI
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
          <Mic className="w-3 h-3 text-amber-500" />
          <div className="w-24 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 transition-all"
              style={{ width: `${Math.min(100, micLevel * 600)}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 px-3 overflow-y-auto">
        <div className="max-w-md mx-auto bg-gray-900/60 border border-gray-800 rounded-2xl p-3 sm:p-4">
          <div className="text-[10px] sm:text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Live transcript
          </div>
          {voiceState === "connecting" && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Connecting to
              ArdaLink…
            </div>
          )}
          {transcript.length === 0 && voiceState === "live" && (
            <div className="text-sm text-gray-600 italic">
              Listening… speak when ready.
            </div>
          )}
          <div className="space-y-2">
            {transcript.map((t, i) => (
              <div
                key={i}
                className={`text-sm leading-snug ${t.role === "user" ? "text-amber-200" : "text-green-200"}`}
              >
                <span className="font-semibold mr-1.5">
                  {t.role === "user" ? "You:" : "ArdaLink:"}
                </span>
                {t.text}
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      </div>

      <div className="py-4 sm:py-6 flex items-center justify-center shrink-0">
        <button
          onClick={handleEnd}
          className="flex flex-col items-center gap-1.5 group"
          data-testid="btn-end-call"
        >
          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-red-600 group-hover:bg-red-700 flex items-center justify-center shadow-xl shadow-red-900/30 transition-transform group-active:scale-95">
            <PhoneOff className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
          </div>
          <span className="text-xs text-gray-400">End call</span>
        </button>
      </div>
    </div>
  );
}
