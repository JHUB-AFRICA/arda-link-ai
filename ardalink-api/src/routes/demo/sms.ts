/**
 * Demo SMS Simulator — Web UI for testing SMS flows without Africa's Talking.
 *
 * This route provides a web-based simulator for SMS interactions.
 * It allows testing the full SMS keyword flow without needing a real
 * SMS gateway or mobile phone.
 *
 * Endpoints:
 * - GET /api/demo/sms/simulator  → HTML page with SMS simulator UI
 * - POST /api/demo/sms/send      → Process SMS keyword and return response
 * - GET /api/demo/sms/history    → Get SMS conversation history
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { resolveHerderContext, buildLocalizedBrief } from "../../lib/herderContext";
import { centroidForTenant, formatUssdLines } from "../../lib/wpdx";

const router: IRouter = Router();

const DEMO_TENANT_ID = process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

// Deterministic SMS keyword handler. No LLM in the interaction loop —
// every response is a fixed template filled with fresh ward numbers and
// the herder's specific context (if their phone is in `pastoralists`).
function classifyKeyword(text: string): string {
  const t = text.trim().toLowerCase();
  if (!t) return "help";
  if (/^bula|^malisho\s*brief|^brief/i.test(t)) return "bula";
  if (/^malisho|^water|^maji/i.test(t)) return "malisho";
  if (/^ongea|^call|^piga/i.test(t)) return "ongea";
  if (/^ripoti|^my ?report|^last/i.test(t)) return "ripoti";
  if (/^stop|^opt.?out|^acha/i.test(t)) return "stop";
  return "help";
}

async function replyFor(from: string, text: string): Promise<{ intent: string; reply: string; ended: boolean }> {
  const intent = classifyKeyword(text);
  const ctx = await resolveHerderContext(from, DEMO_TENANT_ID);
  if (intent === "bula") {
    return {
      intent,
      reply: buildLocalizedBrief(ctx, "sw"),
      ended: false,
    };
  }
  if (intent === "malisho") {
    // Nearest 5 water points from the WPDx snapshot, ranked with
    // working infrastructure first. SMS body caps around 160 chars so
    // the lines are already truncated by the helper.
    const origin =
      centroidForTenant(DEMO_TENANT_ID) ?? { lat: 0.3453, lon: 37.5810 };
    const lines = formatUssdLines(origin, 5, { workingFirst: true });
    const body =
      lines.length > 0
        ? lines.join("; ")
        : "Hakuna data ya WPDx bado / no WPDx data yet";
    return {
      intent,
      reply: "Malisho karibu nawe: " + body,
      ended: false,
    };
  }
  if (intent === "ongea") {
    return {
      intent,
      reply:
        "Sawa. ArdaLink atapiga simu hivi karibuni / We will call you shortly to record your report.",
      ended: false,
    };
  }
  if (intent === "ripoti") {
    if (!ctx.known || ctx.lastBcsScore == null) {
      return {
        intent,
        reply: "Hakuna ripoti bado / No report on file yet. Text ONGEA to request a voice call.",
        ended: false,
      };
    }
    return {
      intent,
      reply:
        `Ripoti yako ya mwisho: BCS ${ctx.lastBcsScore.toFixed(1)} (${ctx.lastBcsSpecies ?? "?"}), ` +
        `${ctx.lastActionTag ?? "no tag"}. ${ctx.lastReportedLocation ? "Ulisema uko " + ctx.lastReportedLocation + "." : ""}`.slice(0, 300),
      ended: false,
    };
  }
  if (intent === "stop") {
    return {
      intent,
      reply: "Umeondolewa kwenye orodha / You have been opted out. Text START to rejoin.",
      ended: true,
    };
  }
  return {
    intent: "help",
    reply:
      "ArdaLink SMS: BULA (brief), MALISHO (water), ONGEA (voice call), RIPOTI (my last report), STOP (opt out).",
    ended: false,
  };
}

interface SmsMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: Date;
  direction: "in" | "out";
}

interface SmsConversation {
  phone: string;
  messages: SmsMessage[];
  createdAt: Date;
  lastActivity: Date;
}

const conversations = new Map<string, SmsConversation>();

function getOrCreateConversation(phone: string): SmsConversation {
  let conv = conversations.get(phone);
  if (!conv) {
    conv = {
      phone,
      messages: [],
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    conversations.set(phone, conv);
  }
  conv.lastActivity = new Date();
  return conv;
}

/**
 * GET /api/demo/sms/simulator
 *
 * Returns an HTML page with an interactive SMS simulator.
 */
router.get("/simulator", (_req: Request, res: Response): void => {
  res.set("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArdaLink SMS Simulator</title>
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
      min-height: 500px;
      display: flex;
      flex-direction: column;
    }
    .header {
      text-align: center;
      padding-bottom: 15px;
      border-bottom: 1px solid #eee;
      color: #128C7E;
      font-weight: 600;
    }
    .chat {
      flex: 1;
      overflow-y: auto;
      padding: 15px 0;
      background: #e5ddd5;
    }
    .message {
      max-width: 80%;
      padding: 8px 12px;
      border-radius: 8px;
      margin: 5px 0;
      font-size: 14px;
      line-height: 1.4;
      word-wrap: break-word;
    }
    .message.in {
      background: #fff;
      margin-left: auto;
      border-bottom-right-radius: 0;
    }
    .message.out {
      background: #dcf8c6;
      margin-right: auto;
      border-bottom-left-radius: 0;
    }
    .message .time {
      font-size: 10px;
      color: #999;
      margin-top: 4px;
      text-align: right;
    }
    .input-area {
      display: flex;
      gap: 10px;
      padding-top: 15px;
      border-top: 1px solid #eee;
    }
    .input-area input {
      flex: 1;
      padding: 10px 15px;
      border: 1px solid #ddd;
      border-radius: 20px;
      font-size: 14px;
    }
    .input-area button {
      padding: 10px 20px;
      background: #128C7E;
      color: white;
      border: none;
      border-radius: 20px;
      cursor: pointer;
      font-weight: 600;
    }
    .keywords {
      padding: 10px 0;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .keyword-btn {
      padding: 6px 12px;
      background: #f0f0f0;
      border: 1px solid #ddd;
      border-radius: 15px;
      font-size: 12px;
      cursor: pointer;
      color: #666;
    }
    .keyword-btn:hover {
      background: #e0e0e0;
    }
    .status {
      text-align: center;
      font-size: 11px;
      color: #999;
      padding: 5px 0;
    }
  </style>
</head>
<body>
  <div class="phone">
    <div class="header">ArdaLink SMS</div>
    <div class="chat" id="chat"></div>
    <div class="keywords">
      <button class="keyword-btn" onclick="sendKeyword('BULA')">BULA</button>
      <button class="keyword-btn" onclick="sendKeyword('MALISHO')">MALISHO</button>
      <button class="keyword-btn" onclick="sendKeyword('ONGEA')">ONGEA</button>
      <button class="keyword-btn" onclick="sendKeyword('STOP')">STOP</button>
    </div>
    <div class="input-area">
      <input type="text" id="input" placeholder="Type a message...">
      <button onclick="sendMessage()">Send</button>
    </div>
    <div class="status" id="status">Ready</div>
  </div>

  <script>
    const phoneNumber = '+254711082200';
    const serviceNumber = '22334';

    function formatTime() {
      const now = new Date();
      return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    function addMessage(text, direction) {
      const chat = document.getElementById('chat');
      const msg = document.createElement('div');
      msg.className = 'message ' + direction;
      msg.innerHTML = text + '<div class="time">' + formatTime() + '</div>';
      chat.appendChild(msg);
      chat.scrollTop = chat.scrollHeight;
    }

    function sendKeyword(keyword) {
      document.getElementById('input').value = keyword;
      sendMessage();
    }

    async function sendMessage() {
      const input = document.getElementById('input');
      const text = input.value.trim();
      if (!text) return;

      addMessage(text, 'in');
      input.value = '';
      document.getElementById('status').textContent = 'Sending...';

      try {
        const response = await fetch('/api/demo/sms/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: phoneNumber,
            to: serviceNumber,
            text: text
          })
        });

        const data = await response.json();
        if (data.reply) {
          addMessage(data.reply, 'out');
        }
        document.getElementById('status').textContent = data.ended ? 'Conversation ended' : 'Connected';
      } catch (err) {
        addMessage('Error: ' + err.message, 'out');
        document.getElementById('status').textContent = 'Error';
      }
    }

    document.getElementById('input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });

    // Add welcome message
    addMessage('Welcome to ArdaLink SMS. Try keywords: BULA, MALISHO, ONGEA', 'out');
  </script>
</body>
</html>
  `);
});

/**
 * POST /api/demo/sms/send
 *
 * Processes SMS keyword and returns the response.
 */
router.post("/send", async (req: Request, res: Response): Promise<void> => {
  const { from = "+254711082200", to = "22334", text = "" } = req.body as {
    from?: string;
    to?: string;
    text?: string;
  };

  try {
    const conv = getOrCreateConversation(from);

    // Record incoming message
    conv.messages.push({
      id: `msg_${Date.now()}_in`,
      from,
      to,
      text,
      timestamp: new Date(),
      direction: "in",
    });

    // Deterministic: no LLM in the interaction loop.
    const { intent, reply, ended } = await replyFor(from, text);

    if (reply) {
      conv.messages.push({
        id: `msg_${Date.now()}_out`,
        from: to,
        to: from,
        text: reply,
        timestamp: new Date(),
        direction: "out",
      });
    }

    res.json({
      from,
      to,
      keyword: intent,
      reply,
      ended,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(500).json({
      error: "sms_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /api/demo/sms/history?phone=...
 *
 * Get SMS conversation history.
 */
router.get("/history", (req: Request, res: Response): void => {
  const phone = (req.query.phone as string) ?? "+254711082200";
  const conv = conversations.get(phone);

  if (!conv) {
    res.json({ phone, messages: [] });
    return;
  }

  res.json({
    phone: conv.phone,
    messages: conv.messages,
    createdAt: conv.createdAt,
    lastActivity: conv.lastActivity,
  });
});

/**
 * DELETE /api/demo/sms/conversation?phone=...
 *
 * Clear a conversation (for testing).
 */
router.delete("/conversation", (req: Request, res: Response): void => {
  const phone = (req.query.phone as string) ?? "+254711082200";
  conversations.delete(phone);
  res.json({ cleared: true });
});

export default router;
