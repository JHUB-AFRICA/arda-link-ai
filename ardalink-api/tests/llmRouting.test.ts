import { describe, it, expect, beforeEach } from "vitest";
import {
  routingTable,
  providersHealth,
  recentCalls,
  complete,
} from "../src/lib/llm/index.js";
import { costGuard } from "../src/lib/llm/cost.js";

/**
 * Routing + observability tests for the LLM registry.
 *
 * These tests do NOT make real network calls. They verify the static
 * routing table (which provider handles which task), the audit /
 * cost surfaces that the dashboard and /api/llm/status consume, and
 * the per-task override env path.
 *
 * Live provider health is exercised through a separate test that
 * touches the network with a strict timeout — see
 * "live provider health probe" below.
 */

describe("routing table — z.ai primary for text tasks", () => {
  it("routes multilingual → z (Swahili/English chat)", () => {
    expect(routingTable().multilingual.primary).toBe("z");
  });

  it("routes voice_script → z (Realtime opening scripts)", () => {
    expect(routingTable().voice_script.primary).toBe("z");
  });

  it("routes summarize → z (intelligence brief)", () => {
    expect(routingTable().summarize.primary).toBe("z");
  });

  it("routes extract → z (BCS / offtake / mortality)", () => {
    expect(routingTable().extract.primary).toBe("z");
  });

  it("routes reasoning → minimax (multi-step / tool use)", () => {
    expect(routingTable().reasoning.primary).toBe("minimax");
  });

  it("routes code → minimax (function-calling synthesis)", () => {
    expect(routingTable().code.primary).toBe("minimax");
  });

  it("routes default → z (safe fallback for new code)", () => {
    expect(routingTable().default.primary).toBe("z");
  });
});

describe("routing table — fallback chain is sane", () => {
  it("every text task has minimax as the fallback (or z for reasoning/code)", () => {
    const t = routingTable();
    // text tasks: z primary → minimax fallback
    expect(t.multilingual.fallback).toBe("minimax");
    expect(t.voice_script.fallback).toBe("minimax");
    expect(t.summarize.fallback).toBe("minimax");
    expect(t.extract.fallback).toBe("minimax");
    expect(t.default.fallback).toBe("minimax");
    // reasoning/code: minimax primary → z fallback
    expect(t.reasoning.fallback).toBe("z");
    expect(t.code.fallback).toBe("z");
  });

  it("never selects the same provider for primary and fallback", () => {
    const t = routingTable();
    for (const [task, route] of Object.entries(t)) {
      expect(
        route.primary,
        `${task}.primary (${route.primary}) must differ from fallback (${route.fallback})`,
      ).not.toBe(route.fallback);
    }
  });
});

describe("routing table — per-task env override", () => {
  it("LLM_TASK_REASONING_PRIMARY=z flips just reasoning", () => {
    const original = process.env.LLM_TASK_REASONING_PRIMARY;
    process.env.LLM_TASK_REASONING_PRIMARY = "z";
    try {
      // Re-import to re-evaluate the table — routingTable() reads env
      // on each call via pickProvider(), so no re-import needed.
      expect(routingTable().reasoning.primary).toBe("z");
      // Other text tasks are unaffected
      expect(routingTable().multilingual.primary).toBe("z");
      expect(routingTable().summarize.primary).toBe("z");
    } finally {
      if (original === undefined) delete process.env.LLM_TASK_REASONING_PRIMARY;
      else process.env.LLM_TASK_REASONING_PRIMARY = original;
    }
  });
});

describe("cost guard — per-task budget tracking", () => {
  beforeEach(() => {
    // The costGuard is a process-wide singleton. We don't reset it
    // (that would mask cross-test budget leaks) but we don't depend on
    // its absolute values either — only that the surface is consistent.
  });

  it("summary includes every task type", () => {
    const s = costGuard.summary();
    expect(s).toHaveProperty("multilingual");
    expect(s).toHaveProperty("voice_script");
    expect(s).toHaveProperty("summarize");
    expect(s).toHaveProperty("reasoning");
    expect(s).toHaveProperty("code");
    expect(s).toHaveProperty("extract");
    expect(s).toHaveProperty("default");
  });

  it("each task has consumed + remaining fields", () => {
    const s = costGuard.summary();
    for (const v of Object.values(s)) {
      expect(v).toHaveProperty("consumed");
      expect(v).toHaveProperty("remaining");
      expect(typeof v.consumed).toBe("number");
      expect(typeof v.remaining).toBe("number");
      expect(v.remaining).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("audit — recentCalls surface", () => {
  it("returns an array (possibly empty in test env)", () => {
    const calls = recentCalls();
    expect(Array.isArray(calls)).toBe(true);
  });

  it("never returns more than the ring-buffer cap", () => {
    const calls = recentCalls();
    // Hard-coded cap in audit.ts is 1000
    expect(calls.length).toBeLessThanOrEqual(1000);
  });
});

describe("live provider health probe", () => {
  it("returns a record keyed by provider name", async () => {
    // No real network expected to succeed in CI — we just check the
    // shape. Either ok=true (if a key happens to be set) or ok=false
    // with an error string is acceptable.
    const health = await providersHealth();
    expect(typeof health).toBe("object");
    // z and minimax should always be present
    expect(health).toHaveProperty("z");
    expect(health).toHaveProperty("minimax");
    for (const [name, h] of Object.entries(health)) {
      expect(typeof h.ok).toBe("boolean");
      expect(typeof h.latencyMs).toBe("number");
      if (!h.ok) {
        // When not ok, error should be a string
        expect(typeof h.error).toBe("string");
      }
      // Sanity: latency is never negative
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
      // Provide a useful diagnostic if this test ever fails
      if (!h.ok && process.env.DEBUG_LLM_HEALTH) {
        // eslint-disable-next-line no-console
        console.log(`[llm health] ${name}: ${h.error}`);
      }
    }
  }, 15_000);
});

describe("registry round-trip — MockClient surface", () => {
  // Without real API keys, the registry returns a MockClient (tagged
  // with the requested provider name) for every task. These tests
  // exercise the registry's plumbing — provider selection, cache key
  // shape, audit recording — without hitting any network.

  it("multilingual task resolves to provider name 'z'", async () => {
    const r = await complete("multilingual", {
      messages: [{ role: "user", content: "Habari" }],
    });
    expect(r.provider).toBe("z");
    expect(r.model).toMatch(/glm|MiniMax|MiniMax/);
  });

  it("voice_script task resolves to provider name 'z'", async () => {
    const r = await complete("voice_script", {
      messages: [{ role: "user", content: "test" }],
    });
    expect(r.provider).toBe("z");
  });

  it("summarize task resolves to provider name 'z'", async () => {
    const r = await complete("summarize", {
      messages: [{ role: "user", content: "summarize this" }],
    });
    expect(r.provider).toBe("z");
  });

  it("extract task resolves to provider name 'z'", async () => {
    const r = await complete("extract", {
      messages: [{ role: "user", content: "extract BCS" }],
    });
    expect(r.provider).toBe("z");
  });

  it("reasoning task resolves to provider name 'minimax'", async () => {
    const r = await complete("reasoning", {
      messages: [{ role: "user", content: "reason about X" }],
    });
    expect(r.provider).toBe("minimax");
  });

  it("code task resolves to provider name 'minimax'", async () => {
    const r = await complete("code", {
      messages: [{ role: "user", content: "synthesize function" }],
    });
    expect(r.provider).toBe("minimax");
  });

  it("returns a usable LlmResponse shape", async () => {
    const r = await complete("multilingual", {
      messages: [{ role: "user", content: "hello" }],
    });
    expect(r).toHaveProperty("content");
    expect(typeof r.content).toBe("string");
    expect(r).toHaveProperty("usage");
    expect(r.usage).toHaveProperty("inputTokens");
    expect(r.usage).toHaveProperty("outputTokens");
    expect(r.usage).toHaveProperty("totalTokens");
    expect(r).toHaveProperty("provider");
    expect(r).toHaveProperty("model");
    expect(r).toHaveProperty("latencyMs");
    expect(typeof r.latencyMs).toBe("number");
    expect(r).toHaveProperty("cached");
    expect(typeof r.cached).toBe("boolean");
  });

  it("caches identical requests (cache hit on second call)", async () => {
    const req = {
      messages: [{ role: "user" as const, content: "cache test " + Math.random() }],
    };
    const first = await complete("multilingual", req);
    const second = await complete("multilingual", req);
    expect(second.cached).toBe(true);
    expect(second.provider).toBe(first.provider);
    expect(second.model).toBe(first.model);
  });

  it("bypasses cache when bypassCache=true", async () => {
    const req = {
      messages: [{ role: "user" as const, content: "bypass test " + Math.random() }],
      bypassCache: true,
    };
    const r = await complete("multilingual", req);
    expect(r.cached).toBe(false);
  });

  it("respects LLM_TASK_*_PRIMARY override (reasoning → z)", async () => {
    const original = process.env.LLM_TASK_REASONING_PRIMARY;
    process.env.LLM_TASK_REASONING_PRIMARY = "z";
    try {
      const r = await complete("reasoning", {
        messages: [{ role: "user", content: "override test" }],
        bypassCache: true,
      });
      expect(r.provider).toBe("z");
    } finally {
      if (original === undefined) delete process.env.LLM_TASK_REASONING_PRIMARY;
      else process.env.LLM_TASK_REASONING_PRIMARY = original;
    }
  });
});
