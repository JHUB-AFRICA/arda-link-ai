import { describe, it, expect } from "vitest";
import { buildWhatsappSystemPrompt } from "../src/lib/whatsappConversation.js";
import { baseContext } from "../src/lib/herderContext/base.js";

describe("buildWhatsappSystemPrompt — water-point attribution", () => {
  it("attributes a fresh water point to the herder's live location share", () => {
    const ctx = baseContext("+254799954672", "bula-pesa");
    const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, {
      name: "Bula Pesa Dam",
      distanceKm: 2.0,
      status: "working",
    });
    expect(prompt).toContain("the location the herder most recently shared");
    expect(prompt).toContain("computed just now by the system from their live location share");
  });

  it(
    "never attributes the registered-ward fallback water point to a location share " +
      "(regression: 2026-08-06 real incident — a tester's location share had expired " +
      "15+ min ago, yet the bot said the distance was 'kutoka pale ulipokuwa ume-share " +
      "hapo awali' when the number actually came from the ward centroid, not any share)",
    () => {
      const ctx: ReturnType<typeof baseContext> = {
        ...baseContext("+254799954672", "bula-pesa"),
        nearestWaterPointName: "Ngare Mara piped water GW2",
        nearestWaterPointDistanceKm: 25.7,
        nearestWaterPointStatus: "broken",
      };
      // No freshWaterPoint passed — matches a stale/expired pending location.
      const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, null);

      expect(prompt).toContain("Ngare Mara piped water GW2");
      expect(prompt).toContain("25.7km");
      expect(prompt).toContain("ward-level reference point");
      expect(prompt).toContain(
        "NOT computed from any location the herder has personally shared",
      );
      // The exact ambiguous phrase that let the LLM invent this attribution
      // must never appear on the fallback path.
      expect(prompt).not.toContain("the location the herder most recently shared");
      expect(prompt).not.toContain("refreshed from their most recent shared location");
    },
  );

  it("omits the water-point line entirely when nothing is known", () => {
    const ctx = baseContext("+254799954672", "bula-pesa");
    const prompt = buildWhatsappSystemPrompt(ctx, "en", false, null);
    expect(prompt).not.toContain("Nearest known water point");
  });
});

describe("buildWhatsappSystemPrompt — stale-thread time awareness", () => {
  const ctx = baseContext("+254799954672", "bula-pesa");

  it("treats a quick back-and-forth as a continuing conversation", () => {
    const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, null, 3);
    expect(prompt).toContain("This is a CONTINUING conversation");
  });

  it(
    "warns the model not to reflexively continue a stale topic after a real gap " +
      "(regression: 2026-08-06 real incident — a tester sent only 'Uko on?' 4.5 hours " +
      "after a water-point discussion and got the exact same fact re-dumped verbatim)",
    () => {
      const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, null, 270); // 4.5 hours
      expect(prompt).toContain("SAME herder and thread");
      expect(prompt).toContain("4.5 hours");
      expect(prompt).toContain("Do NOT assume they want to continue the earlier topic");
      expect(prompt).not.toContain("This is a CONTINUING conversation");
    },
  );

  it("falls back to the first-message greeting when there's no history at all, regardless of gapMinutes", () => {
    const prompt = buildWhatsappSystemPrompt(ctx, "sw", false, null, 500);
    expect(prompt).toContain("greet them warmly");
    expect(prompt).not.toContain("SAME herder and thread");
  });
});
