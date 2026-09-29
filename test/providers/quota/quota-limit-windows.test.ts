import { describe, expect, test } from "bun:test";
import { parseLimitWindows } from "../../../src/providers/quota/quota-limit-windows";

const SHAPE = {
  kindPaths: ["type"],
  percentPaths: ["percentUsed"],
  resetPaths: ["resetsAt"],
  limitPaths: ["limit"],
} as const;

describe("shared limit-array quota reader", () => {
  test("reads kind, percent, reset, and limit from each entry", () => {
    const windows = parseLimitWindows(
      {
        limits: [
          { type: "weekly", percentUsed: 42, resetsAt: "2026-10-01T00:00:00.000Z", limit: 100 },
          { type: "five_hour", percentUsed: 10, resetsAt: null, limit: 50 },
        ],
      },
      SHAPE,
    );
    expect(windows).toHaveLength(2);
    expect(windows[0]!.kind).toBe("weekly");
    expect(windows[0]!.usedPercent).toBe(42);
    expect(windows[0]!.limit).toBe(100);
    expect(windows[1]!.kind).toBe("five_hour");
  });

  test("an entry with neither percent nor reset is skipped, never zeroed", () => {
    // The upstream said nothing — a 0% window there would be a fabricated
    // reading, so the entry is dropped instead.
    const windows = parseLimitWindows(
      { limits: [{ type: "weekly", percentUsed: null, resetsAt: null }] },
      SHAPE,
    );
    expect(windows).toEqual([]);
  });

  test("a kind with no label mapping falls back instead of dropping the entry", () => {
    const windows = parseLimitWindows(
      { limits: [{ type: "some_new_window", percentUsed: 5, resetsAt: null }] },
      SHAPE,
    );
    expect(windows[0]!.label).toBe("some new window");
  });

  test("deriveUsed fills the absolute used value when only a percent is reported", () => {
    const windows = parseLimitWindows(
      { limits: [{ type: "weekly", percentUsed: 25, resetsAt: null, limit: 200 }] },
      {
        ...SHAPE,
        usedPaths: ["used"],
        deriveUsed: (_entry, percent, limit) =>
          percent !== null && limit !== null ? (limit * percent) / 100 : null,
      },
    );
    expect(windows[0]!.used).toBe(50);
  });

  test("an explicit used value wins over the derived one", () => {
    const windows = parseLimitWindows(
      { limits: [{ type: "weekly", percentUsed: 25, resetsAt: null, limit: 200, used: 7 }] },
      {
        ...SHAPE,
        usedPaths: ["used"],
        deriveUsed: () => 999,
      },
    );
    expect(windows[0]!.used).toBe(7);
  });

  test("a non-array or missing `limits` yields no windows", () => {
    expect(parseLimitWindows({}, SHAPE)).toEqual([]);
    expect(parseLimitWindows({ limits: "nope" }, SHAPE)).toEqual([]);
    expect(parseLimitWindows(null, SHAPE)).toEqual([]);
  });
});
