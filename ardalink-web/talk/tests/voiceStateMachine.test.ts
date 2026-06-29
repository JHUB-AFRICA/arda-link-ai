/**
 * Voice state-machine tests.
 *
 * The actual `BrowserVoiceClient` is tightly coupled to AudioContext,
 * WebSocket, and navigator.mediaDevices. To keep these tests pure and
 * fast, we test the allowed transitions in `src/lib/voiceState.ts`
 * directly — the same module the client consults.
 *
 * Contract (state diagram):
 *
 *   idle ──start──> connecting ──ws_open──> live
 *                                     │
 *                                     ├──ws_close──> stopped
 *                                     ├──ws_error──> error
 *                                     ├──mic_error──> error
 *                                     └──stop()──> stopped
 *
 *   live ──stop()──> stopped
 *   live ──ws_error──> error
 *
 * `stopped` and `error` are terminal — they cannot transition further
 * without a fresh client.
 */
import { describe, it, expect } from "vitest";
import {
  canTransition,
  isTerminal,
  nextState,
  type VoiceState,
  type VoiceEvent,
} from "../src/lib/voiceState";

const ALL_STATES: VoiceState[] = [
  "idle",
  "connecting",
  "live",
  "stopped",
  "error",
];

describe("voice state machine — terminal states", () => {
  it("'stopped' is terminal (no outgoing transitions)", () => {
    expect(isTerminal("stopped")).toBe(true);
    for (const s of ALL_STATES) {
      expect(canTransition("stopped", s)).toBe(false);
    }
  });

  it("'error' is terminal (no outgoing transitions)", () => {
    expect(isTerminal("error")).toBe(true);
    for (const s of ALL_STATES) {
      expect(canTransition("error", s)).toBe(false);
    }
  });

  it("'idle', 'connecting', 'live' are non-terminal", () => {
    expect(isTerminal("idle")).toBe(false);
    expect(isTerminal("connecting")).toBe(false);
    expect(isTerminal("live")).toBe(false);
  });
});

describe("voice state machine — happy path", () => {
  it("idle → connecting → live on (start, ws_open)", () => {
    expect(nextState("idle", "start")).toBe("connecting");
    expect(nextState("connecting", "ws_open")).toBe("live");
  });

  it("live → stopped on stop() or ws_close()", () => {
    expect(nextState("live", "stop")).toBe("stopped");
    expect(nextState("live", "ws_close")).toBe("stopped");
  });
});

describe("voice state machine — error edges", () => {
  it("ws_error from connecting or live lands in 'error'", () => {
    expect(nextState("connecting", "ws_error")).toBe("error");
    expect(nextState("live", "ws_error")).toBe("error");
  });

  it("mic_error from connecting lands in 'error'", () => {
    expect(nextState("connecting", "mic_error")).toBe("error");
  });

  it("stop() from any non-terminal state lands in 'stopped'", () => {
    expect(nextState("idle", "stop")).toBeNull(); // never started
    expect(nextState("connecting", "stop")).toBe("stopped");
    expect(nextState("live", "stop")).toBe("stopped");
  });
});

describe("voice state machine — illegal transitions are rejected", () => {
  const cases: Array<[VoiceState, VoiceEvent, VoiceState | null]> = [
    // Can't skip 'connecting' — start() must go through it.
    ["idle", "ws_open", null],
    ["idle", "ws_close", null],
    // ws_open from anything but 'connecting' is illegal.
    ["idle", "ws_open", null],
    ["live", "ws_open", null],
    ["stopped", "ws_open", null],
    ["error", "ws_open", null],
    // Can't restart from a terminal state via start().
    ["stopped", "start", null],
    ["error", "start", null],
    // ws_close from a terminal state is a no-op (already closed).
    ["stopped", "ws_close", null],
    ["error", "ws_close", null],
  ];

  for (const [from, event, expected] of cases) {
    it(`nextState('${from}', '${event}') === ${expected}`, () => {
      expect(nextState(from, event)).toBe(expected);
    });
  }
});

describe("voice state machine — canTransition matrix", () => {
  it("idle can only transition to connecting or error", () => {
    expect(canTransition("idle", "connecting")).toBe(true);
    expect(canTransition("idle", "error")).toBe(true);
    expect(canTransition("idle", "live")).toBe(false);
    expect(canTransition("idle", "stopped")).toBe(false);
  });

  it("connecting can transition to live, stopped, or error", () => {
    expect(canTransition("connecting", "live")).toBe(true);
    expect(canTransition("connecting", "stopped")).toBe(true);
    expect(canTransition("connecting", "error")).toBe(true);
    expect(canTransition("connecting", "idle")).toBe(false);
  });

  it("live can transition to stopped or error (never back to connecting)", () => {
    expect(canTransition("live", "stopped")).toBe(true);
    expect(canTransition("live", "error")).toBe(true);
    expect(canTransition("live", "connecting")).toBe(false);
    expect(canTransition("live", "idle")).toBe(false);
  });
});