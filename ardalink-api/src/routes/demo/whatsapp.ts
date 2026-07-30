/**
 * Demo WhatsApp Simulator — Web UI for testing the WhatsApp flow without
 * a live 360dialog account.
 *
 * Mirrors demo/sms.ts's shape: its own lightweight reply logic calling
 * resolveHerderContext/buildLocalizedBrief/wpdx.ts directly (same as
 * every other demo simulator), NOT the production webhook's Express
 * handler. Real outbound sends never happen here — this route calls
 * the same conversation-building blocks (buildWhatsappSystemPrompt,
 * extractIndicators, complete()) but renders the "would-have-sent"
 * payload as JSON for the browser UI instead of posting to 360dialog,
 * so it needs zero WhatsApp credentials.
 *
 * Endpoints:
 * - GET  /api/demo/whatsapp/simulator → HTML page with chat + menu buttons
 * - POST /api/demo/whatsapp/send      → process one turn, return the reply
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  resolveHerderContext,
  buildLocalizedBrief,
} from "../../lib/herderContext/index.js";
import { centroidForTenant, nearestWorkingKnownPoints } from "../../lib/wpdx.js";
import { languageForCaller } from "../../lib/voiceCopy.js";
import { extractIndicators } from "../../lib/openai/index.js";
import { buildWhatsappSystemPrompt } from "../../lib/whatsappConversation.js";

const router: IRouter = Router();
const DEMO_TENANT_ID = process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

interface WaTurnResult {
  kind: "list" | "text" | "locations";
  reply: string;
  options?: Array<{ id: string; title: string; description?: string }>;
  locations?: Array<{ name: string; lat: number; lon: number }>;
}

const seenPhones = new Set<string>();

async function replyFor(
  from: string,
  action: string,
  text: string,
): Promise<WaTurnResult> {
  const ctx = await resolveHerderContext(from, DEMO_TENANT_ID);
  const lang = languageForCaller(ctx);

  if (action === "bula_pesa") {
    return { kind: "text", reply: buildLocalizedBrief(ctx, lang) };
  }
  if (action === "malisho") {
    const origin =
      centroidForTenant(DEMO_TENANT_ID) ?? { lat: 0.3453, lon: 37.581 };
    const points = nearestWorkingKnownPoints(origin, 3);
    return {
      kind: "locations",
      reply:
        lang === "sw"
          ? "Maeneo ya maji karibu nawe:"
          : "Water points near you:",
      locations: points.map((p) => ({
        name: p.displayName,
        lat: p.point.lat,
        lon: p.point.lon,
      })),
    };
  }
  if (action === "ongea_na_ai") {
    return {
      kind: "text",
      reply:
        lang === "sw"
          ? "Sawa, niambie mifugo yako inaendeleaje."
          : "Okay, tell me how your animals are doing.",
    };
  }

  // Free text — first-ever message gets the welcome list; anything
  // after that is a conversational turn through the real prompt +
  // extractor (no network call to 360dialog or the LLM's own network
  // dependency is still live — this exercises the actual reasoning
  // path, just without dispatching the reply anywhere).
  if (!seenPhones.has(from)) {
    seenPhones.add(from);
    return {
      kind: "list",
      reply: lang === "sw" ? "Karibu ArdaLink. Chagua huduma:" : "Welcome to ArdaLink. Choose a service:",
      options: [
        { id: "bula_pesa", title: "Bula Pesa", description: "Drought brief" },
        { id: "malisho", title: "Malisho", description: "Water points" },
        { id: "ongea_na_ai", title: "Ongea na AI", description: "Talk to the AI" },
      ],
    };
  }

  const { complete } = await import("../../lib/llm/index.js");
  // Demo simulator keeps no message history of its own — by the time
  // this branch runs, seenPhones already has `from` (the first message
  // always goes to the welcome-list branch above), so this is never
  // the true first turn.
  const systemPrompt = buildWhatsappSystemPrompt(ctx, lang, true);
  const [llmResponse, indicators] = await Promise.all([
    complete(
      "multilingual",
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        temperature: 0.7,
        maxTokens: 400,
      },
      { tenantId: DEMO_TENANT_ID },
    ),
    extractIndicators(text),
  ]);
  const reply =
    llmResponse.content ||
    (lang === "sw" ? "Asante kwa ujumbe wako." : "Thanks for your message.");
  return {
    kind: "text",
    reply: `${reply}\n\n[demo: indicators_collected=${indicators?.indicators_collected ?? 0}]`,
  };
}

router.post("/send", async (req: Request, res: Response): Promise<void> => {
  const { from = "+254711082200", action = "", text = "" } = req.body as {
    from?: string;
    action?: string;
    text?: string;
  };
  try {
    const result = await replyFor(from, action, text);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      kind: "text",
      reply: "ArdaLink: hitilafu ya demo. / Demo error. Try again.",
      error: String(err),
    });
  }
});

router.get("/simulator", (_req: Request, res: Response): void => {
  res.set("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArdaLink WhatsApp Simulator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 420px;
      margin: 0 auto;
      padding: 20px;
      background: #e5ddd5;
    }
    .phone {
      background: #fff;
      border-radius: 20px;
      padding: 20px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      min-height: 560px;
      display: flex;
      flex-direction: column;
    }
    .header { text-align: center; padding-bottom: 15px; border-bottom: 1px solid #eee; color: #25D366; font-weight: 600; }
    .chat { flex: 1; overflow-y: auto; padding: 15px 0; background: #e5ddd5; }
    .message { max-width: 80%; padding: 8px 12px; border-radius: 8px; margin: 5px 0; font-size: 14px; line-height: 1.4; word-wrap: break-word; white-space: pre-wrap; }
    .message.in { background: #dcf8c6; margin-left: auto; border-bottom-right-radius: 0; }
    .message.out { background: #fff; margin-right: auto; border-bottom-left-radius: 0; }
    .options { display: flex; flex-direction: column; gap: 6px; margin: 5px 0; }
    .option-btn { padding: 8px 12px; background: #fff; border: 1px solid #25D366; border-radius: 8px; color: #075E54; text-align: left; cursor: pointer; font-size: 13px; }
    .option-btn:hover { background: #f0fdf4; }
    .input-area { display: flex; gap: 10px; padding-top: 15px; border-top: 1px solid #eee; }
    .input-area input { flex: 1; padding: 10px 15px; border: 1px solid #ddd; border-radius: 20px; font-size: 14px; }
    .input-area button { padding: 10px 20px; background: #25D366; color: white; border: none; border-radius: 20px; cursor: pointer; font-weight: 600; }
    .status { text-align: center; font-size: 11px; color: #999; padding: 5px 0; }
  </style>
</head>
<body>
  <div class="phone">
    <div class="header">ArdaLink WhatsApp (demo)</div>
    <div class="chat" id="chat"></div>
    <div class="input-area">
      <input type="text" id="input" placeholder="Type a message...">
      <button onclick="sendMessage()">Send</button>
    </div>
    <div class="status" id="status">Ready — send any message to start</div>
  </div>

  <script>
    const phoneNumber = '+254711082200';

    function addMessage(text, direction) {
      const chat = document.getElementById('chat');
      const msg = document.createElement('div');
      msg.className = 'message ' + direction;
      msg.textContent = text;
      chat.appendChild(msg);
      chat.scrollTop = chat.scrollHeight;
    }

    function addOptions(options) {
      const chat = document.getElementById('chat');
      const wrap = document.createElement('div');
      wrap.className = 'options';
      for (const opt of options) {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.textContent = opt.title + (opt.description ? ' — ' + opt.description : '');
        btn.onclick = () => sendAction(opt.id, opt.title);
        wrap.appendChild(btn);
      }
      chat.appendChild(wrap);
      chat.scrollTop = chat.scrollHeight;
    }

    function addLocations(locations) {
      const chat = document.getElementById('chat');
      for (const loc of locations) {
        const msg = document.createElement('div');
        msg.className = 'message out';
        msg.textContent = '📍 ' + loc.name + ' (' + loc.lat.toFixed(4) + ', ' + loc.lon.toFixed(4) + ')';
        chat.appendChild(msg);
      }
      chat.scrollTop = chat.scrollHeight;
    }

    async function post(body) {
      document.getElementById('status').textContent = 'Sending...';
      const response = await fetch('/api/demo/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (data.kind === 'list') {
        addMessage(data.reply, 'out');
        addOptions(data.options || []);
      } else if (data.kind === 'locations') {
        addMessage(data.reply, 'out');
        addLocations(data.locations || []);
      } else {
        addMessage(data.reply, 'out');
      }
      document.getElementById('status').textContent = 'Connected';
    }

    function sendAction(action, title) {
      addMessage(title, 'in');
      post({ from: phoneNumber, action, text: title }).catch((err) => {
        addMessage('Error: ' + err.message, 'out');
      });
    }

    function sendMessage() {
      const input = document.getElementById('input');
      const text = input.value.trim();
      if (!text) return;
      addMessage(text, 'in');
      input.value = '';
      post({ from: phoneNumber, action: '', text }).catch((err) => {
        addMessage('Error: ' + err.message, 'out');
      });
    }

    document.getElementById('input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  </script>
</body>
</html>
  `);
});

export default router;
