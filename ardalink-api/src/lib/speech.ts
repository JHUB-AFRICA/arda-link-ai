/**
 * Azure Speech (Cognitive Services Speech) — STT, TTS, and browser-SDK
 * token issuance. Region-based; keys from AZURE_SPEECH_KEY.
 *
 * Endpoints (region = southafricanorth):
 *   STT REST : POST https://{region}.stt.speech.microsoft.com
 *              /speech/recognition/conversation/cognitiveservices/v1
 *   TTS REST : POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 *   Token    : POST https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken
 *
 * Voices default to Kenyan Swahili + English neural voices — override
 * with AZURE_SPEECH_TTS_VOICE_SW / AZURE_SPEECH_TTS_VOICE_EN.
 *
 * Falls back to no-op behaviour if AZURE_SPEECH_KEY is unset — callers
 * can check isSpeechConfigured() before using.
 */

import { spawn } from 'node:child_process';
import { logger } from './logger.js';

export interface SpeechConfig {
  key: string;
  region: string;
  ttsVoiceSw: string;
  ttsVoiceEn: string;
  sttLanguages: string[];
}

export function isSpeechConfigured(): boolean {
  return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

function config(): SpeechConfig {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    throw new Error(
      'Azure Speech not configured — set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION',
    );
  }
  return {
    key,
    region,
    ttsVoiceSw:
      process.env.AZURE_SPEECH_TTS_VOICE_SW ?? 'sw-KE-ZuriNeural',
    ttsVoiceEn:
      process.env.AZURE_SPEECH_TTS_VOICE_EN ?? 'en-KE-AsiliaNeural',
    sttLanguages: (
      process.env.AZURE_SPEECH_STT_LANGUAGES ?? 'sw-KE,en-KE'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Issue a short-lived (10 min) authorization token that the browser
 * Speech SDK can use directly. This keeps the raw subscription key on
 * the server. Return shape: { token, region }.
 */
export async function issueSpeechToken(): Promise<{
  token: string;
  region: string;
  expiresAt: number;
}> {
  const { key, region } = config();
  const url = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Length': '0',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Speech token issue failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const token = await res.text();
  return {
    token,
    region,
    expiresAt: Date.now() + 9 * 60 * 1000,
  };
}

export type TtsVoiceLang = 'sw' | 'en';
export interface TtsOptions {
  lang?: TtsVoiceLang;
  voice?: string;
  rate?: string;
  format?: string;
}

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Synthesize `text` to audio bytes. Defaults to 16 kHz mono MP3 (mobile
 * friendly, small); override via `format`. Language default is Swahili
 * — pass `lang: 'en'` for English.
 */
export async function textToSpeech(
  text: string,
  opts: TtsOptions = {},
): Promise<{ audio: Buffer; contentType: string; voice: string }> {
  const cfg = config();
  const lang = opts.lang ?? 'sw';
  const voice =
    opts.voice ??
    (lang === 'sw' ? cfg.ttsVoiceSw : cfg.ttsVoiceEn);
  const format = opts.format ?? 'audio-16khz-32kbitrate-mono-mp3';
  const locale = voice.split('-').slice(0, 2).join('-');
  const rate = opts.rate ?? '0%';
  const ssml = `<?xml version="1.0" encoding="utf-8"?>
<speak version="1.0" xml:lang="${locale}"
       xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="https://www.w3.org/2001/mstts">
  <voice name="${voice}">
    <prosody rate="${rate}">${escapeSsml(text)}</prosody>
  </voice>
</speak>`;

  const url = `https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': format,
      'User-Agent': 'ardalink-api',
    },
    body: ssml,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Azure TTS ${res.status}: ${errText.slice(0, 200)}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  const contentType =
    format === 'audio-16khz-32kbitrate-mono-mp3'
      ? 'audio/mpeg'
      : 'application/octet-stream';
  logger.info(
    { bytes: audio.length, voice, lang, format },
    '[Speech] TTS synthesized',
  );
  return { audio, contentType, voice };
}

export interface SttResult {
  text: string;
  detectedLanguage?: string;
  durationMs?: number;
  confidence?: number;
}

/**
 * Azure Speech "Fast Transcription" API (batch, non-streaming).
 * Better than the short-audio REST endpoint for the deterministic
 * pipeline (recorded call → transcript) because:
 *
 *   - Accepts any container the recorder produces (WAV, MP3, WebM/opus,
 *     M4A) as multipart form data — no need to convert AT's recording
 *     download to a specific sample rate.
 *   - Supports **automatic multi-locale detection** via the `locales`
 *     array in the `definition` payload — sw-KE and en-KE are both
 *     evaluated per phrase, matching how herders actually code-switch
 *     mid-utterance.
 *   - Returns `combinedPhrases[]` with normalised text ready to feed
 *     into the LLM extractor.
 *
 * Endpoint shape (2024-11-15 API version, current GA):
 *   POST {AZURE_SPEECH_ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=2024-11-15
 *
 * `endpoint` here means the raw `southafricanorth.api.cognitive.microsoft.com`
 * host (with or without trailing slash) — we normalise it.
 */
export interface FastTranscribeResult {
  transcript: string;
  locale?: string;
  durationMs?: number;
  raw?: unknown;
  /**
   * True when Azure ran recognition to completion but the audio
   * contained no speech (silent mic / background noise only).
   * Callers should surface a user-friendly "we didn't hear you"
   * message rather than a generic transcription-failed error.
   */
  noSpeech?: boolean;
}

// Some Azure Speech regions (e.g. southafricanorth) don't host the Fast
// Transcription API yet. We probe once per process and cache the answer
// so subsequent calls skip straight to the short-audio fallback below.
let fastTranscriptionAvailable: boolean | null = null;

export async function fastTranscribe(
  audio: Uint8Array | Buffer,
  contentType: string,
  opts: { locales?: string[]; filename?: string } = {},
): Promise<FastTranscribeResult | null> {
  const cfg = config();
  const locales =
    opts.locales && opts.locales.length > 0 ? opts.locales : cfg.sttLanguages;

  // Skip Fast Transcription entirely if we've already learned this region
  // doesn't support it — go straight to the short-audio REST fallback.
  if (fastTranscriptionAvailable !== false) {
    const attempt = await tryFastTranscribe(audio, contentType, {
      ...opts,
      locales,
    });
    if (attempt.ok) {
      fastTranscriptionAvailable = true;
      return attempt.result;
    }
    if (attempt.regionUnsupported) {
      fastTranscriptionAvailable = false;
      logger.warn(
        { region: cfg.region },
        '[Speech] Fast Transcription not available in region — using short-audio REST endpoint for all future STT',
      );
    } else if (attempt.result === null) {
      // Non-region failure (temporary). Try the short-audio fallback so the
      // caller still gets a transcript, but don't disable Fast permanently.
      logger.warn('[Speech] Fast Transcription failed — trying short-audio fallback');
    }
  }

  // Short-audio REST fallback. This endpoint is available in every Speech
  // region and supports multi-locale detection via `languageIdentification`.
  return await shortAudioFallback(audio, contentType, locales);
}

interface FastAttempt {
  ok: boolean;
  regionUnsupported: boolean;
  result: FastTranscribeResult | null;
}

async function tryFastTranscribe(
  audio: Uint8Array | Buffer,
  contentType: string,
  opts: { locales: string[]; filename?: string },
): Promise<FastAttempt> {
  const cfg = config();
  const endpoint = (
    process.env.AZURE_SPEECH_ENDPOINT ??
    `https://${cfg.region}.api.cognitive.microsoft.com/`
  ).replace(/\/$/, '');
  const filename = opts.filename ?? 'call-audio.wav';

  const form = new FormData();
  const blob = new Blob([audio], { type: contentType || 'audio/wav' });
  form.append('audio', blob, filename);
  form.append(
    'definition',
    JSON.stringify({
      locales: opts.locales,
      profanityFilterMode: 'None',
      channels: [0],
    }),
  );

  const url = `${endpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': cfg.key },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) {
      const regionUnsupported =
        res.status === 400 && /not supported in this region/i.test(text);
      if (!regionUnsupported) {
        logger.error(
          { status: res.status, body: text.slice(0, 800) },
          '[Speech] Fast transcription failed',
        );
      }
      return { ok: false, regionUnsupported, result: null };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, regionUnsupported: false, result: null };
    }
    const combinedPhrases = parsed.combinedPhrases as
      | Array<Record<string, unknown>>
      | undefined;
    const phrase = combinedPhrases?.find((p) => typeof p.text === 'string');
    const transcript =
      typeof phrase?.text === 'string' ? phrase.text.trim() : '';
    if (!transcript) {
      return { ok: false, regionUnsupported: false, result: null };
    }
    return {
      ok: true,
      regionUnsupported: false,
      result: {
        transcript,
        locale:
          typeof phrase?.locale === 'string'
            ? (phrase.locale as string)
            : undefined,
        durationMs:
          typeof parsed.durationMilliseconds === 'number'
            ? (parsed.durationMilliseconds as number)
            : undefined,
        raw: parsed,
      },
    };
  } catch (err) {
    logger.error({ err }, '[Speech] Fast transcription crashed');
    return { ok: false, regionUnsupported: false, result: null };
  }
}

/**
 * Short-audio fallback — the classic Speech recognition REST endpoint.
 * Works in every Speech region. Handles arbitrary containers because
 * the recognition service auto-detects most codecs.
 *
 * IMPORTANT: this endpoint does NOT support Azure's `languageIdentification`
 * query param (that's only on Fast Transcription / Speech SDK). Setting
 * `language=` here locks recognition to ONE locale — if the caller
 * spoke a different one, Azure returns empty. Our herders may speak
 * either sw-KE or en-KE, so we retry across each of the configured
 * locales and take the first non-empty transcript.
 */
async function shortAudioFallback(
  audio: Uint8Array | Buffer,
  contentType: string,
  locales: string[],
): Promise<FastTranscribeResult | null> {
  const cfg = config();
  const languages = locales.length > 0 ? locales : ['sw-KE'];

  // Azure short-audio in southafricanorth rejects most upstream
  // formats — verified empirically for WebM/opus (browser) and
  // audio/mpeg (AT recordings). Only WAV and OGG/opus round-trip
  // reliably. Rather than maintain a case-by-case allowlist, decode
  // everything to WAV 16 kHz mono PCM up front — it's the format
  // Azure documents as universal, works in every region, and costs
  // ~100-200 ms per clip through ffmpeg. Falls back to the original
  // bytes when ffmpeg is unavailable so we never hard-fail STT.
  let bodyAudio: Uint8Array | Buffer = audio;
  let effectiveContentType = contentType;
  const lowerType = (contentType || '').toLowerCase();
  const alreadyWav = lowerType.startsWith('audio/wav');
  if (!alreadyWav) {
    const wav = await transcodeToWav16kMono(audio);
    if (wav) {
      bodyAudio = wav;
      effectiveContentType = 'audio/wav; codecs=audio/pcm; samplerate=16000';
    }
  }
  const azureContentType = normaliseAudioContentType(effectiveContentType);

  let firstStatus: string | undefined;
  let firstLang: string | undefined;
  // "Success" but empty transcript means Azure ran STT cleanly and
  // heard no speech (silent mic, background noise only). We surface
  // this back to callers as a distinct signal so the UI can show a
  // real error message instead of a generic "transcription empty".
  let anyRecognitionSuccess = false;
  for (const language of languages) {
    const url = new URL(
      `https://${cfg.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`,
    );
    url.searchParams.set('language', language);
    url.searchParams.set('format', 'detailed');
    url.searchParams.set('profanity', 'masked');
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': cfg.key,
          'Content-Type': azureContentType,
          Accept: 'application/json',
        },
        body: bodyAudio,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        logger.warn(
          {
            status: res.status,
            language,
            body: errText.slice(0, 400),
            sentContentType: azureContentType,
          },
          '[Speech] Short-audio fallback non-2xx — will try next locale',
        );
        continue;
      }
      const data = (await res.json()) as {
        RecognitionStatus?: string;
        DisplayText?: string;
        NBest?: { Display?: string; Confidence?: number }[];
        Duration?: number;
        Language?: string;
      };
      const nbest = data.NBest?.[0];
      const transcript = (nbest?.Display ?? data.DisplayText ?? '').trim();
      firstStatus ??= data.RecognitionStatus;
      firstLang ??= data.Language;
      if (data.RecognitionStatus === 'Success') anyRecognitionSuccess = true;
      if (transcript) {
        logger.info(
          {
            language,
            detectedLanguage: data.Language,
            confidence: nbest?.Confidence,
            textLen: transcript.length,
          },
          '[Speech] Short-audio recognized (fallback path)',
        );
        return {
          transcript,
          locale: data.Language ?? language,
          durationMs:
            typeof data.Duration === 'number'
              ? data.Duration / 10_000
              : undefined,
        };
      }
      logger.info(
        { language, status: data.RecognitionStatus },
        '[Speech] Short-audio empty for this locale — will retry next',
      );
    } catch (err) {
      logger.warn(
        { err, language },
        '[Speech] Short-audio fallback crashed — will try next locale',
      );
    }
  }
  logger.warn(
    {
      status: firstStatus,
      lang: firstLang,
      languagesTried: languages,
      likelyNoSpeech: anyRecognitionSuccess,
    },
    anyRecognitionSuccess
      ? '[Speech] Short-audio: no speech detected in audio (silent mic or background noise only)'
      : '[Speech] Short-audio returned empty transcript for every configured locale',
  );
  // Signal the "no speech" case distinctly so callers can render a
  // useful UI message instead of a generic transcription-failed error.
  if (anyRecognitionSuccess) {
    return { transcript: '', locale: firstLang, noSpeech: true };
  }
  return null;
}

/**
 * Normalise a browser-supplied Content-Type to something Azure's
 * short-audio REST endpoint recognises. Azure's parser accepts
 * `audio/wav`, `audio/ogg;codecs=opus`, `audio/mp3`, and NOT
 * `audio/webm` (verified empirically 2026-07-10). Ogg-opus is our
 * canonical form because ffmpeg can transmux to it without
 * re-encoding.
 */
function normaliseAudioContentType(input: string): string {
  const raw = (input || '').trim().toLowerCase();
  if (!raw) return 'audio/ogg; codecs=audio/opus';
  if (raw.startsWith('audio/ogg')) return 'audio/ogg; codecs=audio/opus';
  if (raw.startsWith('audio/webm')) return 'audio/webm; codecs=audio/opus';
  if (raw.startsWith('audio/mpeg') || raw.startsWith('audio/mp3'))
    return 'audio/mp3';
  return raw;
}

/**
 * Convert any input audio (WebM/opus, MP3, MP4/AAC, arbitrary) to
 * WAV 16 kHz mono PCM via ffmpeg. WAV is the universal format for
 * Azure's short-audio REST endpoint — works in every region, no
 * codec parameter negotiation needed. ~100-200 ms overhead per 20 s
 * clip, worth it for reliability.
 *
 * We used to try a WebM→OGG `-c copy` transmux, but Azure's
 * short-audio parser in southafricanorth also rejects raw MP3
 * (AT's default recording format), so decoding to WAV is the only
 * shape that works for every upstream. When ffmpeg isn't installed
 * or the encode fails, callers fall back to the original bytes.
 */
function transcodeToWav16kMono(
  audio: Uint8Array | Buffer,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const ff = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '1',        // mono
      '-ar', '16000',    // 16 kHz — Azure's preferred sample rate
      '-f', 'wav',
      '-y',
      'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr.on('data', (c: Buffer) => errChunks.push(c));
    ff.on('error', (err) => {
      if (done) return;
      done = true;
      logger.warn({ err: String(err) }, '[Speech] ffmpeg spawn failed');
      resolve(null);
    });
    ff.on('close', (code) => {
      if (done) return;
      done = true;
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 200);
        logger.warn(
          { code, stderr },
          '[Speech] ffmpeg → WAV transcode failed',
        );
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    try {
      ff.stdin.end(audio);
    } catch (err) {
      if (done) return;
      done = true;
      logger.warn({ err: String(err) }, '[Speech] ffmpeg stdin write failed');
      resolve(null);
    }
  });
}

/**
 * Speech-to-text over the short-audio REST endpoint. Suitable for
 * request/response transcription (< 60s of audio). For streaming call
 * audio, use the browser Speech SDK or the WS-based Realtime bridge.
 *
 * `format` defaults to WAV PCM 16 kHz mono (`riff-16khz-16bit-mono-pcm`)
 * which is what most SDK callers and Africa's Talking will hand us.
 */
export async function speechToText(
  audio: Buffer,
  opts: {
    contentType?: string;
    language?: string;
    detectMultiple?: boolean;
  } = {},
): Promise<SttResult> {
  const cfg = config();
  const contentType =
    opts.contentType ?? "audio/wav; codecs=audio/pcm; samplerate=16000";
  const primaryLanguage = opts.language ?? cfg.sttLanguages[0] ?? 'sw-KE';
  const url = new URL(
    `https://${cfg.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`,
  );
  url.searchParams.set('language', primaryLanguage);
  url.searchParams.set('format', 'detailed');
  url.searchParams.set('profanity', 'masked');
  if (opts.detectMultiple !== false && cfg.sttLanguages.length > 1) {
    url.searchParams.set(
      'languageIdentification',
      cfg.sttLanguages.join(','),
    );
  }

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.key,
      'Content-Type': contentType,
      Accept: 'application/json',
    },
    body: audio,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Azure STT ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    RecognitionStatus?: string;
    DisplayText?: string;
    NBest?: {
      Display?: string;
      Lexical?: string;
      Confidence?: number;
    }[];
    Duration?: number;
    Language?: string;
  };
  const nbest = data.NBest?.[0];
  const text = nbest?.Display ?? data.DisplayText ?? '';
  logger.info(
    {
      status: data.RecognitionStatus,
      detectedLanguage: data.Language,
      confidence: nbest?.Confidence,
      textLen: text.length,
    },
    '[Speech] STT recognized',
  );
  return {
    text,
    detectedLanguage: data.Language,
    durationMs:
      typeof data.Duration === 'number' ? data.Duration / 10_000 : undefined,
    confidence: nbest?.Confidence,
  };
}
