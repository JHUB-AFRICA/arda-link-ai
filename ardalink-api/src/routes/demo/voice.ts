/**
 * Demo Voice Simulator — Web UI for testing voice flows without Africa's Talking.
 *
 * This route provides a web-based simulator for voice interactions.
 * It allows testing the full voice conversation flow without needing
 * real phone calls or Africa's Talking Voice API.
 *
 * Endpoints:
 * - GET /api/demo/voice/simulator  → HTML page with voice simulator UI
 * - POST /api/demo/voice/start     → Start a voice session
 * - POST /api/demo/voice/message   → Send a transcript message (simulating speech)
 * - GET /api/demo/voice/state      → Get current session state
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  parseVoiceInput,
  generateAiResponse,
  loadIntelligenceContext,
  createSession,
  updateSession,
  endSession,
  getSession,
  type ParsedInput,
} from "../../lib/channels/intelligenceCore.ts";
import { VoiceAdapter } from "../../lib/channels/adapters.ts";

const router: IRouter = Router();

/**
 * GET /api/demo/voice/simulator
 *
 * Returns an HTML page with an interactive voice simulator.
 */
router.get("/simulator", (_req: Request, res: Response): void => {
  res.set("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArdaLink Voice Simulator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 500px;
      margin: 0 auto;
      padding: 20px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #fff;
    }
    .phone {
      background: #2d2d44;
      border-radius: 30px;
      padding: 25px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      min-height: 400px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid #444;
    }
    .header h1 {
      font-size: 18px;
      margin: 0;
      color: #4ade80;
    }
    .status {
      font-size: 12px;
      color: #888;
    }
    .status.connected { color: #4ade80; }
    .status.calling { color: #fbbf24; }
    .status.ended { color: #ef4444; }
    .conversation {
      min-height: 250px;
      max-height: 400px;
      overflow-y: auto;
      padding: 20px 0;
    }
    .message {
      margin: 15px 0;
      padding: 15px;
      border-radius: 15px;
      font-size: 14px;
      line-height: 1.5;
    }
    .message.ai {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      border-bottom-left-radius: 5px;
    }
    .message.herder {
      background: #3d3d5c;
      border-bottom-right-radius: 5px;
      margin-left: auto;
      max-width: 85%;
    }
    .message .speaker {
      font-size: 11px;
      opacity: 0.7;
      margin-bottom: 5px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .controls {
      display: flex;
      gap: 15px;
      padding-top: 20px;
      border-top: 1px solid #444;
    }
    .btn {
      flex: 1;
      padding: 15px;
      border: none;
      border-radius: 15px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-call { background: #22c55e; color: #fff; }
    .btn-call:hover:not(:disabled) { background: #16a34a; }
    .btn-hangup { background: #ef4444; color: #fff; }
    .btn-hangup:hover:not(:disabled) { background: #dc2626; }
    .btn-mute { background: #6b7280; color: #fff; }
    .input-area {
      display: flex;
      gap: 10px;
      padding-top: 15px;
    }
    .input-area input {
      flex: 1;
      padding: 10px 15px;
      border: none;
      border-radius: 20px;
      background: #3d3d5c;
      color: #fff;
      font-size: 14px;
    }
    .input-area button {
      padding: 10px 20px;
      background: #4ade80;
      border: none;
      border-radius: 20px;
      cursor: pointer;
    }
    .transcript-hint {
      font-size: 11px;
      color: #888;
      text-align: center;
      padding: 10px 0;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .recording { animation: pulse 1.5s infinite; }
  </style>
</head>
<body>
  <div class="phone">
    <div class="header">
      <h1>🌾 ArdaLink Voice</h1>
      <span class="status" id="status">Ready</span>
    </div>
    <div class="conversation" id="conversation">
      <div class="message ai">
        <div class="speaker">ArdaLink AI</div>
        <div>Press "Start Call" to begin a simulated voice conversation with ArdaLink.</div>
      </div>
    </div>
    <div class="controls">
      <button class="btn btn-call" id="callBtn" onclick="toggleCall()">Start Call</button>
      <button class="btn btn-mute" id="muteBtn" disabled onclick="toggleMute()">Mute</button>
      <button class="btn btn-hangup" id="hangupBtn" disabled onclick="hangup()">Hang Up</button>
    </div>
    <div class="transcript-hint" id="hint">Type below to simulate speech (or use quick responses)</div>
    <div class="input-area">
      <input type="text" id="input" placeholder="Type your response as if speaking...">
      <button onclick="sendTranscript()">Send</button>
    </div>
    <div style="display: flex; gap: 8px; padding-top: 10px; flex-wrap: wrap;">
      <button class="keyword-btn" onclick="quickReply('Sawa,iko po nyasi nzuri?')">Good pasture?</button>
      <button class="keyword-btn" onclick="quickReply('Niko Ngare Mara')">At Ngare Mara</button>
      <button class="keyword-btn" onclick="quickReply('Nina ng'ombe na mbuzi')">Cattle & goats</button>
      <button class="keyword-btn" onclick="quickReply('Maji ni machafu')">Dirty water</button>
    </div>
  </>

  <style>
    .keyword-btn {
      padding: 6px 12px;
      background: #3d3d5c;
      border: 1px solid #555;
      border-radius: 15px;
      font-size: 11px;
      cursor: pointer;
      color: #aaa;
    }
    .keyword-btn:hover { background: #4d4d6c; }
  </style>

  <script>
    const phoneNumber = '+254711082200';
    let inCall = false;
    let muted = false;
    let currentQuestion = '';

    function addMessage(text, speaker, isAi = false) {
      const conv = document.getElementById('conversation');
      const msg = document.createElement('div');
      msg.className = 'message ' + (isAi ? 'ai' : 'herder');
      msg.innerHTML = '<div class="speaker">' + speaker + '</div><div>' + text + '</div>';
      conv.appendChild(msg);
      conv.scrollTop = conv.scrollHeight;
    }

    function setStatus(text, className = '') {
      const status = document.getElementById('status');
      status.textContent = text;
      status.className = 'status ' + className;
    }

    async function toggleCall() {
      if (!inCall) {
        await startCall();
      }
    }

    async function startCall() {
      inCall = true;
      document.getElementById('callBtn').textContent = 'Calling...';
      document.getElementById('callBtn').disabled = true;
      setStatus('Calling...', 'calling');

      try {
        const response = await fetch('/api/demo/voice/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: phoneNumber })
        });

        const data = await response.json();

        if (data.started) {
          inCall = true;
          document.getElementById('callBtn').style.display = 'none';
          document.getElementById('muteBtn').disabled = false;
          document.getElementById('hangupBtn').disabled = false;
          setStatus('Connected', 'connected');

          // Clear conversation and show AI greeting
          document.getElementById('conversation').innerHTML = '';
          addMessage(data.greeting || 'Habari! Mimi ni ArdaLink.', 'ArdaLink AI', true);

          if (data.question) {
            currentQuestion = data.question;
            addMessage(data.question, 'ArdaLink AI', true);
          }
        }
      } catch (err) {
        setStatus('Failed to connect', 'ended');
        inCall = false;
        document.getElementById('callBtn').disabled = false;
        addMessage('Connection failed: ' + err.message, 'System', false);
      }
    }

    async function sendTranscript() {
      const input = document.getElementById('input');
      const text = input.value.trim();
      if (!text || !inCall) return;

      // Add herder message to conversation
      addMessage(text, 'Herder', false);
      input.value = '';

      try {
        const response = await fetch('/api/demo/voice/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: phoneNumber,
            transcript: text,
            previousQuestion: currentQuestion
          })
        });

        const data = await response.json();

        if (data.response) {
          addMessage(data.response, 'ArdaLink AI', true);
        }

        if (data.question) {
          currentQuestion = data.question;
          addMessage(data.question, 'ArdaLink AI', true);
        }

        if (data.shouldEnd) {
          hangup();
        }
      } catch (err) {
        addMessage('Error: ' + err.message, 'System', false);
      }
    }

    function quickReply(text) {
      document.getElementById('input').value = text;
      sendTranscript();
    }

    function toggleMute() {
      muted = !muted;
      const btn = document.getElementById('muteBtn');
      btn.textContent = muted ? 'Unmute' : 'Mute';
      btn.style.background = muted ? '#dc2626' : '#6b7280';
    }

    function hangup() {
      inCall = false;
      document.getElementById('callBtn').style.display = '';
      document.getElementById('callBtn').textContent = 'Start Call';
      document.getElementById('callBtn').disabled = false;
      document.getElementById('muteBtn').disabled = true;
      document.getElementById('muteBtn').textContent = 'Mute';
      document.getElementById('hangupBtn').disabled = true;
      setStatus('Call ended', 'ended');
      currentQuestion = '';

      fetch('/api/demo/voice/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phoneNumber })
      }).catch(() => {});

      addMessage('Call ended. Thank you for speaking with ArdaLink.', 'System', false);
    }

    document.getElementById('input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendTranscript();
    });
  </script>
</body>
</html>
  `);
});

/**
 * POST /api/demo/voice/start
 *
 * Starts a voice session and returns the initial greeting.
 */
router.post("/start", async (req: Request, res: Response): Promise<void> => {
  const { phone = "+254711082200" } = req.body as { phone?: string };

  try {
    // Create session
    const session = createSession(phone, "voice");

    // Load intelligence context
    const intelContext = loadIntelligenceContext();

    // Generate opening script using the existing intelligence result
    const lastResult = intelContext.lastResult;
    let greeting = "Habari! Mimi ni ArdaLink, msimamizi wa malisho.";
    let question = "Uko wapi leo na mifugo yako?";

    if (lastResult?.script) {
      greeting = lastResult.script.script;
      question = lastResult.script.question;
    } else {
      // Fallback greeting
      greeting = "Habari yako! Mimi ni ArdaLink. Tunafanya kazi ya kufuatilia hali ya malisho kupiga satellite.";
      question = "Uko wapi leo na unafuga mifugo aina gani?";
    }

    res.json({
      phone,
      started: true,
      sessionId: session.phone,
      greeting,
      question,
      satelliteAvailable: intelContext.satellite !== null,
    });
  } catch (err: unknown) {
    res.status(500).json({
      error: "voice_start_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /api/demo/voice/message
 *
 * Processes a transcript message (simulating speech recognition)
 * and returns the AI response.
 */
router.post("/message", async (req: Request, res: Response): Promise<void> => {
  const { phone = "+254711082200", transcript = "", previousQuestion } = req.body as {
    phone?: string;
    transcript?: string;
    previousQuestion?: string;
  };

  try {
    const session = getSession(phone);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    // Parse voice input
    const parsed: ParsedInput = parseVoiceInput(phone, transcript);

    // Load intelligence context
    const intelContext = loadIntelligenceContext();

    // Generate AI response
    const aiResponse = await generateAiResponse(parsed, intelContext, previousQuestion);

    // Format for voice
    const formatted = VoiceAdapter.format(aiResponse);

    // Update session
    updateSession(phone, {
      lastQuestion: formatted.question,
    });

    res.json({
      phone,
      response: formatted.text,
      question: formatted.question,
      shouldEnd: formatted.shouldEnd,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(500).json({
      error: "voice_message_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /api/demo/voice/end
 *
 * Ends a voice session.
 */
router.post("/end", (req: Request, res: Response): void => {
  const { phone = "+254711082200" } = req.body as { phone?: string };
  endSession(phone);
  res.json({ ended: true });
});

/**
 * GET /api/demo/voice/state?phone=...
 *
 * Get current session state.
 */
router.get("/state", (req: Request, res: Response): void => {
  const phone = (req.query.phone as string) ?? "+254711082200";
  const session = getSession(phone);

  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }

  res.json({
    phone: session.phone,
    channel: session.channel,
    startedAt: session.createdAt,
    lastInteraction: session.lastActivity,
    lastQuestion: session.lastQuestion,
    indicatorState: session.indicatorState,
  });
});

export default router;
