import { describe, expect, test } from "bun:test";
import { parseMimoUsageWindows } from "../../../../src/providers/integrations/xiaomi-mimo/mimo-quota-shared";

describe("shared MiMo usage parsing", () => {
  test("remaining percent is inverted into used percent", () => {
    const result = parseMimoUsageWindows(
      { code: 0, data: { percent: 99.5, resetDate: "2026-10-01", resetAt: 1790838698 } },
      { source: "mimodesktop", plan: "Xiaomi MiMo Desktop" },
    );
    expect(result.windows).toHaveLength(1);
    const window = result.windows[0]!;
    expect(window.kind).toBe("weekly");
    expect(window.label).toBe("Weekly Quota");
    expect(window.usedPercent).toBe(0.5);
    expect(window.remainingPercent).toBe(99.5);
    expect(window.resetsAt).toBe(new Date(1790838698 * 1000).toISOString());
    expect(result.error).toBeNull();
  });

  test("the epoch reset wins over the date string", () => {
    const result = parseMimoUsageWindows(
      { data: { percent: 50, resetDate: "2026-10-01", resetAt: 1790838698 } },
      { source: "mimostudio", plan: "MiMo Studio" },
    );
    expect(result.windows[0]!.resetsAt).toBe(new Date(1790838698 * 1000).toISOString());
  });

  test("a payload with neither percent nor reset yields no window, not a zero", () => {
    // An unrecognized shape must read as "no data", never as "0% used".
    const result = parseMimoUsageWindows(
      { data: { unrelated: 1 } },
      { source: "mimodesktop", plan: "Xiaomi MiMo Desktop" },
    );
    expect(result.windows).toEqual([]);
    expect(result.error).toBeNull();
  });

  test("a payload with no `data` envelope reports the format error", () => {
    const result = parseMimoUsageWindows(
      { code: 1 },
      { source: "mimostudio", plan: "MiMo Studio" },
    );
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("Unexpected response format");
  });
});
