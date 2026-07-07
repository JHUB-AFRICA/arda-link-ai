/**
 * Azure Speech routes.
 *
 *   GET  /api/speech/status
 *     Reports whether the Azure Speech key + region are configured.
 *     Cheap, no upstream call.
 *
 *   GET  /api/speech/token
 *     Mints a short-lived (~10 min) Azure Speech STS token that the
 *     browser Speech SDK can use directly, so we never ship the raw
 *     subscription key to the client. Response:
 *       { token, region, expiresAt }
 *
 *   POST /api/speech/tts
 *     Body: { text, lang?: 'sw' | 'en', voice? }
 *     Returns audio/mpeg bytes synthesised via Azure TTS.
 *
 *   GET  /api/speech/brief.mp3?lang=sw
 *     Convenience for the USSD → callback flow: renders the latest
 *     intelligence brief as spoken Swahili (default) audio the herder
 *     can be played on a follow-up call.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from 'express';
import { logger } from '../lib/logger.js';
import {
  isSpeechConfigured,
  issueSpeechToken,
  textToSpeech,
} from '../lib/speech.js';

const router: IRouter = Router();

router.get('/speech/status', (_req: Request, res: Response) => {
  res.json({
    configured: isSpeechConfigured(),
    region: process.env.AZURE_SPEECH_REGION ?? null,
    voiceSw: process.env.AZURE_SPEECH_TTS_VOICE_SW ?? 'sw-KE-ZuriNeural',
    voiceEn: process.env.AZURE_SPEECH_TTS_VOICE_EN ?? 'en-KE-AsiliaNeural',
  });
});

router.get('/speech/token', async (_req: Request, res: Response) => {
  if (!isSpeechConfigured()) {
    res.status(503).json({ error: 'speech-not-configured' });
    return;
  }
  try {
    const t = await issueSpeechToken();
    res.json(t);
  } catch (err) {
    logger.error({ err }, '[Speech] token issue failed');
    res.status(502).json({ error: 'speech-token-failed' });
  }
});

router.post('/speech/tts', async (req: Request, res: Response) => {
  if (!isSpeechConfigured()) {
    res.status(503).json({ error: 'speech-not-configured' });
    return;
  }
  const body = (req.body ?? {}) as {
    text?: unknown;
    lang?: unknown;
    voice?: unknown;
  };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text-required' });
    return;
  }
  if (text.length > 3000) {
    res.status(413).json({ error: 'text-too-long', maxChars: 3000 });
    return;
  }
  const lang = body.lang === 'en' ? 'en' : 'sw';
  const voice = typeof body.voice === 'string' ? body.voice : undefined;
  try {
    const { audio, contentType } = await textToSpeech(text, { lang, voice });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=60');
    res.send(audio);
  } catch (err) {
    logger.error({ err }, '[Speech] TTS synthesis failed');
    res.status(502).json({ error: 'tts-failed' });
  }
});

router.get('/speech/brief.mp3', async (req: Request, res: Response) => {
  if (!isSpeechConfigured()) {
    res.status(503).json({ error: 'speech-not-configured' });
    return;
  }
  const lang = req.query.lang === 'en' ? 'en' : 'sw';
  try {
    const mod = await import('../lib/intelligence.js');
    const last = mod.getLastResult();
    const stressedPct = last?.live?.anomaly?.wardStressedPixelPct;
    const risk = last?.forecast?.outlook.riskLevel;
    const rec = last?.forecast?.outlook.recommendation;

    let text: string;
    if (stressedPct == null) {
      text =
        lang === 'sw'
          ? 'Samahani, hatuna ripoti mpya ya satellite kwa Bula Pesa leo. Tafadhali jaribu tena baadaye.'
          : 'Sorry, there is no fresh satellite reading for Bula Pesa today. Please try again later.';
    } else if (lang === 'sw') {
      text = `Habari yako. Hii ni ripoti ya ArdaLink kwa Bula Pesa Ward. Karibu asilimia ${stressedPct.toFixed(
        0,
      )} ya eneo la malisho limeathirika kwa sasa. Hali ya hatari ni ${
        risk ?? 'wastani'
      }. ${rec ? `Ushauri wetu: ${rec}` : ''} Asante kwa kupiga simu ArdaLink.`;
    } else {
      text = `Hello. This is your ArdaLink update for Bula Pesa Ward. About ${stressedPct.toFixed(
        0,
      )} percent of the grazing area is currently stressed. Overall drought risk is ${
        risk ?? 'moderate'
      }. ${rec ? `Our advice: ${rec}.` : ''} Thank you for calling ArdaLink.`;
    }

    const { audio, contentType } = await textToSpeech(text, { lang });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=30');
    res.send(audio);
  } catch (err) {
    logger.error({ err }, '[Speech] brief.mp3 failed');
    res.status(502).json({ error: 'brief-tts-failed' });
  }
});

export default router;
