/**
 * Demo USSD Simulator — Web UI for testing USSD flows without Africa's Talking.
 *
 * This route provides a web-based simulator for USSD interactions.
 * It allows testing the full USSD menu flow without needing a real
 * USSD gateway or feature phone.
 *
 * Endpoints:
 * - GET /api/demo/ussd/simulator  → HTML page with USSD simulator UI
 * - POST /api/demo/ussd/input     → Process USSD input and return response
 * - GET /api/demo/ussd/state      → Get current session state
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  parseUssdInput,
  generateAiResponse,
  loadIntelligenceContext,
  type ParsedInput,
  type AiResponse,
} from "../../lib/channels/intelligenceCore";
import { UssdAdapter } from "../../lib/channels/adapters";

const router: IRouter = Router();

// In-memory session store for demo
interface DemoSession {
  phone: string;
  screenHistory: string[];
  currentScreen: string;
  inputHistory: string[];
  createdAt: Date;
  lastActivity: Date;
}

const sessions = new Map<string, DemoSession>();

function getOrCreateSession(phone: string): DemoSession {
  let session = sessions.get(phone);
  if (!session) {
    session = {
      phone,
      screenHistory: [],
      currentScreen: "",
      inputHistory: [],
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    sessions.set(phone, session);
  }
  session.lastActivity = new Date();
  return session;
}

/**
 * GET /api/demo/ussd/simulator
 *
 * Returns an HTML page with an interactive USSD simulator.
 */
router.get("/simulator", (_req: Request, res: Response): void => {
  res.set("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArdaLink USSD Simulator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      max-width: 400px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .phone {
      background: #333;
      border-radius: 30px;
      padding: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.3);
    }
    .screen {
      background: #c0c0c0;
      border: 4px solid #666;
      border-radius: 10px;
      min-height: 200px;
      padding: 15px;
      margin-bottom: 15px;
      font-size: 14px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .screen-text { color: #000; }
    .input-area {
      display: flex;
      gap: 10px;
      margin-top: 15px;
    }
    .input-area input {
      flex: 1;
      padding: 10px;
      font-size: 18px;
      text-align: center;
      border: none;
      border-radius: 5px;
    }
    .input-area button {
      padding: 10px 20px;
      font-size: 16px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 5px;
      cursor: pointer;
    }
    .input-area button:hover { background: #45a049; }
    .phone-number {
      text-align: center;
      color: #0f0;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .status {
      text-align: center;
      color: #0f0;
      font-size: 11px;
      margin-top: 10px;
    }
    .keypad {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-top: 15px;
    }
    .keypad button {
      padding: 15px;
      font-size: 18px;
      background: #555;
      color: white;
      border: none;
      border-radius: 5px;
      cursor: pointer;
    }
    .keypad button:hover { background: #666; }
    .keypad button.action-btn { background: #4CAF50; }
    .keypad button.back-btn { background: #f44336; }
    .history {
      background: #444;
      color: #0f0;
      padding: 10px;
      border-radius: 5px;
      margin-top: 15px;
      font-size: 11px;
      max-height: 100px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <div class="phone">
    <div class="phone-number">+254711082200</div>
    <div class="screen">
      <div id="screen" class="screen-text">Loading...</div>
    </div>
    <div class="input-area">
      <input type="text" id="input" placeholder="#" maxlength="2">
      <button onclick="sendInput()">Send</button>
    </div>
    <div class="keypad">
      <button onclick="pressKey('1')">1</button>
      <button onclick="pressKey('2')">2</button>
      <button onclick="pressKey('3')">3</button>
      <button onclick="pressKey('4')">4</button>
      <button onclick="pressKey('0')">0</button>
      <button onclick="pressKey('*')">*</button>
      <button class="back-btn" onclick="clearInput()">C</button>
      <button class="action-btn" onclick="dial()">DIAL</button>
    </div>
    <div class="status" id="status">Ready</div>
    <div class="history" id="history">
      <div>DIAL *123*8# to start</div>
    </div>
  </div>

  <script>
    const phoneNumber = '+254711082200';
    let currentInput = '';
    let dialed = false;

    function pressKey(key) {
      if (currentInput.length < 2) {
        currentInput += key;
        document.getElementById('input').value = currentInput;
      }
    }

    function clearInput() {
      currentInput = '';
      document.getElementById('input').value = '';
    }

    function dial() {
      dialed = true;
      sendInput('');
    }

    async function sendInput() {
      const input = document.getElementById('input').value || currentInput;
      document.getElementById('status').textContent = 'Sending...';

      try {
        const response = await fetch('/api/demo/ussd/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: phoneNumber,
            text: dialed ? input : '',
            dial: dialed && !currentInput
          })
        });

        const data = await response.json();
        document.getElementById('screen').textContent = data.display;
        document.getElementById('status').textContent = data.ended ? 'Session Ended' : 'Connected';
        document.getElementById('history').innerHTML += '<div>> ' + (input || '*123*8#') + '</div>';

        if (data.ended) {
          document.getElementById('history').innerHTML += '<div style="color: #ff0">Session ended. Redial to restart.</div>';
          dialed = false;
        }

        clearInput();
      } catch (err) {
        document.getElementById('screen').textContent = 'Error: ' + err.message;
        document.getElementById('status').textContent = 'Error';
      }
    }

    // Auto-dial on load for demo
    window.onload = () => dial();
  </script>
</body>
</html>
  `);
});

/**
 * POST /api/demo/ussd/input
 *
 * Processes USSD input and returns the next screen.
 */
router.post("/input", async (req: Request, res: Response): Promise<void> => {
  const { phone = "+254711082200", text = "", dial = false } = req.body as {
    phone?: string;
    text?: string;
    dial?: boolean;
  };

  try {
    const session = getOrCreateSession(phone);
    const inputHistory = [...session.inputHistory];

    // If this is a dial (first interaction), start fresh
    const effectiveText = dial ? "" : text;

    // Parse input
    const parsed: ParsedInput = parseUssdInput(phone, effectiveText);

    // Load intelligence context
    const intelContext = loadIntelligenceContext();

    // Generate AI response
    const aiResponse: AiResponse = await generateAiResponse(parsed, intelContext);

    // Format for USSD
    const formatted = UssdAdapter.format(aiResponse);

    // Update session
    session.screenHistory.push(formatted);
    session.currentScreen = formatted;
    session.inputHistory.push(effectiveText);

    res.json({
      phone,
      display: formatted,
      ended: aiResponse.ended,
      inputHistory: session.inputHistory,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(500).json({
      error: "ussd_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /api/demo/ussd/state?phone=...
 *
 * Get current session state for debugging.
 */
router.get("/state", (req: Request, res: Response): void => {
  const phone = (req.query.phone as string) ?? "+254711082200";
  const session = sessions.get(phone);

  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }

  res.json({
    phone: session.phone,
    screenHistory: session.screenHistory,
    currentScreen: session.currentScreen,
    inputHistory: session.inputHistory,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
  });
});

/**
 * DELETE /api/demo/ussd/session?phone=...
 *
 * Clear a session (for testing).
 */
router.delete("/session", (req: Request, res: Response): void => {
  const phone = (req.query.phone as string) ?? "+254711082200";
  sessions.delete(phone);
  res.json({ cleared: true });
});

export default router;
