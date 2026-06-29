import { logger } from "./logger.js";
import type { VegetationDelta } from "./baseline.js";
import type { ClimateSnapshot } from "./climate.js";
import type { VegetationForecast } from "./predict.js";

// ── Africa's Talking Voice API ──────────────────────────────────────────────
// Note: AT retired voice.sandbox.africastalking.com — both sandbox and
// production now use the same hostname. Sandbox mode is determined entirely
// by the credentials (username=sandbox + sandbox apiKey).
const AT_BASE = "https://voice.africastalking.com";

export async function initiateCall(phone: string): Promise<void> {
  const from = process.env.AFRICASTALKING_CALLER_ID ?? "+254711082200";
  const callbackUrl = `https://${process.env.REPLIT_DEV_DOMAIN}/api/voice-callback`;

  const body = new URLSearchParams({
    username: process.env.AFRICASTALKING_USERNAME!,
    to: phone,
    from,
    callbackUrl,
  });

  const res = await fetch(`${AT_BASE}/call`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      apiKey: process.env.AFRICASTALKING_API_KEY!,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Africa's Talking call failed: ${JSON.stringify(data)}`);
  }
  logger.info(
    { phone, callbackUrl, response: data },
    "[Call Triggered] Outbound call initiated",
  );
}

// ── In-memory call session store ───────────────────────────────────────────
// Bridges intelligence cycle → WebSocket handler.
// Keyed by herder phone number.
export interface CallSession {
  script: string; // Pre-generated opening guidance for Realtime system prompt
  question: string; // Specific question to ask based on satellite data
  delta: VegetationDelta;
  month: string;
  climate?: ClimateSnapshot; // Real-time temperature, rainfall, soil moisture, MAI
  forecast?: VegetationForecast; // 14-day vegetation stress outlook
  createdAt: Date;
}

const sessions = new Map<string, CallSession>();

export function storeCallSession(
  phone: string,
  session: Omit<CallSession, "createdAt">,
): void {
  sessions.set(phone, { ...session, createdAt: new Date() });
}

export function getCallSession(phone: string): CallSession | undefined {
  return sessions.get(phone);
}

export function clearCallSession(phone: string): void {
  sessions.delete(phone);
}
