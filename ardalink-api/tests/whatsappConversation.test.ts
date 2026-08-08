import { describe, it, expect } from "vitest";
import { buildWhatsappSystemPrompt } from "../src/lib/whatsappConversation.js";
import { baseContext } from "../src/lib/herderContext/base.js";

describe("buildWhatsappSystemPrompt — ward identifies, doesn't confine", () => {
  it(
    "frames ward as an identifier, never a hard boundary on where the bot will help " +
      "(owner's explicit direction: pastoralists move, ward is not a blocker to " +
      "navigation/access, the goal is optimizing herder activity and availing " +
      "information — real transcripts showed the old wording producing flat refusals " +
      "like 'sina data ya ward nyingine' for any place outside the registered ward)",
    () => {
      const ctx = baseContext("+254799954672", "bula-pesa");
      const prompt = buildWhatsappSystemPrompt(ctx, "en", false, null);
      expect(prompt).toContain("ward identifies, it doesn't confine");
      expect(prompt).toContain("never a reason to withhold help or refuse to engage");
      expect(prompt).toContain("never a flat \"I can't help with that.\"");
      // The old, more refusal-flavored wording must not linger.
      expect(prompt).not.toContain("say plainly you only have verified data for the ward(s) named above, and ask where relative to one of them they mean");
    },
  );
});

describe("buildWhatsappSystemPrompt — never route a herder to a broken water point", () => {
  it(
    "forbids sending the herder to the nearest point when it is recorded broken and nothing is confirmed working " +
      "(regression: 2026-08-09 real incident — a herder said 'nataka maji, hakuna hapa' and was pointed at " +
      "Burat borehole 3W5, ~15.9km away, which the system already knew was broken. Every WPDx row is " +
      "Non-Functional, so this is the NORMAL case, not an edge case)",
    () => {
      const ctx: ReturnType<typeof baseContext> = {
        ...baseContext("+254799954672", "burat"),
        nearestWaterPointName: "Burat borehole/tubewell 3W5",
        nearestWaterPointDistanceKm: 15.9,
        nearestWaterPointStatus: "broken",
        nearestWorkingWaterPointName: null,
        nearestWorkingWaterPointDistanceKm: null,
      };
      const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, null);

      expect(prompt).toContain("NO confirmed-working water point known");
      expect(prompt).toContain("Do NOT tell them to go there");
      expect(prompt).toContain("dead borehole");
      // Must never frame a broken point the way a usable one is framed.
      expect(prompt).not.toContain("CONFIRMED WORKING water point");
    },
  );

  it("presents a confirmed-working point as the one travellable option when one exists", () => {
    const ctx: ReturnType<typeof baseContext> = {
      ...baseContext("+254799954672", "burat"),
      nearestWaterPointName: "Burat borehole/tubewell 3W5",
      nearestWaterPointDistanceKm: 15.9,
      nearestWaterPointStatus: "broken",
      nearestWorkingWaterPointName: "Ngare Mara pan",
      nearestWorkingWaterPointDistanceKm: 6.2,
    };
    const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, null);
    expect(prompt).toContain("CONFIRMED WORKING water point");
    expect(prompt).toContain("Ngare Mara pan");
    expect(prompt).toContain("6.2km");
  });

  it("bans invented survival/water-finding technique, and stops indicator-collection under urgent need", () => {
    const ctx = baseContext("+254799954672", "burat");
    const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, null);
    expect(prompt).toContain("NEVER invent survival, water-finding, or livestock techniques");
    expect(prompt).toContain("URGENT NEED OVERRIDES ALL OF THIS");
    expect(prompt).toContain("NOT every message needs one");
  });
});

describe("buildWhatsappSystemPrompt — water-point attribution", () => {
  it("attributes a fresh water point to the herder's live location share", () => {
    const ctx = baseContext("+254799954672", "bula-pesa");
    const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, {
      name: "Bula Pesa Dam",
      distanceKm: 2.0,
      status: "working",
    });
    expect(prompt).toContain("computed just now from the live location they shared");
    expect(prompt).toContain("reflects where they are now");
    // A working fresh point is a real destination — must not fall into
    // the broken-point "do not go there" branch.
    expect(prompt).toContain("CONFIRMED WORKING water point");
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
      expect(prompt).toContain("measured from the ward's centre");
      expect(prompt).toContain(
        "never claim it came from anything the herder shared",
      );
      // The exact ambiguous phrasing that let the LLM invent this
      // attribution must never appear on the ward-centroid path.
      expect(prompt).not.toContain("live location they shared");
      expect(prompt).not.toContain("refreshed from their most recent shared location");
    },
  );

  it(
    "attributes a water point to the herder's own registered location " +
      "(distinct from a ward-wide estimate, but honestly not a live position) " +
      "when overlayStoredLocation found stored coordinates " +
      "(regression: 2026-08-06 real incident — a herder mentioned a nearby landmark " +
      "and the bot fell back to a ~192km ward-wide estimate instead of considering " +
      "anything specific to that herder, because their own registered location was " +
      "never consulted at all)",
    () => {
      const ctx: ReturnType<typeof baseContext> = {
        ...baseContext("+254799954672", "bula-pesa"),
        nearestWaterPointName: "Oldonyiro borehole 4",
        nearestWaterPointDistanceKm: 3.2,
        nearestWaterPointStatus: "working",
        lastKnownLat: 0.6392,
        lastKnownLon: 37.1345,
        lastKnownLocationSource: "whatsapp_registration",
      };
      const prompt = buildWhatsappSystemPrompt(ctx, "sw", true, null);

      expect(prompt).toContain("Oldonyiro borehole 4");
      expect(prompt).toContain("3.2km");
      expect(prompt).toContain("own REGISTERED location");
      expect(prompt).toContain("whatsapp_registration");
      expect(prompt).toContain("NOT a live position");
      // Must not be confused with either the live-share wording or the
      // "same for anyone in this ward" wording — it's personal, but not live.
      expect(prompt).not.toContain("live location they shared");
      expect(prompt).not.toContain("the same for anyone in this ward");
    },
  );

  it("omits the water-point line entirely when nothing is known", () => {
    const ctx = baseContext("+254799954672", "bula-pesa");
    const prompt = buildWhatsappSystemPrompt(ctx, "en", false, null);
    expect(prompt).not.toContain("Nearest known water point");
  });
});

describe("buildWhatsappSystemPrompt — Phase 3: landmarks + query-ward", () => {
  it("splices in the herder's own ward's curated landmark block when one exists (Bula Pesa)", () => {
    const ctx = baseContext("+254799954672", "bula-pesa"); // wardId 242 = Bulla Pesa
    const prompt = buildWhatsappSystemPrompt(ctx, "en", false, null);
    expect(prompt).toContain("Known named places in the herder's ward");
    // A real, spot-checked entry from bulaPesaLandmarks.ts.
    expect(prompt).toContain("Shibli Petrol Station");
  });

  it(
    "gives an honest 'no data' line, never an invented landmark, for a ward with no curated catalogue " +
      "(regression: 2026-08-06 real incident — a herder named 'police post' and the bot had no way " +
      "to recognize it at all, silently ignoring it rather than saying so)",
    () => {
      const ctx: ReturnType<typeof baseContext> = {
        ...baseContext("+254799954672", "ngare-mara"), // wardId 245 — no landmark file
      };
      const prompt = buildWhatsappSystemPrompt(ctx, "en", false, null);
      expect(prompt).toContain("No curated named-place catalogue exists for this ward yet");
      expect(prompt).not.toContain("Known named places in the herder's ward");
    },
  );

  it("labels a different-ward query clearly, never conflating it with the herder's own ward", () => {
    const ctx: ReturnType<typeof baseContext> = {
      ...baseContext("+254799954672", "bula-pesa"),
      wardName: "Bulla Pesa",
    };
    const prompt = buildWhatsappSystemPrompt(ctx, "en", true, null, 3, {
      wardId: "245",
      wardName: "Ngare Mara",
      ndviMean: 0.31,
      vci: 42,
      waterPoint: { name: "Ngare Mara piped water GW2", distanceKm: 5.4, status: "working" },
      landmarksBlock: null,
    });
    expect(prompt).toContain("names a DIFFERENT ward than their own registered one");
    expect(prompt).toContain("Ngare Mara");
    expect(prompt).toContain("their own ward is Bulla Pesa");
    expect(prompt).toContain("Ngare Mara piped water GW2");
    expect(prompt).toContain("5.4km");
  });

  it("omits the query-ward line entirely when no other ward was named", () => {
    const ctx = baseContext("+254799954672", "bula-pesa");
    const prompt = buildWhatsappSystemPrompt(ctx, "en", false, null, null, null);
    expect(prompt).not.toContain("names a DIFFERENT ward");
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
