import { useEffect, useRef, useState } from "react";
import {
  BrowserVoiceClient,
  type TranscriptEntry,
  type VoiceState,
} from "@/lib/browserVoice";
import { Ringback } from "@/lib/ringback";
import { normalizePhone, isValidPhone } from "@/lib/phone";
import {
  recordConsent,
  clearConsent,
} from "@/lib/consent";
import ChatPanel from "@/components/ChatPanel";
import EnvPanel from "@/components/EnvPanel";

type ReadyTab = "call" | "chat" | "env";

const PHONE_STORAGE_KEY = "ardalink_talk_phone";

type Step = "phone" | "ready" | "calling" | "ended" | "error";

interface MintResponse {
  token?: string;
  expiresAt?: number;
  error?: string;
  message?: string;
  retryAfterSeconds?: number;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// Map an error code/message coming from the voice client into a clear,
// actionable bilingual message. Returns null when the error isn't a known
// microphone/permission case (caller falls back to a generic message).
function micErrorMessage(raw: string): string | null {
  if (raw.includes("MIC_BLOCKED_IFRAME")) {
    return "Kipaza sauti kimezuiwa kwenye dirisha hili la onyesho. Fungua ukurasa kwenye kichupo chake cha kivinjari (bonyeza 'Open in new tab') kisha jaribu tena. · Microphone is blocked inside this preview window. Open the page in its own browser tab, then try again.";
  }
  if (raw.includes("MIC_DENIED")) {
    return "Tafadhali ruhusu matumizi ya kipaza sauti (microphone) kwa kivinjari chako, kisha jaribu tena. · Please allow microphone access in your browser, then try again.";
  }
  if (raw.includes("MIC_NOT_FOUND")) {
    return "Hakuna kipaza sauti kilichopatikana. Unganisha kipaza sauti au tumia simu yenye maikrofoni. · No microphone found. Connect one or use a device with a mic.";
  }
  if (raw.includes("MIC_UNSUPPORTED")) {
    return "Kivinjari hiki hakiruhusu simu za sauti. Jaribu Chrome au Safari ya hivi karibuni. · This browser can't make voice calls. Try a recent Chrome or Safari.";
  }
  if (raw.includes("MIC_ERROR")) {
    return "Tatizo la kipaza sauti. Angalia ruhusa ya microphone kisha jaribu tena. · Microphone problem. Check mic permissions and try again.";
  }
  return null;
}

export default function Home() {
  const [step, setStep] = useState<Step>("phone");
  const [phoneInput, setPhoneInput] = useState("");
  const [savedPhone, setSavedPhone] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [durationSec, setDurationSec] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [readyTab, setReadyTab] = useState<ReadyTab>("call");

  const clientRef = useRef<BrowserVoiceClient | null>(null);
  const ringbackRef = useRef<Ringback | null>(null);

  const stopRingback = () => {
    ringbackRef.current?.stop();
    ringbackRef.current = null;
  };

  useEffect(() => {
    const saved = localStorage.getItem(PHONE_STORAGE_KEY);
    if (saved) {
      setSavedPhone(saved);
      setPhoneInput(saved);
      setStep("ready");
    }
  }, []);

  useEffect(() => {
    return () => {
      clientRef.current?.stop();
      stopRingback();
    };
  }, []);

  useEffect(() => {
    if (voiceState !== "live" || !callStartedAt) return;
    const id = window.setInterval(() => {
      setDurationSec(Math.floor((Date.now() - callStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [voiceState, callStartedAt]);

  const handleSavePhone = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    if (!isValidPhone(phoneInput)) {
      setErrorMsg(
        "Tafadhali andika namba ya simu kamili. / Please enter a complete phone number.",
      );
      return;
    }
    const normalized = normalizePhone(phoneInput);
    localStorage.setItem(PHONE_STORAGE_KEY, normalized);
    recordConsent();
    setSavedPhone(normalized);
    setStep("ready");
  };

  const handleChangePhone = () => {
    localStorage.removeItem(PHONE_STORAGE_KEY);
    clearConsent();
    setSavedPhone(null);
    setPhoneInput("");
    setStep("phone");
    setTranscript([]);
    setErrorMsg("");
  };

  const handleStartCall = async () => {
    if (!savedPhone || busy) return;
    setBusy(true);
    setErrorMsg("");
    setStatusMsg("Inaita ArdaLink… / Calling ArdaLink…");
    setTranscript([]);
    setMuted(false);
    setDurationSec(0);
    setCallStartedAt(null);
    setStep("calling");

    // Start the ringback immediately on the user gesture so the AudioContext
    // is unlocked on iOS/Safari and the caller hears "ringing" while we mint
    // the token and open the WebSocket.
    const ringback = new Ringback();
    ringback.start();
    ringbackRef.current = ringback;

    try {
      const mintRes = await fetch("/api/call-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: savedPhone }),
      });
      const mint = (await mintRes.json()) as MintResponse;

      if (!mintRes.ok || !mint.token) {
        const errCode = (mint as { error?: string }).error;
        if (mintRes.status === 429 && mint.retryAfterSeconds != null) {
          const minutes = Math.ceil(mint.retryAfterSeconds / 60);
          setErrorMsg(
            `Umeshazungumza na ArdaLink hivi karibuni. Tafadhali jaribu tena baada ya ~${minutes} dakika. / You spoke with ArdaLink recently. Please try again in ~${minutes} minutes.`,
          );
        } else if (errCode === "service_disabled") {
          setErrorMsg(
            "ArdaLink imesimamishwa kwa muda. Tafadhali jaribu tena baadaye. / ArdaLink is temporarily paused. Please try again later.",
          );
        } else if (errCode === "daily_budget_exceeded") {
          setErrorMsg(
            "ArdaLink imefikia kikomo cha simu za leo. Tafadhali jaribu tena kesho. / ArdaLink has reached today's call limit. Please try again tomorrow.",
          );
        } else if (errCode === "phone_daily_limit_reached") {
          const limit = (mint as { limit?: number }).limit ?? 5;
          setErrorMsg(
            `Umeshapiga simu ${limit} leo — hiyo ndiyo idadi ya juu kwa nambari moja kwa siku. Tafadhali jaribu tena kesho. / You've already made ${limit} calls today — that's the daily cap per number. Please try again tomorrow.`,
          );
        } else if (errCode === "unsupported_region") {
          setErrorMsg(
            "ArdaLink kwa sasa inapatikana kwa nambari za Kenya tu (+254). / ArdaLink is currently available only for Kenyan numbers (+254).",
          );
        } else if (errCode === "busy" || errCode === "capacity_reached") {
          setErrorMsg(
            "ArdaLink ina shughuli nyingi sasa. Tafadhali jaribu tena baada ya dakika moja. / ArdaLink is busy right now. Please try again in a minute.",
          );
        } else {
          setErrorMsg(
            mint.message ??
              "Tatizo la kuanzisha simu. / Could not start the call.",
          );
        }
        stopRingback();
        setStep("error");
        setBusy(false);
        return;
      }

      const client = new BrowserVoiceClient({
        onStateChange: (s, msg) => {
          setVoiceState(s);
          if (s === "live") {
            setStatusMsg("Umeunganishwa / Connected");
            setCallStartedAt(Date.now());
          } else if (s === "stopped") {
            stopRingback();
            setStatusMsg("Simu imeisha · Call ended");
            setStep("ended");
          } else if (s === "error") {
            stopRingback();
            setErrorMsg(
              (msg ? micErrorMessage(msg) : null) ??
                msg ??
                "Hitilafu ya muunganisho. / Connection error.",
            );
            setStep("error");
          }
        },
        onTranscript: (entry) => {
          setTranscript((prev) => [...prev, entry]);
        },
        onFirstAudio: () => {
          // The AI just spoke its first word — stop "ringing" and hand the
          // audio over to the real voice.
          stopRingback();
        },
      });
      clientRef.current = client;
      await client.start(mint.token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stopRingback();
      setErrorMsg(
        micErrorMessage(message) ??
          `Hali ya mtandao imekatika. / Connection dropped. ${message}`,
      );
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  const handleEndCall = () => {
    stopRingback();
    clientRef.current?.stop();
    clientRef.current = null;
  };

  const handleToggleMute = () => {
    const next = !muted;
    setMuted(next);
    clientRef.current?.setMuted(next);
  };

  const handleReturn = () => {
    setStep("ready");
    setTranscript([]);
    setErrorMsg("");
    setStatusMsg("");
    setVoiceState("idle");
    setCallStartedAt(null);
    setDurationSec(0);
    setShowTranscript(false);
  };

  // ───── In-call full-screen view ─────
  if (step === "calling" || step === "ended") {
    const isLive = voiceState === "live";
    const isConnecting =
      voiceState === "connecting" ||
      (step === "calling" &&
        !isLive &&
        voiceState !== "stopped" &&
        voiceState !== "error");
    const isEnded = step === "ended";

    return (
      <div className="fixed inset-0 flex flex-col bg-gradient-to-b from-stone-900 via-stone-800 to-amber-950 text-white overflow-hidden">
        {/* Status bar */}
        <div className="pt-8 pb-4 text-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-amber-300/80">
            {isConnecting
              ? "Inaita · Calling"
              : isEnded
                ? "Imeisha · Ended"
                : "Umeunganishwa · Connected"}
          </p>
          <h2 className="mt-1 text-2xl font-semibold">ArdaLink</h2>
          <p className="text-xs text-stone-400 mt-0.5">
            Msaidizi wako wa malisho · Rangeland companion
          </p>
          {isLive && (
            <p className="mt-2 font-mono text-base text-emerald-300">
              {formatDuration(durationSec)}
            </p>
          )}
          {isConnecting && (
            <p className="mt-2 text-xs text-stone-400">{statusMsg}</p>
          )}
          {isEnded && (
            <p className="mt-2 text-xs text-stone-400">
              {statusMsg} · {formatDuration(durationSec)}
            </p>
          )}
        </div>

        {/* Avatar with pulse rings */}
        <div className="flex-1 flex items-center justify-center">
          <div className="relative">
            {(isConnecting || isLive) && (
              <>
                <span
                  className="absolute inset-0 rounded-full bg-amber-500/20 animate-ping"
                  style={{ animationDuration: "2s" }}
                />
                <span
                  className="absolute -inset-4 rounded-full bg-amber-500/10 animate-ping"
                  style={{ animationDuration: "2.6s", animationDelay: "0.3s" }}
                />
                <span
                  className="absolute -inset-8 rounded-full bg-amber-500/5 animate-ping"
                  style={{ animationDuration: "3.2s", animationDelay: "0.6s" }}
                />
              </>
            )}
            <div
              className={`relative w-40 h-40 rounded-full flex items-center justify-center text-6xl shadow-2xl border-4 ${
                isLive
                  ? "bg-amber-500 border-amber-300/60"
                  : isConnecting
                    ? "bg-amber-700 border-amber-500/40"
                    : "bg-stone-700 border-stone-500/40"
              }`}
            >
              🌾
            </div>
            {isLive && (
              <div className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-emerald-500 border-4 border-stone-900 flex items-center justify-center">
                <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
              </div>
            )}
          </div>
        </div>

        {/* Transcript drawer */}
        {transcript.length > 0 && (
          <div className="px-4 mb-3">
            <button
              onClick={() => setShowTranscript((v) => !v)}
              className="w-full text-center text-[11px] text-stone-400 hover:text-stone-200 py-1"
            >
              {showTranscript
                ? "Ficha maandishi · Hide transcript"
                : `Onyesha maandishi · Show transcript (${transcript.length})`}
            </button>
            {showTranscript && (
              <div className="max-h-48 overflow-y-auto space-y-1.5 mt-2 bg-black/30 rounded-xl p-3 border border-white/5">
                {transcript.map((t, i) => (
                  <div
                    key={i}
                    className={`text-sm leading-snug ${
                      t.role === "user" ? "text-amber-100" : "text-stone-200"
                    }`}
                  >
                    <span className="text-[9px] uppercase tracking-wider text-stone-500 mr-1.5">
                      {t.role === "user" ? "Wewe" : "AL"}
                    </span>
                    {t.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Control bar */}
        <div className="pb-10 pt-4 px-6">
          {isEnded ? (
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={handleReturn}
                className="w-full max-w-xs bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white font-semibold rounded-2xl py-4 text-base transition-colors"
              >
                Funga · Done
              </button>
              <p className="text-[11px] text-stone-500">
                Asante kwa kuzungumza nasi · Thank you for talking with us
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-8">
              {/* Mute */}
              <button
                onClick={handleToggleMute}
                disabled={!isLive}
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all border-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                  muted
                    ? "bg-white text-stone-900 border-white"
                    : "bg-white/10 text-white border-white/30 hover:bg-white/20"
                }`}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted ? (
                  <svg
                    width="26"
                    height="26"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="2" y1="2" x2="22" y2="22" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                  </svg>
                ) : (
                  <svg
                    width="26"
                    height="26"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                  </svg>
                )}
              </button>

              {/* End */}
              <button
                onClick={handleEndCall}
                className="w-20 h-20 rounded-full bg-red-600 hover:bg-red-700 active:bg-red-800 text-white flex items-center justify-center shadow-xl shadow-red-900/50 transition-all hover:scale-105 active:scale-95"
                aria-label="End call"
              >
                <svg
                  width="34"
                  height="34"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transform: "rotate(135deg)" }}
                >
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                </svg>
              </button>

              {/* Speaker (placeholder always on indicator) */}
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center border-2 bg-white/10 text-white border-white/30"
                aria-label="Speaker on"
              >
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ───── Phone entry / ready view ─────
  return (
    <div className="min-h-screen w-full flex flex-col items-center px-4 py-8 sm:py-12">
      <header className="w-full max-w-md text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-100 text-amber-700 mb-3 text-2xl">
          🌾
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-stone-900">
          ArdaLink
        </h1>
        <p className="mt-1 text-sm text-stone-600">
          Sauti ya rangeland yako · The voice of your rangeland
        </p>
      </header>

      <main className="w-full max-w-md">
        {step === "phone" && (
          <section className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6">
            <h2 className="text-lg font-semibold text-stone-900">
              Karibu! / Welcome!
            </h2>
            <p className="mt-2 text-sm text-stone-700 leading-relaxed">
              Mimi ni ArdaLink — msaidizi wako wa malisho na hali ya hewa.
              Andika namba yako ya simu ili tuanze kuzungumza.
            </p>
            <p className="mt-1 text-xs text-stone-500 leading-relaxed">
              I'm ArdaLink — your rangeland & weather companion. Enter your
              phone number so we can start talking.
            </p>

            <form onSubmit={handleSavePhone} className="mt-5 space-y-4">
              <div>
                <label
                  htmlFor="phone"
                  className="block text-xs font-medium text-stone-700 mb-1.5"
                >
                  Namba ya simu / Phone number
                </label>
                <div className="flex items-stretch rounded-lg border border-stone-300 bg-white focus-within:ring-2 focus-within:ring-amber-500 focus-within:border-amber-500 overflow-hidden">
                  <span className="px-3 flex items-center bg-stone-100 text-stone-700 text-base font-medium border-r border-stone-300 select-none">
                    🇰🇪 +254
                  </span>
                  <input
                    id="phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="712 345 678"
                    className="flex-1 min-w-0 px-3 py-3 text-base text-stone-900 bg-white focus:outline-none"
                    required
                    autoFocus
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-stone-500">
                  Andika namba bila sufuri ya mwanzo · Type without leading 0
                </p>
              </div>

              <div className="rounded-lg bg-stone-50 border border-stone-200 p-3 text-xs text-stone-700 leading-relaxed">
                Kwa kubonyeza chini, unakubali sauti yako na majibu yako
                kuhifadhiwa ili kusaidia jamii yako kupata onyo bora la ukame.
                <span className="block mt-1.5 text-stone-500">
                  By tapping below, you agree your voice and answers are saved
                  to help your community get better drought warnings. You can
                  stop the call anytime.
                </span>
              </div>

              {errorMsg && (
                <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                  {errorMsg}
                </p>
              )}

              <button
                type="submit"
                className="w-full bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white font-semibold rounded-xl py-3.5 text-base transition-colors"
              >
                Endelea / Continue
              </button>
            </form>
          </section>
        )}

        {step === "ready" && savedPhone && (
          <div className="space-y-4">
            {/* Greeting + tab strip */}
            <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-4">
              <p className="text-xs text-stone-500 text-center">
                Habari · Hello{" "}
                <span className="text-stone-900 font-medium">{savedPhone}</span>
              </p>
              <div
                role="tablist"
                aria-label="ArdaLink modes"
                className="mt-3 grid grid-cols-3 gap-1 bg-stone-100 rounded-xl p-1"
              >
                {(
                  [
                    { id: "call", label: "Simu · Call", icon: "📞" },
                    { id: "chat", label: "Andika · Chat", icon: "💬" },
                    { id: "env", label: "Hali · Env", icon: "🛰️" },
                  ] as { id: ReadyTab; label: string; icon: string }[]
                ).map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={readyTab === t.id}
                    onClick={() => setReadyTab(t.id)}
                    className={`rounded-lg py-2 text-xs font-medium transition-colors ${
                      readyTab === t.id
                        ? "bg-white text-stone-900 shadow-sm"
                        : "text-stone-600 hover:text-stone-900"
                    }`}
                  >
                    <span className="mr-1">{t.icon}</span>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {readyTab === "call" && (
              <section className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6 text-center">
                <p className="text-base text-stone-800 leading-relaxed">
                  Bonyeza ili kuzungumza na ArdaLink kuhusu malisho, maji, au
                  mifugo yako.
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Tap below to speak with ArdaLink about pasture, water, or your
                  livestock.
                </p>

                {errorMsg && (
                  <p className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 text-left">
                    {errorMsg}
                  </p>
                )}

                <button
                  onClick={handleStartCall}
                  disabled={busy}
                  className="mt-8 mx-auto w-28 h-28 rounded-full bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-stone-300 text-white shadow-xl shadow-emerald-900/30 transition-all hover:scale-105 active:scale-95 flex items-center justify-center"
                  aria-label="Call ArdaLink"
                >
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                  </svg>
                </button>
                <p className="mt-3 text-base font-semibold text-stone-900">
                  Piga simu · Tap to call
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Zungumza na ArdaLink
                </p>

                <button
                  onClick={handleChangePhone}
                  className="mt-8 text-xs text-stone-500 hover:text-stone-700 underline"
                >
                  Badilisha namba / Change number
                </button>
              </section>
            )}

            {readyTab === "chat" && <ChatPanel />}
            {readyTab === "env" && <EnvPanel />}
          </div>
        )}

        {step === "error" && (
          <section className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6 text-center">
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 text-left">
              {errorMsg}
            </p>
            <button
              onClick={handleReturn}
              className="mt-4 w-full bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white font-semibold rounded-xl py-3.5 text-base transition-colors"
            >
              Jaribu tena / Try again
            </button>
          </section>
        )}
      </main>

      <footer className="mt-10 text-center text-[11px] text-stone-400 max-w-md">
        Bula Pesa Ward, Isiolo · ArdaLink AI
      </footer>
    </div>
  );
}
