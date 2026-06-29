export type VoiceState = "idle" | "connecting" | "live" | "stopped" | "error";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface BrowserVoiceCallbacks {
  onStateChange?: (state: VoiceState, message?: string) => void;
  onTranscript?: (entry: TranscriptEntry) => void;
  onLevel?: (micLevel: number) => void;
  /** Fired exactly once, the first time the AI sends audio. */
  onFirstAudio?: () => void;
}

const SAMPLE_RATE = 24000;
const FRAME_SIZE = 4096;

function floatToPCM16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

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
  private firstAudioFired = false;
  // Track every scheduled AI audio chunk so we can stop them mid-playback
  // when the caller interrupts (barge-in). Without this, queued chunks
  // keep playing for seconds after the caller starts speaking, blocking
  // the real-phone-call feel.
  private scheduledSources: AudioBufferSourceNode[] = [];

  constructor(callbacks: BrowserVoiceCallbacks = {}) {
    this.callbacks = callbacks;
  }

  private setState(state: VoiceState, message?: string) {
    this.state = state;
    this.callbacks.onStateChange?.(state, message);
  }

  setMuted(muted: boolean): void {
    if (!this.micStream) return;
    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  isAiSpeaking(): boolean {
    return this.aiSpeaking;
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

    // Always forward the mic — even while the AI is speaking. This is what
    // makes barge-in (real-phone-call interruption) possible. Browser
    // echoCancellation + autoGainControl keep speaker feedback out of the
    // upstream audio. Azure server-VAD then decides if the caller actually
    // started speaking and triggers a response.cancel server-side.
    const resampled = resample(input, this.contextRate, SAMPLE_RATE);
    const pcm16 = floatToPCM16(resampled);
    const ab = pcm16.buffer.slice(
      pcm16.byteOffset,
      pcm16.byteOffset + pcm16.byteLength,
    ) as ArrayBuffer;
    const b64 = arrayBufferToBase64(ab);
    this.ws.send(JSON.stringify({ type: "audio", data: b64 }));
  }

  /** Cancel every scheduled AI audio chunk and reset the playback head.
   *  Called when the caller interrupts so the AI's voice cuts off
   *  immediately instead of draining its queue for several seconds. */
  private flushAiAudio(): void {
    for (const src of this.scheduledSources) {
      try {
        src.stop();
      } catch {
        // already stopped or never started — ignore
      }
      try {
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.scheduledSources = [];
    if (this.audioCtx) {
      this.playbackTime = this.audioCtx.currentTime;
    }
    if (this.aiSpeakingTimer) {
      clearTimeout(this.aiSpeakingTimer);
      this.aiSpeakingTimer = null;
    }
    this.aiSpeaking = false;
    // Server already knows it cancelled, but tell it explicitly that
    // playback is now silent so its in-flight flag matches reality.
    this.notifyPlaybackEnded();
  }

  private markAISpeaking(): void {
    this.aiSpeaking = true;
  }

  private scheduleGateRelease(extraTailMs: number): void {
    if (!this.audioCtx) {
      this.aiSpeaking = false;
      this.notifyPlaybackEnded();
      return;
    }
    if (this.aiSpeakingTimer) clearTimeout(this.aiSpeakingTimer);
    const remainingMs =
      Math.max(0, this.playbackTime - this.audioCtx.currentTime) * 1000;
    this.aiSpeakingTimer = setTimeout(() => {
      this.aiSpeakingTimer = null;
      if (!this.audioCtx) {
        this.aiSpeaking = false;
        this.notifyPlaybackEnded();
        return;
      }
      if (this.playbackTime > this.audioCtx.currentTime + 0.05) {
        this.scheduleGateRelease(extraTailMs);
        return;
      }
      this.aiSpeaking = false;
      this.notifyPlaybackEnded();
    }, remainingMs + extraTailMs);
  }

  /** Tell the server the browser has actually finished playing AI audio.
   *  Without this, the server clears its aiAudioInFlight flag the moment
   *  Azure finishes *generating* audio — but the browser is still playing
   *  it for several seconds, during which the caller can't trigger
   *  barge-in. We send this signal so the server keeps the flag true
   *  for the full duration of caller-audible AI speech. */
  private notifyPlaybackEnded(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "playback_ended" }));
      } catch {
        /* ignore */
      }
    }
  }

  private handleServerMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "audio" && typeof msg.data === "string") {
      if (!this.firstAudioFired) {
        this.firstAudioFired = true;
        this.callbacks.onFirstAudio?.();
      }
      this.markAISpeaking();
      this.playPCM16(msg.data);
    } else if (msg.type === "audio_done") {
      this.scheduleGateRelease(250);
    } else if (msg.type === "interrupt") {
      // Server detected the caller speaking over the AI — stop AI audio
      // immediately so the caller hears only their own voice.
      this.flushAiAudio();
    } else if (
      msg.type === "transcript" &&
      typeof msg.role === "string" &&
      typeof msg.text === "string"
    ) {
      this.callbacks.onTranscript?.({
        role: msg.role as "user" | "assistant",
        text: msg.text,
      });
    } else if (msg.type === "end_call") {
      // Server initiated hangup (AI's end_call tool, or hard cap)
    } else if (msg.type === "error") {
      this.setState("error", String(msg.message ?? "Realtime error"));
    }
  }

  private playPCM16(b64: string): void {
    if (!this.audioCtx) return;
    const ab = base64ToArrayBuffer(b64);
    const float32 = pcm16ToFloat(ab);
    if (float32.length === 0) return;
    const buffer = this.audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.audioCtx.destination);
    const startAt = Math.max(this.audioCtx.currentTime, this.playbackTime);
    src.start(startAt);
    this.playbackTime = startAt + buffer.duration;
    // Track for barge-in flush. Self-prune when the chunk finishes
    // playing so the list doesn't grow unbounded over a long call.
    this.scheduledSources.push(src);
    src.onended = () => {
      const i = this.scheduledSources.indexOf(src);
      if (i !== -1) this.scheduledSources.splice(i, 1);
    };
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
    for (const src of this.scheduledSources) {
      try {
        src.stop();
      } catch {
        /* ignore */
      }
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.scheduledSources = [];
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
