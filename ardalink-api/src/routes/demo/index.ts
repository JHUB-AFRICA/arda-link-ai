/**
 * Demo Routes — Unified entry point for all demo simulators.
 *
 * This module exports all demo route handlers for testing without
 * Africa's Talking dependency.
 *
 * Simulators:
 * - USSD: /api/demo/ussd/simulator
 * - SMS: /api/demo/sms/simulator
 * - Voice: /api/demo/voice/simulator
 */

import { Router, type IRouter } from "express";
import ussdRouter from "./ussd.js";
import smsRouter from "./sms.js";
import voiceRouter from "./voice.js";

const router: IRouter = Router();

// Mount individual demo routers
router.use("/ussd", ussdRouter);
router.use("/sms", smsRouter);
router.use("/voice", voiceRouter);

// Demo home page
router.get("/", (_req, res): void => {
  res.set("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArdaLink Demo Hub</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
    }
    .container {
      background: #fff;
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 {
      color: #333;
      margin: 0 0 10px 0;
      font-size: 32px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 40px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
    }
    .card {
      border: 2px solid #eee;
      border-radius: 15px;
      padding: 25px;
      text-decoration: none;
      color: inherit;
      transition: all 0.3s;
    }
    .card:hover {
      border-color: #667eea;
      transform: translateY(-5px);
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.2);
    }
    .card h2 {
      margin: 0 0 10px 0;
      color: #667eea;
      font-size: 20px;
    }
    .card p {
      color: #666;
      font-size: 14px;
      line-height: 1.5;
      margin: 0;
    }
    .card .icon {
      font-size: 32px;
      margin-bottom: 15px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      background: #e0e7ff;
      color: #4338ca;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      margin-left: 8px;
    }
    .note {
      margin-top: 30px;
      padding: 15px;
      background: #fef3c7;
      border-radius: 10px;
      font-size: 13px;
      color: #92400e;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🌾 ArdaLink Demo Hub</h1>
    <p class="subtitle">Test all herder interaction channels without Africa's Talking</p>

    <div class="cards">
      <a href="/api/demo/ussd/simulator" class="card">
        <div class="icon">📱</div>
        <h2>USSD Simulator <span class="badge">DETERMINISTIC</span></h2>
        <p>Feature-phone menu flow: dial *123*8#, pick 1 for a personalized brief in Swahili or English (real satellite numbers + your last report if known). Fixed screens, no LLM in-loop.</p>
      </a>

      <a href="/api/demo/sms/simulator" class="card">
        <div class="icon">💬</div>
        <h2>SMS Simulator <span class="badge">DETERMINISTIC</span></h2>
        <p>Keywords: BULA (brief), MALISHO (water points), ONGEA (request voice call), RIPOTI (my last report), STOP. Personalized by phone lookup against pastoralists.</p>
      </a>

      <a href="/api/demo/voice/simulator" class="card">
        <div class="icon">📞</div>
        <h2>Voice Simulator <span class="badge">HERDER PATH</span></h2>
        <p>Deterministic phone-call flow: enter your phone → personalized opener plays → pick a category → record 20 s → Azure Speech → GPT-5 Mini extracts BCS/water/mortality → ground truth row. Mirrors the exact pipeline real herder calls run.</p>
      </a>
    </div>

    <div id="statusCard" style="margin-top:24px;padding:16px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#334155;">
      <strong>Live services:</strong>
      <div id="statusLine" style="margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#0f172a;">checking…</div>
    </div>

    <div class="note">
      <strong>Note:</strong> All three simulators are now <strong>deterministic</strong> — the
      LLM never runs in the interaction loop. Responses are fixed templates filled with fresh
      ward satellite data and, when the phone maps to a known pastoralist, personalized with
      their location, livestock counts, and last report. GPT-5 Mini only runs post-call on
      voice recordings, to extract structured indicators (BCS / mortality / water status /
      etc.) into <code>ground_truth_reports</code>. Realtime Azure OpenAI is kept in the
      codebase as the Phase-3 upgrade path (see
      <code>ardalink-api/docs/llm-integration.md §5.2</code>) but is not the herder default.
    </div>
  </div>

  <script>
    (async () => {
      const line = document.getElementById('statusLine');
      try {
        const speech = await fetch('/api/speech/status').then(r => r.json());
        const speechBit = speech.configured
          ? '✅ Speech: Azure ' + speech.region + ' (voices ' + speech.voiceSw + ' / ' + speech.voiceEn + ')'
          : '⚠️ Speech: not configured';
        line.innerHTML = speechBit;
      } catch (e) {
        line.textContent = 'status probe failed';
      }
    })();
  </script>
</body>
</html>
  `);
});

export default router;
