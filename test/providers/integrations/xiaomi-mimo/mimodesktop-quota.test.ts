import { describe, expect, test } from "bun:test";
import { parseMimoDesktopQuota } from "../../../../src/providers/integrations/xiaomi-mimo/mimodesktop-quota";
import { createDefaultProviderRegistry } from "../../../../src/providers/default-registry";

describe("MiMo Desktop quota collector", () => {
  test("parseMimoDesktopQuota extracts weekly quota window correctly", () => {
    const raw = {
      code: 0,
      message: "success",
      data: {
        percent: 99.5,
        resetDate: "2026-10-01",
        resetAt: 1790838698,
      },
    };

    const res = parseMimoDesktopQuota(raw);
    expect(res.source).toBe("mimodesktop");
    expect(res.plan).toBe("Xiaomi MiMo Desktop");
    expect(res.error).toBeNull();
    expect(res.windows).toHaveLength(1);

    const w = res.windows[0]!;
    expect(w.kind).toBe("weekly");
    expect(w.label).toBe("Weekly Quota");
    expect(w.usedPercent).toBe(0.5); // 100 - 99.5
    expect(w.remainingPercent).toBe(99.5);
    expect(w.resetsAt).toBe(new Date(1790838698 * 1000).toISOString());
  });

  test("registry has quota collector registered for mimodesktop", async () => {
    const registry = createDefaultProviderRegistry();
    const collector = await registry.resolveQuotaCollector("mimodesktop");
    expect(collector).toBeDefined();
  });
});
