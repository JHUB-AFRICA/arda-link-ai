#!/usr/bin/env node
// scripts/sandbox-simulate.mjs
//
// Drive the AT webhooks locally so we can validate the full call +
// USSD + SMS flow without ngrok, a tunnel, or a live AT sandbox
// account. Each subcommand POSTs the EXACT payload shape AT sends
// in production to our own /api/* endpoints.
//
// Usage:
//   node scripts/sandbox-simulate.mjs ussd              # drive the USSD menu
//   node scripts/sandbox-simulate.mjs sms               # send BULA keyword
//   node scripts/sandbox-simulate.mjs voice             # fire a synthetic voice call
//   node scripts/sandbox-simulate.mjs all               # run all three in order
//   API_BASE=http://localhost:3000 node scripts/sandbox-simulate.mjs all
//
// Each step prints the request and the response so you can eyeball
// the whole flow.

import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.API_BASE || "http://127.0.0.1:3000";
const PHONE = process.env.SANDBOX_PHONE || "+254711082200";

function header(s) {
  console.log(`\n\x1b[1m\x1b[34m━━━ ${s} ━━━\x1b[0m`);
}

async function postForm(path, params) {
  const body = new URLSearchParams(params).toString();
  console.log(`  → POST ${BASE}${path}`);
  console.log(`     body: ${body}`);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  console.log(`  ← ${res.status} ${res.statusText}`);
  console.log(`     reply: ${text.replace(/\n/g, "\\n")}`);
  return { status: res.status, body: text };
}

async function postJson(path, body, bearer) {
  const json = JSON.stringify(body);
  console.log(`  → POST ${BASE}${path}`);
  console.log(`     body: ${json}`);
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: json,
  });
  const text = await res.text();
  console.log(`  ← ${res.status} ${res.statusText}`);
  console.log(`     reply: ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`);
  return { status: res.status, body: text };
}

// ── 1. USSD: walk the home menu → brief → swahili ─────────────────────────
async function simUssd() {
  header("USSD — full menu walk (Bula Pesa → Swahili brief)");
  await postForm("/api/ussd-callback", {
    sessionId: "AT-sandbox-ussd-001",
    serviceCode: "*123*8#",
    phoneNumber: PHONE,
    text: "",
  });
  await sleep(300);
  await postForm("/api/ussd-callback", {
    sessionId: "AT-sandbox-ussd-001",
    serviceCode: "*123*8#",
    phoneNumber: PHONE,
    text: "1",
  });
  await sleep(300);
  await postForm("/api/ussd-callback", {
    sessionId: "AT-sandbox-ussd-001",
    serviceCode: "*123*8#",
    phoneNumber: PHONE,
    text: "1*1",
  });
  await sleep(300);
  await postForm("/api/ussd-callback", {
    sessionId: "AT-sandbox-ussd-001",
    serviceCode: "*123*8#",
    phoneNumber: PHONE,
    text: "2",
  });
  await sleep(300);
  await postForm("/api/ussd-callback", {
    sessionId: "AT-sandbox-ussd-001",
    serviceCode: "*123*8#",
    phoneNumber: PHONE,
    text: "4",
  });
}

// ── 2. SMS: send BULA keyword ─────────────────────────────────────────────
async function simSms() {
  header("SMS — BULA keyword");
  await postForm("/api/sms-callback", {
    from: PHONE,
    to: "+254711082200",
    text: "BULA",
    id: "AT-sandbox-sms-001",
    date: new Date().toISOString(),
  });
  await sleep(300);
  await postForm("/api/sms-callback", {
    from: PHONE,
    to: "+254711082200",
    text: "MALISHO",
    id: "AT-sandbox-sms-002",
    date: new Date().toISOString(),
  });
  await sleep(300);
  await postForm("/api/sms-callback", {
    from: PHONE,
    to: "+254711082200",
    text: "STOP",
    id: "AT-sandbox-sms-003",
    date: new Date().toISOString(),
  });
}

// ── 3. Voice: fire an outbound call via /api/trigger-check, then simulate
//       AT hitting our voice-callback and voice-events webhooks ────────────
async function simVoice() {
  header("Voice — outbound call + AT callback simulation");

  // 3a. authenticate as the demo operator (the dashboard does this on
  //     login; trigger-check requires a Bearer token).
  const token = await loginAsOperator();
  if (!token) {
    console.log(`  (skipping trigger-check — no auth token; will still hit webhooks)`);
  } else {
    // 3b. fire the call. Without a real AT API key the call will fail at
    //     voice.africastalking.com but the trigger-check cycle itself runs
    //     end-to-end (satellite → AI brief → call attempt).
    await postJson(
      "/api/trigger-check",
      { phone: PHONE, dryRun: true, forceAlert: true },
      token,
    ).catch((e) => {
      console.log(`  (trigger-check expected to fail in sandbox — that's ok)`);
      console.log(`     ${e.message}`);
    });
  }

  await sleep(500);

  // 3c. simulate AT POSTing the voice callback (this is what fires when
  //     the call connects and AT asks us for instructions)
  await postForm("/api/voice-callback", {
    callerNumber: "+254711082200",
    destinationNumber: PHONE,
    sessionId: "AT-sandbox-call-001",
    direction: "outbound",
  });

  await sleep(500);

  // 3d. simulate AT POSTing a voice lifecycle event
  await postForm("/api/voice-events", {
    sessionId: "AT-sandbox-call-001",
    callSessionState: "completed",
    callerNumber: "+254711082200",
    destinationNumber: PHONE,
    durationInSeconds: "182",
    hangupCause: "NORMAL_CLEARING",
    amount: "4.20",
    currencyCode: "KES",
  });
}

async function loginAsOperator() {
  const email = process.env.OPERATOR_EMAIL || "bula-pesa@ardalink.test";
  const password = process.env.OPERATOR_PASSWORD || "bula-pesa";
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      console.log(`  login failed for ${email} (status ${res.status})`);
      return null;
    }
    const json = await res.json();
    const tok = json?.token;
    if (tok) console.log(`  logged in as ${email} (token ${tok.slice(0, 12)}…)`);
    return tok ?? null;
  } catch (e) {
    console.log(`  login request errored: ${e.message}`);
    return null;
  }
}

async function main() {
  const cmd = process.argv[2] || "all";
  console.log(`ArdaLink AT Sandbox Simulator`);
  console.log(`  API base: ${BASE}`);
  console.log(`  phone:    ${PHONE}`);

  // liveness probe first — fail fast if the API is not up
  try {
    const r = await fetch(`${BASE}/api/healthz`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    console.log(`  health:   ✓\n`);
  } catch (e) {
    console.error(`\x1b[31mFATAL: API at ${BASE} is not reachable.\x1b[0m`);
    console.error(`  → ${e.message}`);
    console.error(`  → Did you run \`make up\` first?`);
    process.exit(2);
  }

  if (cmd === "ussd") await simUssd();
  else if (cmd === "sms") await simSms();
  else if (cmd === "voice") await simVoice();
  else if (cmd === "all") {
    await simUssd();
    await simSms();
    await simVoice();
  } else {
    console.error(`Unknown subcommand: ${cmd}`);
    console.error(`Use one of: ussd | sms | voice | all`);
    process.exit(1);
  }

  console.log(`\n\x1b[32m✓ Sandbox simulation complete.\x1b[0m`);
}

main().catch((e) => {
  console.error(`\n\x1b[31mSimulator crashed: ${e.message}\x1b[0m`);
  process.exit(1);
});
