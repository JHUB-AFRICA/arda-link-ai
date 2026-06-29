export type VoiceState = "idle" | "connecting" | "live" | "stopped" | "error";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface BrowserVoiceCallbacks {
  onStateChange?: (state: VoiceState, message?: string) => void;
  onTranscript?: (entry: TranscriptEntry) => void;
  onLevel?: (micLevel: number) => void;
}

const SAMPLE_RATE = 24000;
const FRAME_SIZE = 4096;

function floatToPCM16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Linear-interpolation resampler. Realtime API requires exactly 24 kHz mono;
// the browser may ignore our AudioContext sampleRate hint and run at 44.1/48k,
// in which case sending raw frames would make us sound like chipmunks to the AI.
function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIdx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function pcm16ToFloat(buffer: ArrayBuffer): Float32Array {
  const view = new Int16Array(buffer);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) {
    out[i] = view[i] / (view[i] < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize) as unknown as number[],
    );
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class BrowserVoiceClient {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private playbackTime = 0;
  private state: VoiceState = "idle";
  private callbacks: BrowserVoiceCallbacks;
  private aborted = false;
  private contextRate = SAMPLE_RATE;
  private aiSpeaking = false;
  private aiSpeakingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: BrowserVoiceCallbacks = {}) {
    this.callbacks = callbacks;
  }

  private setState(state: VoiceState, message?: string) {
    this.state = state;
    this.callbacks.onStateChange?.(state, message);
  }

  async start(token: string): Promise<void> {
    if (this.state === "live" || this.state === "connecting") return;
    if (!token) {
      this.setState("error", "Missing call token");
      throw new Error("Missing call token");
    }
    this.aborted = false;
    this.setState("connecting");

    try {
      const AudioContextClass =
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext || window.AudioContext;
      this.audioCtx = new AudioContextClass({ sampleRate: SAMPLE_RATE });
      // The browser may ignore the sampleRate hint (Safari, some Linux). Use
      // the actual rate so we resample correctly on both sides.
      this.contextRate = this.audioCtx.sampleRate;
      this.playbackTime = this.audioCtx.currentTime;

      if (!navigator.mediaDevices?.getUserMedia) {
        // Insecure context, or an embedded iframe that doesn't permit mic capture.
        throw new Error(
          window.self !== window.top ? "MIC_BLOCKED_IFRAME" : "MIC_UNSUPPORTED",
        );
      }

      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (micErr) {
        const name = (micErr as DOMException)?.name ?? "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          // Either the user denied the prompt, OR the page is embedded in an
          // iframe (e.g. the Replit preview/canvas) that withholds the mic.
          throw new Error(
            window.self !== window.top ? "MIC_BLOCKED_IFRAME" : "MIC_DENIED",
          );
        }
        if (name === "NotFoundError" || name === "OverconstrainedError") {
          throw new Error("MIC_NOT_FOUND");
        }
        throw new Error("MIC_ERROR");
      }
      if (this.aborted) throw new Error("aborted");

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${window.location.host}/api/browser-voice-stream?token=${encodeURIComponent(token)}`;
      this.ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        if (!this.ws) return reject(new Error("WebSocket not initialized"));
        this.ws.onopen = () => resolve();
        this.ws.onerror = () =>
          reject(new Error("WebSocket connection failed"));
      });
      if (this.aborted) throw new Error("aborted");

      this.ws.onmessage = (e) => this.handleServerMessage(e.data);
      this.ws.onclose = () => {
        if (this.state === "live" || this.state === "connecting") {
          this.cleanup();
          this.setState("stopped");
        }
      };
      this.ws.onerror = () => {
        if (this.state === "live" || this.state === "connecting") {
          this.setState("error", "Connection lost");
          this.cleanup();
        }
      };

      this.source = this.audioCtx.createMediaStreamSource(this.micStream);
      this.processor = this.audioCtx.createScriptProcessor(FRAME_SIZE, 1, 1);
      this.processor.onaudioprocess = (ev) => this.handleMicFrame(ev);
      this.silentGain = this.audioCtx.createGain();
      this.silentGain.gain.value = 0;
      this.source.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.audioCtx.destination);

      this.setState("live");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cleanup();
      if (this.aborted) {
        this.setState("stopped");
      } else {
        this.setState("error", message);
        throw err;
      }
    }
  }

  private handleMicFrame(ev: AudioProcessingEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += Math.abs(input[i]);
    this.callbacks.onLevel?.(sum / input.length);

    // Echo gating: while AI is speaking, don't send mic audio — otherwise
    // server VAD picks up AI's own voice through the speakers and cuts it off
    // mid-sentence (the classic "voice keeps breaking" symptom).
    if (this.aiSpeaking) return;

    // Resample to true 24 kHz if AudioContext didn't honor our hint.
    const resampled = resample(input, this.contextRate, SAMPLE_RATE);
    const pcm16 = floatToPCM16(resampled);
    const ab = pcm16.buffer.slice(
      pcm16.byteOffset,
      pcm16.byteOffset + pcm16.byteLength,
    ) as ArrayBuffer;
    const b64 = arrayBufferToBase64(ab);
    this.ws.send(JSON.stringify({ type: "audio", data: b64 }));
  }

  private markAISpeaking(): void {
    this.aiSpeaking = true;
    // No time-based fallback here — delta gaps from network jitter must not
    // reopen the mic. The gate is cleared only when the scheduled playback
    // queue has actually drained (see scheduleGateRelease).
  }

  // Clear the mic gate once the scheduled playback time is in the past plus a
  // small tail, so the AI's last sample isn't still coming out of the speaker
  // when we re-open the mic. Re-checks itself until the queue drains.
  private scheduleGateRelease(extraTailMs: number): void {
    if (!this.audioCtx) {
      this.aiSpeaking = false;
      return;
    }
    if (this.aiSpeakingTimer) clearTimeout(this.aiSpeakingTimer);
    const remainingMs =
      Math.max(0, this.playbackTime - this.audioCtx.currentTime) * 1000;
    this.aiSpeakingTimer = setTimeout(() => {
      this.aiSpeakingTimer = null;
      if (!this.audioCtx) {
        this.aiSpeaking = false;
        return;
      }
      // If more audio was queued in the meantime, wait again.
      if (this.playbackTime > this.audioCtx.currentTime + 0.05) {
        this.scheduleGateRelease(extraTailMs);
        return;
      }
      this.aiSpeaking = false;
    }, remainingMs + extraTailMs);
  }

  private handleServerMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "audio" && typeof msg.data === "string") {
      this.markAISpeaking();
      this.playPCM16(msg.data);
    } else if (msg.type === "audio_done") {
      // Server says response audio finished sending. Hold the mic gate closed
      // until the scheduled playback queue actually drains, plus a 250ms tail.
      this.scheduleGateRelease(250);
    } else if (
      msg.type === "transcript" &&
      typeof msg.role === "string" &&
      typeof msg.text === "string"
    ) {
      this.callbacks.onTranscript?.({
        role: msg.role as "user" | "assistant",
        text: msg.text,
      });
    } else if (msg.type === "error") {
      this.setState("error", String(msg.message ?? "Realtime error"));
    }
  }

  private playPCM16(b64: string): void {
    if (!this.audioCtx) return;
    const ab = base64ToArrayBuffer(b64);
    const float32 = pcm16ToFloat(ab);
    if (float32.length === 0) return;
    // Server always sends 24 kHz PCM16. If our AudioContext is running at a
    // different rate (because the browser ignored the hint), createBuffer at
    // 24 kHz still works — Web Audio resamples on the way to the output device.
    const buffer = this.audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.audioCtx.destination);
    const startAt = Math.max(this.audioCtx.currentTime, this.playbackTime);
    src.start(startAt);
    this.playbackTime = startAt + buffer.duration;
  }

  stop(): void {
    this.aborted = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        /* ignore */
      }
    }
    this.cleanup();
    this.setState("stopped");
  }

  private cleanup(): void {
    if (this.aiSpeakingTimer) {
      clearTimeout(this.aiSpeakingTimer);
      this.aiSpeakingTimer = null;
    }
    this.aiSpeaking = false;
    try {
      this.processor?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.silentGain?.disconnect();
    } catch {
      /* ignore */
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      void this.audioCtx.close();
    }
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.micStream = null;
    this.ws = null;
    this.audioCtx = null;
  }
}

// Map an error code/message thrown by BrowserVoiceClient into a clear,
// actionable bilingual message. Returns null when the error isn't a known
// microphone/permission case (caller falls back to its own generic message).
export function micErrorMessage(raw: string): string | null {
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
