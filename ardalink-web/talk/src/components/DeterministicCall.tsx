import { useEffect, useRef, useState } from "react";

/**
 * DeterministicCall — the /talk app's call surface, deterministic edition.
 *
 * Flow (mirrors the herder AT call, from a browser instead of a phone):
 *   1. Look up herder context from phone → play a localized TTS opener.
 *   2. Show category buttons (BCS, water, mortality, feeding, milk, trek, other).
 *   3. Record up to 20 s via MediaRecorder.
 *   4. POST audio to /api/talk/record; server transcribes with Azure Speech,
 *      extracts indicators via GPT-5 Mini, and writes a ground-truth row.
 *   5. Render the extracted structured report so the caller sees what the AI
 *      captured — closing the loop the same way real herder calls do.
 *
 * No WebSocket, no Azure Realtime deployment, no LLM in the interaction loop.
 * Works on any browser with getUserMedia (Chrome, Edge, Safari 14+, Firefox).
 */

interface Props {
  phone: string;
  onChangePhone: () => void;
}

type Category =
  | "bcs"
  | "water_point"
  | "mortality"
  | "feeding"
  | "milk"
  | "water_trek"
  | "drought_signal";

interface HerderContext {
  known: boolean;
  name: string | null;
  location: string | null;
  cattle: number | null;
  goats: number | null;
  camels: number | null;
  waterSource: string | null;
  lastBcsScore: number | null;
  lastBcsSpecies: string | null;
  lastActionTag: string | null;
  wardStressedPct: number | null;
  wardRiskLevel: string | null;
  wardRecommendation: string | null;
}

interface ContextResp {
  ctx: HerderContext;
  opener: string;
  briefSw: string;
  briefEn: string;
}

interface RecordResp {
  ok: boolean;
  reportId: number | null;
  transcript: string;
  detectedLocale: string | null;
  actionTag: string;
  indicators: Record<string, unknown> | null;
  trustScore: number | null;
  indicatorsCollected: number;
  dataCompletenessPercent: number | null;
  herderContext: HerderContext | null;
}

const CATEGORIES: { id: Category; label: string; icon: string }[] = [
  { id: "bcs", label: "Hali ya mifugo · BCS", icon: "🐄" },
  { id: "water_point", label: "Maji · Water point", icon: "💧" },
  { id: "mortality", label: "Vifo · Mortality", icon: "💀" },
  { id: "feeding", label: "Chakula · Feed", icon: "🌾" },
  { id: "milk", label: "Maziwa · Milk", icon: "🥛" },
  { id: "water_trek", label: "Umbali wa maji · Trek", icon: "🚶" },
  { id: "drought_signal", label: "Nyingine · Other", icon: "🌡️" },
];

type Step = "loading" | "ready" | "recording" | "processing" | "done" | "error";

export default function DeterministicCall({ phone, onChangePhone }: Props) {
  const [step, setStep] = useState<Step>("loading");
  const [ctx, setCtx] = useState<ContextResp | null>(null);
  const [category, setCategory] = useState<Category>("bcs");
  const [errorMsg, setErrorMsg] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [report, setReport] = useState<RecordResp | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startAtRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const openerAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStep("loading");
    setStatusMsg("Inatafuta mahali pako · Looking up your ward");
    (async () => {
      try {
        const r = await fetch(
          "/api/talk/context?phone=" + encodeURIComponent(phone),
        );
        const data = (await r.json()) as ContextResp;
        if (cancelled) return;
        if (!r.ok) {
          setErrorMsg("Failed to look up context.");
          setStep("error");
          return;
        }
        setCtx(data);
        setStep("ready");
        setStatusMsg(
          data.ctx.known
            ? `Karibu ${data.ctx.name ?? "rafiki"}${data.ctx.location ? " · " + data.ctx.location : ""}`
            : "Karibu · Welcome",
        );
        // Play the personalized opener via server TTS.
        try {
          const tts = await fetch("/api/speech/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: data.opener, lang: "sw" }),
          });
          if (tts.ok && !cancelled) {
            const blob = await tts.blob();
            const audio = new Audio(URL.createObjectURL(blob));
            openerAudioRef.current = audio;
            void audio.play().catch(() => {
              /* auto-play blocked; user still sees the text opener */
            });
          }
        } catch {
          /* TTS failure is non-fatal — text opener still visible */
        }
      } catch (e) {
        setErrorMsg("Could not reach server.");
        setStep("error");
      }
    })();
    return () => {
      cancelled = true;
      if (openerAudioRef.current) {
        openerAudioRef.current.pause();
        openerAudioRef.current.src = "";
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [phone]);

  const pickMime = (): string => {
    const cands = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    for (const c of cands) {
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(c)
      )
        return c;
    }
    return "";
  };

  const startRecording = async () => {
    if (openerAudioRef.current) {
      openerAudioRef.current.pause();
    }
    setErrorMsg("");
    setStatusMsg("Sikiliza sauti yako · Speak now");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;
      const mime = pickMime();
      const recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        void uploadRecording(mime);
      };
      recorder.start();
      startAtRef.current = Date.now();
      setStep("recording");
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        const s = (Date.now() - startAtRef.current) / 1000;
        setElapsed(s);
        if (s >= 20) stopRecording();
      }, 100);
    } catch (e) {
      setErrorMsg(
        "Microphone permission denied. / Ruhusa ya maikrofoni imekataliwa.",
      );
      setStep("error");
    }
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const uploadRecording = async (mime: string) => {
    setStep("processing");
    setStatusMsg("Kutafsiri na kuchambua · Transcribing + extracting");
    const blob = new Blob(chunksRef.current, {
      type: mime || "audio/webm",
    });
    try {
      const qs = new URLSearchParams({
        category,
        phone,
      });
      const r = await fetch("/api/talk/record?" + qs.toString(), {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      const data = (await r.json()) as RecordResp & { error?: string };
      if (!r.ok || !data.ok) {
        if (r.status === 429) {
          setErrorMsg(
            "Ah, umepakia sana kwa muda mfupi. Jaribu tena baada ya saa moja. · Rate limit reached, please try again in an hour.",
          );
        } else if (data.error === "transcription-empty") {
          setErrorMsg(
            "Sauti yako haikuweza kupatikana. Zungumza kwa sauti kubwa zaidi. · We could not hear your voice — please speak louder and try again.",
          );
        } else {
          setErrorMsg(
            "Kuna hitilafu · Something went wrong: " + (data.error ?? r.statusText),
          );
        }
        setStep("error");
        return;
      }
      setReport(data);
      setStep("done");
    } catch (e) {
      setErrorMsg("Server error uploading recording.");
      setStep("error");
    }
  };

  const restart = () => {
    setReport(null);
    setElapsed(0);
    setStatusMsg("");
    setStep("ready");
  };

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6">
      <div className="text-center">
        <p className="text-sm text-stone-500">{statusMsg}</p>
        {ctx?.ctx && (
          <p className="mt-2 text-sm text-stone-700 leading-relaxed">
            {ctx.opener}
          </p>
        )}
      </div>

      {errorMsg && (
        <p className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 text-left">
          {errorMsg}
        </p>
      )}

      {step === "ready" && (
        <>
          <div className="mt-6">
            <p className="text-xs uppercase tracking-wide text-stone-500 mb-2">
              Nini unaripoti? · What are you reporting?
            </p>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategory(c.id)}
                  className={
                    "text-left rounded-xl border p-3 text-sm transition-all " +
                    (category === c.id
                      ? "border-emerald-600 bg-emerald-50 ring-1 ring-emerald-500"
                      : "border-stone-200 bg-white hover:bg-stone-50")
                  }
                >
                  <span className="mr-2">{c.icon}</span>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={startRecording}
            className="mt-6 w-full bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-semibold rounded-xl py-4 text-base transition-colors"
          >
            🎙 Rekodi sauti yako · Record your voice (20 s)
          </button>
        </>
      )}

      {step === "recording" && (
        <div className="mt-6">
          <div className="mx-auto w-28 h-28 rounded-full bg-red-500 animate-pulse flex items-center justify-center text-white text-4xl">
            🎙
          </div>
          <p className="mt-3 text-center text-lg font-mono text-stone-800">
            {elapsed.toFixed(1)} s
          </p>
          <button
            onClick={stopRecording}
            className="mt-4 w-full bg-stone-600 hover:bg-stone-700 text-white font-semibold rounded-xl py-3 text-base"
          >
            ⏹ Nimemaliza · I'm done
          </button>
        </div>
      )}

      {step === "processing" && (
        <div className="mt-6 text-center">
          <div className="mx-auto w-20 h-20 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin"></div>
          <p className="mt-3 text-sm text-stone-600">
            Azure Speech + GPT-5 Mini
          </p>
        </div>
      )}

      {step === "done" && report && (
        <div className="mt-6 space-y-3">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-xs uppercase text-emerald-700 font-semibold">
              📋 Ripoti imepokelewa · Report captured
            </p>
            <p className="mt-2 text-sm text-stone-800 italic">
              "{report.transcript}"
            </p>
            {report.detectedLocale && (
              <p className="mt-1 text-xs text-stone-500">
                Lugha · Language: {report.detectedLocale}
              </p>
            )}
          </div>
          <ReportGrid report={report} />
          <button
            onClick={restart}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl py-3 text-base"
          >
            Ripoti nyingine · Report something else
          </button>
        </div>
      )}

      {step === "error" && (
        <button
          onClick={restart}
          className="mt-4 w-full bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-xl py-3 text-base"
        >
          Jaribu tena · Try again
        </button>
      )}

      <button
        onClick={onChangePhone}
        className="mt-6 text-xs text-stone-500 hover:text-stone-700 underline block mx-auto"
      >
        Badilisha namba · Change number
      </button>
    </section>
  );
}

function ReportGrid({ report }: { report: RecordResp }) {
  const ind = (report.indicators ?? {}) as Record<string, unknown>;
  const rows: [string, string | number | null][] = [
    ["Kitagi · Action tag", report.actionTag],
    ["Eneo · Location", (ind["reported_location"] as string) ?? null],
    ["Aina ya mifugo · Species", (ind["bcs_species"] as string) ?? null],
    [
      "BCS",
      ind["bcs_score"] != null
        ? `${ind["bcs_score"]} (${(ind["bcs_confidence"] as string) ?? "?"})`
        : null,
    ],
    ["Vifo · Mortality", (ind["mortality_rate"] as string) ?? null],
    ["Maziwa · Milk", (ind["milk_production"] as string) ?? null],
    ["Umbali wa maji · Trek", (ind["water_trekking_distance"] as string) ?? null],
    ["Maji · Water point", (ind["water_point_status"] as string) ?? null],
    ["Chakula · Feed", (ind["supplementary_feeding"] as string) ?? null],
    [
      "Kilichokusanywa · Collected",
      `${report.indicatorsCollected}/7 · ${(report.dataCompletenessPercent ?? 0).toFixed(0)}%`,
    ],
    ["Kiwango cha uaminifu · Trust score", report.trustScore],
    ["Namba ya ripoti · Report #", report.reportId],
  ];
  const filtered = rows.filter(
    (r) => r[1] != null && r[1] !== "" && r[1] !== "null",
  );
  return (
    <div className="rounded-xl border border-stone-200 bg-white divide-y divide-stone-100">
      {filtered.map(([k, v]) => (
        <div key={k} className="flex justify-between px-4 py-2 text-sm">
          <span className="text-stone-500">{k}</span>
          <span className="text-stone-900 font-medium text-right ml-2">
            {String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}
