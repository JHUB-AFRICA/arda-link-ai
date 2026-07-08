import { describe, expect, it, vi, beforeEach } from "vitest";

// The helper drills into the shared `@workspace/db` package to run a
// Drizzle update. Mock the whole module so we don't need a live Postgres
// for the unit test — the mock captures the WHERE eq() shape as a plain
// object for the assertions below.

interface CapturedUpdate {
  set: Record<string, unknown> | null;
  whereShape: { column?: unknown; value?: unknown } | null;
}
const captured: CapturedUpdate = { set: null, whereShape: null };

vi.mock("@workspace/db", () => {
  return {
    db: {
      update: (_table: unknown) => ({
        set: (payload: Record<string, unknown>) => {
          captured.set = payload;
          return {
            where: (whereExpr: { column?: unknown; value?: unknown }) => {
              captured.whereShape = whereExpr;
              return Promise.resolve(undefined);
            },
          };
        },
      }),
    },
    pastoralistsTable: {
      phone: { columnName: "phone" },
      lastContactAt: { columnName: "last_contact_at" },
    },
  };
});

// drizzle's `eq(col, val)` normally returns an SQL expression object; for
// the mock above we just pass the shape through so the helper's call is
// observable.
vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => ({ column, value }),
  };
});

import { touchPastoralistLastContact } from "../src/lib/pastoralistContact.js";

describe("touchPastoralistLastContact", () => {
  beforeEach(() => {
    captured.set = null;
    captured.whereShape = null;
  });

  it("no-ops on empty phone", async () => {
    await touchPastoralistLastContact("");
    await touchPastoralistLastContact(null);
    await touchPastoralistLastContact(undefined);
    expect(captured.set).toBeNull();
    expect(captured.whereShape).toBeNull();
  });

  it("no-ops on browser-* pseudo-phones (demo, deterministic, webrtc)", async () => {
    // The demo pipeline uses `browser-webrtc`, `browser-deterministic`,
    // etc. as pseudo-phones so no `pastoralists.phone` row should ever
    // match them. Skip the DB round-trip entirely.
    await touchPastoralistLastContact("browser-webrtc");
    await touchPastoralistLastContact("browser-deterministic");
    await touchPastoralistLastContact("browser-anything");
    expect(captured.set).toBeNull();
    expect(captured.whereShape).toBeNull();
  });

  it("strips whitespace before running the update", async () => {
    await touchPastoralistLastContact("  +254712000004  ");
    expect(captured.whereShape).not.toBeNull();
    // The phone value we matched on should be the trimmed string.
    expect(captured.whereShape?.value).toBe("+254712000004");
  });

  it("sets last_contact_at to a fresh Date on canonical E.164", async () => {
    const before = Date.now();
    await touchPastoralistLastContact("+254712000004");
    const after = Date.now();

    expect(captured.set).not.toBeNull();
    const stamp = (captured.set as { lastContactAt: Date }).lastContactAt;
    expect(stamp).toBeInstanceOf(Date);
    expect(stamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamp.getTime()).toBeLessThanOrEqual(after);
  });

  it("swallows DB errors — never throws", async () => {
    // Re-mock so `set()` throws — the helper must still resolve.
    const { db } = await import("@workspace/db");
    const original = db.update;
    (db as unknown as { update: unknown }).update = () => ({
      set: () => ({
        where: () => Promise.reject(new Error("db is on fire")),
      }),
    });
    await expect(
      touchPastoralistLastContact("+254712000005"),
    ).resolves.toBeUndefined();
    (db as unknown as { update: unknown }).update = original;
  });
});
