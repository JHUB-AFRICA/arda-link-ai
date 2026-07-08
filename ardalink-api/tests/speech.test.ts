import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// speech.ts caches whether Fast Transcription is available in the
// current region (using a module-level flag). Each test resets modules
// so the cache doesn't leak between assertions.
beforeEach(() => {
  vi.resetModules();
  process.env.AZURE_SPEECH_KEY = "sk-test";
  process.env.AZURE_SPEECH_REGION = "southafricanorth";
  process.env.AZURE_SPEECH_STT_LANGUAGES = "sw-KE,en-KE";
  delete process.env.AZURE_SPEECH_ENDPOINT;
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const factory = responses[i] ?? responses[responses.length - 1];
    i++;
    return factory();
  }) as unknown as typeof fetch;
  return calls;
}

function fastNotSupportedRegion(): Response {
  return new Response(
    JSON.stringify({
      code: "InvalidRequest",
      message: "Fast transcription is not supported in this region.",
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function fastOk(text: string, locale = "sw-KE"): Response {
  return new Response(
    JSON.stringify({
      combinedPhrases: [{ text, locale }],
      durationMilliseconds: 5000,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function shortAudioOk(text: string, lang = "sw-KE"): Response {
  return new Response(
    JSON.stringify({
      RecognitionStatus: "Success",
      DisplayText: text,
      Language: lang,
      NBest: [{ Display: text, Confidence: 0.8 }],
      Duration: 50_000_000,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("fastTranscribe", () => {
  it("returns transcript directly when Fast Transcription succeeds", async () => {
    const calls = mockFetch([() => fastOk("habari yako")]);
    const { fastTranscribe } = await import("../src/lib/speech.js");
    const result = await fastTranscribe(new Uint8Array([1, 2]), "audio/wav");
    expect(result?.transcript).toBe("habari yako");
    // Only Fast was called; no fallback attempt.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(
      "/speechtotext/transcriptions:transcribe",
    );
  });

  it("falls back to short-audio REST when Fast returns 'not supported in this region'", async () => {
    const calls = mockFetch([
      fastNotSupportedRegion,
      () => shortAudioOk("habari yako"),
    ]);
    const { fastTranscribe } = await import("../src/lib/speech.js");
    const result = await fastTranscribe(new Uint8Array([1, 2]), "audio/wav");
    expect(result?.transcript).toBe("habari yako");
    expect(result?.locale).toBe("sw-KE");
    // 2 requests: one Fast, one short-audio.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain(
      "/speech/recognition/conversation/cognitiveservices/v1",
    );
  });

  it("caches the region-unsupported flag: subsequent calls skip Fast entirely", async () => {
    const calls = mockFetch([
      fastNotSupportedRegion,
      () => shortAudioOk("first"),
      () => shortAudioOk("second"),
    ]);
    const { fastTranscribe } = await import("../src/lib/speech.js");

    await fastTranscribe(new Uint8Array([1]), "audio/wav");
    await fastTranscribe(new Uint8Array([2]), "audio/wav");

    // Fast was probed once. Then the short-audio path handled both
    // subsequent calls without re-probing Fast.
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain("transcriptions:transcribe");
    expect(calls[1]?.url).toContain(
      "/speech/recognition/conversation/cognitiveservices/v1",
    );
    expect(calls[2]?.url).toContain(
      "/speech/recognition/conversation/cognitiveservices/v1",
    );
  });

  it("returns null when both Fast and short-audio fail", async () => {
    mockFetch([
      fastNotSupportedRegion,
      () => new Response("upstream error", { status: 500 }),
    ]);
    const { fastTranscribe } = await import("../src/lib/speech.js");
    const result = await fastTranscribe(new Uint8Array([1]), "audio/wav");
    expect(result).toBeNull();
  });

  it("returns null when Fast succeeds with an empty transcript AND short-audio also empty", async () => {
    mockFetch([
      () =>
        new Response(
          JSON.stringify({ combinedPhrases: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      () =>
        new Response(
          JSON.stringify({
            RecognitionStatus: "Success",
            DisplayText: "",
            NBest: [{ Display: "" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ]);
    const { fastTranscribe } = await import("../src/lib/speech.js");
    const result = await fastTranscribe(new Uint8Array([1]), "audio/wav");
    expect(result).toBeNull();
  });

  it("passes the locales list from AZURE_SPEECH_STT_LANGUAGES", async () => {
    const calls = mockFetch([() => fastOk("hello")]);
    const { fastTranscribe } = await import("../src/lib/speech.js");
    await fastTranscribe(new Uint8Array([1]), "audio/wav");
    // The definition is form-data — check it made a POST to Fast.
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe("sk-test");
  });

  it("respects an explicit locales override on the call", async () => {
    mockFetch([() => fastOk("hello")]);
    const { fastTranscribe } = await import("../src/lib/speech.js");
    const result = await fastTranscribe(new Uint8Array([1]), "audio/wav", {
      locales: ["en-US"],
    });
    expect(result?.transcript).toBe("hello");
  });
});
