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
 */
async function shortAudioFallback(
  audio: Uint8Array | Buffer,
  contentType: string,
  locales: string[],
): Promise<FastTranscribeResult | null> {
  const cfg = config();
  const primaryLanguage = locales[0] ?? 'sw-KE';
  const url = new URL(
    `https://${cfg.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`,
  );
  url.searchParams.set('language', primaryLanguage);
  url.searchParams.set('format', 'detailed');
  url.searchParams.set('profanity', 'masked');
  if (locales.length > 1) {
    url.searchParams.set('languageIdentification', locales.join(','));
  }
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': cfg.key,
        'Content-Type': contentType || 'audio/wav',
        Accept: 'application/json',
      },
      body: audio,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      logger.error(
        { status: res.status, body: errText.slice(0, 400) },
        '[Speech] Short-audio fallback failed',
      );
      return null;
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
    if (!transcript) {
      logger.warn(
        { status: data.RecognitionStatus, lang: data.Language },
        '[Speech] Short-audio returned empty transcript',
      );
      return null;
    }
    logger.info(
      {
        detectedLanguage: data.Language,
        confidence: nbest?.Confidence,
        textLen: transcript.length,
      },
      '[Speech] Short-audio recognized (fallback path)',
    );
    return {
      transcript,
      locale: data.Language,
      durationMs:
        typeof data.Duration === 'number' ? data.Duration / 10_000 : undefined,
    };
  } catch (err) {
    logger.error({ err }, '[Speech] Short-audio fallback crashed');
    return null;
  }
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
