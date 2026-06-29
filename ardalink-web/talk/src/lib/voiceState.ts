/**
 * Voice state-machine contract for the browser-voice WebRTC client.
 *
 * The actual `BrowserVoiceClient` lives in `./browserVoice.ts` and is
 * tightly coupled to AudioContext, WebSocket, and mic APIs. To make the
 * allowed transitions testable in isolation, this module exposes a
 * pure transition table.
 *
 * State diagram:
 *
 *   idle ──start──> connecting ──ok──> live
 *                                  │
 *                                  ├──ws close──> stopped
 *                                  ├──ws error──> error
 *                                  ├──mic error──> error
 *                                  └──stop()──> stopped
 *
 *   live ──stop()──> stopped
 *   live ──ws error──> error
 *
 * `connecting`, `live`, and `error` are non-terminal from a *contract*
 * point of view: callers can still call `stop()`, which moves the
 * state to `stopped`. `stopped` and `error` are terminal — once there,
 * the only legal transition is back to `idle` via a fresh `start()`
 * call on a new client.
 */

export type VoiceState =
  | "idle"
  | "connecting"
  | "live"
  | "stopped"
  | "error";

/**
 * Allowed transitions. Each key is the current state; each value is
 * the set of states it may move to without constructing a new client.
 */
const ALLOWED: Record<VoiceState, ReadonlySet<VoiceState>> = {
  idle: new Set<VoiceState>(["connecting", "error"]),
  connecting: new Set<VoiceState>(["live", "stopped", "error"]),
  live: new Set<VoiceState>(["stopped", "error"]),
  stopped: new Set<VoiceState>([]),
  error: new Set<VoiceState>([]),
};

/** True iff `from → to` is a legal transition in the voice client. */
export function canTransition(from: VoiceState, to: VoiceState): boolean {
  return ALLOWED[from].has(to);
}

/**
 * Compute the next state from the current state and an event. Returns
 * `null` when the event is a no-op or the transition is illegal —
 * callers should treat `null` as "do not change state" and ignore.
 */
export function nextState(
  from: VoiceState,
  event: VoiceEvent,
): VoiceState | null {
  switch (event) {
    case "start":
      return canTransition(from, "connecting") ? "connecting" : null;
    case "ws_open":
      return from === "connecting" ? "live" : null;
    case "ws_close":
      return canTransition(from, "stopped") ? "stopped" : null;
    case "ws_error":
    case "mic_error":
      return canTransition(from, "error") ? "error" : null;
    case "stop":
      // `stop()` is the universal "give up" — it can land in `stopped`
      // from any non-terminal state, and on a terminal state it's a
      // no-op.
      return canTransition(from, "stopped") ? "stopped" : null;
    default:
      return null;
  }
}

export type VoiceEvent =
  | "start"
  | "ws_open"
  | "ws_close"
  | "ws_error"
  | "mic_error"
  | "stop";

/**
 * Terminal states (`stopped`, `error`) cannot transition further
 * without a fresh client.
 */
export function isTerminal(state: VoiceState): boolean {
  return ALLOWED[state].size === 0;
}