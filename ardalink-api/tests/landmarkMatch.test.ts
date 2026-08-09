import { describe, it, expect } from "vitest";
import { findLandmarkMention } from "../src/lib/data/landmarks/match";

describe("findLandmarkMention", () => {
  it("finds a curated Bula Pesa landmark named in free text", () => {
    const match = findLandmarkMention(
      "niko karibu na Abubakar Mosque sasa hivi",
      "242",
    );
    expect(match).not.toBeNull();
    expect(match?.name).toBe("Abubakar Mosque");
    expect(typeof match?.lat).toBe("number");
    expect(typeof match?.lon).toBe("number");
  });

  it("is case-insensitive", () => {
    const match = findLandmarkMention("i'm near ABUBAKAR MOSQUE", "242");
    expect(match?.name).toBe("Abubakar Mosque");
  });

  it("returns null for a ward with no curated landmark data", () => {
    expect(findLandmarkMention("niko karibu na Abubakar Mosque", "999")).toBeNull();
  });

  it("returns null for an unknown/null ward", () => {
    expect(findLandmarkMention("Abubakar Mosque", null)).toBeNull();
  });

  it("returns null when no landmark is named", () => {
    expect(findLandmarkMention("hakuna maji hapa leo", "242")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(findLandmarkMention("   ", "242")).toBeNull();
  });

  it("prefers the longest matching name", () => {
    // "Isiolo" appears twice in the catalogue (a river entry among
    // others) — any text containing a longer, more specific name should
    // never resolve to a shorter substring match instead.
    const match = findLandmarkMention("tuko karibu na Jamia Mosque Isiolo", "242");
    expect(match?.name).toBe("Jamia Mosque Isiolo");
  });
});
