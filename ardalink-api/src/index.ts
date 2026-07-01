import "dotenv/config";
import { WebSocketServer } from "ws";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { handleVoiceStream } from "./lib/voiceStream.js";
import { handleBrowserVoiceStream } from "./lib/voiceStreamBrowser.js";
import { startScheduler } from "./lib/scheduler.js";
import { startSatelliteJob } from "./jobs/index.js";
import { consumeToken } from "./lib/callTokens.js";
import { isTrustedOrigin } from "./lib/originGuard.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── HTTP server ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

const httpServer = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info(
    {
      port,
      routes: [
        "POST /api/trigger-check",
        "GET  /api/status",
        "POST /api/voice-callback",
        "WS   /api/voice-stream  ← OpenAI Realtime bridge (AT)",
        "WS   /api/browser-voice-stream  ← OpenAI Realtime bridge (Browser)",
        "GET  /api/healthz",
      ],
    },
    "ArdaLink AI server listening",
  );

  // Hydrate from PostgreSQL cache and start background refresh loops.
  // Non-blocking — server accepts traffic immediately while this warms up.
  void startScheduler().catch((err) =>
    logger.error({ err }, "Scheduler bootstrap failed"),
  );

  // Start the satellite GEE refresh job on seasonal schedule.
  // Non-blocking — runs in background.
  try {
    startSatelliteJob();
  } catch (err) {
    logger.error({ err }, "Satellite job bootstrap failed");
  }
});

// ── WebSocket upgrade handler ──────────────────────────────────────────────
// Africa's Talking opens a WebSocket here after /api/voice-callback returns
// a <Stream> instruction. We bridge it directly to Azure OpenAI Realtime.
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "https://localhost");

  if (url.pathname === "/api/voice-stream") {
    const phone = decodeURIComponent(url.searchParams.get("phone") ?? "");

    wss.handleUpgrade(req, socket, head, (ws) => {
      logger.info({ phone }, "WebSocket upgrade accepted for voice-stream");
      handleVoiceStream(ws, phone);
    });
  } else if (url.pathname === "/api/browser-voice-stream") {
    // Validate Origin to prevent abuse from arbitrary external sites
    // consuming our Azure Realtime credits. Browsers always include Origin
    // on WebSocket upgrades, so an empty / missing Origin is treated as
    // untrusted (typically a curl or server-to-server probe).
    const origin = req.headers.origin;
    if (!isTrustedOrigin(origin)) {
      logger.warn(
        { origin },
        "Browser voice WS upgrade rejected — untrusted origin",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Single-use token enforcement: every connection (operator-initiated from
    // the dashboard OR recipient-initiated from a shared link) must present a
    // freshly minted token. The token is consumed atomically here, so the same
    // shared link cannot be reused or replayed by anyone. The phone (if any)
    // bound to the token at mint time is recovered here and passed to the
    // voice stream so ground-truth attribution works for public callers.
    const token = url.searchParams.get("token");
    const consumed = consumeToken(token);
    if (!consumed.ok) {
      logger.warn(
        { origin, hasToken: token != null },
        "Browser voice WS upgrade rejected — token missing / expired / already used",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      logger.info(
        { origin, hasPhone: consumed.phone != null },
        "WebSocket upgrade accepted for browser-voice-stream",
      );
      handleBrowserVoiceStream(ws, consumed.phone, token);
    });
  } else {
    logger.warn(
      { pathname: url.pathname },
      "WebSocket upgrade rejected — unknown path",
    );
    socket.destroy();
  }
});
