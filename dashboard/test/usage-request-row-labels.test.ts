import { describe, expect, test } from "bun:test";
import { formatAgo, formatCredit, surfaceFamilyLabel } from "../src/features/usage/UsagePage";

/**
 * The requests table's second-line cells: the status column names only the
 * protocol family (the `API KEY` column already identifies the client), and
 * the time column pairs the clock with a relative age.
 */
describe("usage requests table labels", () => {
  test("names the protocol family, never the endpoint or client", () => {
    expect(surfaceFamilyLabel("chat")).toBe("OpenAI Completions");
    expect(surfaceFamilyLabel("completion")).toBe("OpenAI Completions");
    expect(surfaceFamilyLabel("messages")).toBe("Anthropic Messages");
    expect(surfaceFamilyLabel("responses")).toBe("OpenAI Responses");
    expect(surfaceFamilyLabel("unknown-wire")).toBe("unknown-wire");
    expect(surfaceFamilyLabel(undefined)).toBe("—");
  });

  test("ages a request start in minutes, hours, days, then weeks", () => {
    const now = Date.parse("2026-09-28T02:30:00.000Z");
    expect(formatAgo("2026-09-28T02:29:30.000Z", now)).toBe("just now");
    expect(formatAgo("2026-09-28T02:28:00.000Z", now)).toBe("2m ago");
    expect(formatAgo("2026-09-28T00:30:00.000Z", now)).toBe("2h ago");
    expect(formatAgo("2026-09-25T02:30:00.000Z", now)).toBe("3d ago");
    expect(formatAgo("2026-09-10T02:30:00.000Z", now)).toBe("2w ago");
    expect(formatAgo("not-a-date", now)).toBe("—");
  });
  test("formats buddy-meter credits with two decimals", () => {
    expect(formatCredit(1.01)).toBe("1.01 CR");
    expect(formatCredit(0)).toBe("0 CR");
    expect(formatCredit(34)).toBe("34 CR");
    expect(formatCredit(undefined)).toBe("—");
    expect(formatCredit(Number.NaN)).toBe("—");
  });
});
