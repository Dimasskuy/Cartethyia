import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuotaEntry, QuotaWindow } from "../../../src/hooks/quota";

const windows: QuotaWindow[] = Array.from({ length: 6 }, (_, index) => ({
  kind: `window-${index + 1}`,
  label: `Window ${index + 1}`,
  remainingPercent: 80,
  usedPercent: 20,
  resetsAt: null,
  limit: 100,
}));

const account: QuotaEntry = {
  id: "quota-account",
  provider: "workbuddy",
  name: "quota@example.test",
  credentialHint: "oauth",
  active: true,
  quota: {
    source: "workbuddy",
    status: "ready",
    plan: "Free Plan",
    windows,
    fetchedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null,
  },
  health: { status: "active" },
  providerName: "WorkBuddy",
  providerIcon: "workbuddy",
};

// The mock reads this list on every render, so a test can swap in a larger set
// to assert ordering without re-registering the module mock.
let overviewAccounts: QuotaEntry[] = [account];

mock.module("../../../src/hooks/quota", () => ({
  useQuotaOverview: () => ({
    data: { providers: [], accounts: overviewAccounts, refreshing: 0 },
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: async () => undefined,
  }),
  useRefreshAccountQuota: () => ({ isPending: false, mutate: () => undefined }),
  useRefreshAllQuotas: () => ({ isPending: false, mutate: () => undefined }),
  useTriggerGrowthPass: () => ({ isPending: false, mutate: () => undefined }),
  useTriggerAccountReset: () => ({ isPending: false, mutateAsync: async () => undefined }),
  useAccountResets: () => ({ data: undefined, isPending: false }),
  useUpdateAccountActive: () => ({ mutateAsync: async () => undefined }),
  useSetAccountsActiveBatch: () => ({ mutateAsync: async () => undefined }),
  useDeleteQuotaAccount: () => ({ mutateAsync: async () => undefined }),
  supportsAccountCheckin: () => false,
  supportsAccountReset: () => false,
}));

// Install hook mocks before the route module evaluates its static imports.
const { default: QuotaPage } = await import("../../../src/features/quota/QuotaPage");

describe("quota card pagination", () => {
  test("shows only the first four quota windows and exposes forward navigation", () => {
    const markup = renderToStaticMarkup(createElement(QuotaPage));

    expect(markup).toContain("Window 1");
    expect(markup).toContain("Window 4");
    expect(markup).not.toContain("Window 5");
    expect(markup).toContain("Showing 1–4 of 6");
    expect(markup).toContain('aria-label="Next quota windows for quota@example.test"');
    expect(markup).toContain('aria-label="Previous quota windows for quota@example.test"');
  });
});

describe("quota card ordering", () => {
  /** Every card's provider title, in the order the grid renders them. */
  function renderedProviders(markup: string, names: readonly string[]): string[] {
    return names
      .map((name) => ({ name, at: markup.indexOf(name) }))
      .filter((entry) => entry.at !== -1)
      .sort((left, right) => left.at - right.at)
      .map((entry) => entry.name);
  }

  test("orders cards A–Z by provider, then by account within a provider", () => {
    const entry = (over: Partial<QuotaEntry>): QuotaEntry => ({
      ...account,
      // The default account filter keeps only cards with at least one window.
      quota: { ...account.quota!, windows: windows.slice(0, 1) },
      ...over,
    });
    // Deliberately supplied out of order, with two accounts on one provider and
    // account labels that would sort differently from their provider names.
    overviewAccounts = [
      entry({ id: "z", provider: "workbuddy", providerName: "WorkBuddy", name: "bbb@example.test" }),
      entry({ id: "a", provider: "cerebras", providerName: "Cerebras", name: "zzz-1" }),
      entry({ id: "m", provider: "muse", providerName: "Muse Code", name: "aaa" }),
      entry({ id: "a2", provider: "cerebras", providerName: "Cerebras", name: "aaa-2" }),
      entry({ id: "z2", provider: "workbuddy", providerName: "WorkBuddy", name: "aaa@example.test" }),
    ];

    const markup = renderToStaticMarkup(createElement(QuotaPage));
    expect(
      renderedProviders(markup, ["WorkBuddy", "Cerebras", "Muse Code"]),
    ).toEqual(["Cerebras", "Muse Code", "WorkBuddy"]);

    // Within one provider the account label decides, and the two providers that
    // share a label family stay grouped rather than interleaved.
    const firstCerebras = markup.indexOf("aaa-2");
    const secondCerebras = markup.indexOf("zzz-1");
    expect(firstCerebras).toBeLessThan(secondCerebras);
    expect(markup.indexOf("aaa@example.test")).toBeLessThan(markup.indexOf("bbb@example.test"));

    overviewAccounts = [account];
  });
});
