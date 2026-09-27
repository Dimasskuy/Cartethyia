import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import Providers from "../../src/routes/Providers";
import { queryKeys } from "../../src/lib/query-keys";
import type { ProviderAccountResponse, ProviderResponse } from "../../src/lib/contracts";

/**
 * Two defects in the provider list card are covered here, both of which only
 * showed up in the list and never on the provider's own detail page:
 *
 * 1. A model-scoped throttle keeps `status: "active"` and leaves
 *    `cooldownUntil` untouched (`account-health-service.ts` writes only
 *    `modelCooldowns`), so the card's rollup — built from `status` — reported
 *    the account as a healthy connection while the detail page said models were
 *    cooling.
 * 2. `.provider-grid` stretches every card in a row to the tallest one, but the
 *    card's `<Link>` was only as tall as its own content, so the strip below a
 *    shorter card was not part of the link and swallowed clicks.
 */

const USAGE = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function account(overrides: Partial<ProviderAccountResponse>): ProviderAccountResponse {
  return {
    id: "acct-1",
    providerId: "openai",
    tenantId: null,
    label: "main",
    credentialKind: "api_key",
    status: "active",
    usageToday: USAGE,
    usageAllTime: USAGE,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const PROVIDER: ProviderResponse = {
  providerId: "openai",
  enabled: true,
  isBuiltIn: true,
  requiresAccount: true,
  hasAdapterUserAgent: false,
  supportsModelDiscovery: true,
};

const inMinutes = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

function renderProviders(
  accounts: readonly ProviderAccountResponse[],
  provider: ProviderResponse = PROVIDER,
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.providers.all, [provider]);
  queryClient.setQueryData(queryKeys.providers.models(provider.providerId), []);
  queryClient.setQueryData(queryKeys.providers.accounts(provider.providerId), accounts);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: ["/providers"] },
        createElement(Providers),
      ),
    ),
  );
}

describe("provider list card — per-model cooldown", () => {
  test("an account cooling one model is reported, not shown as healthy", () => {
    const markup = renderProviders([
      account({ modelCooldowns: { "gpt-5": inMinutes(10) } }),
    ]);

    expect(markup).toContain("Cooling");
    // The account is still routable for its other models, so "Connected" stays
    // true at the same time — the two badges describe different facts.
    expect(markup).toContain("1 Connected");
  });

  test("an expired per-model deadline is not reported", () => {
    const markup = renderProviders([
      account({ modelCooldowns: { "gpt-5": new Date(Date.now() - 60_000).toISOString() } }),
    ]);

    expect(markup).not.toContain("Cooling");
    expect(markup).toContain("1 Connected");
  });

  test("counts cooling accounts, not the backoffs they carry", () => {
    // One account cooling three models is one row the operator has to look at;
    // counting raw entries would report a single account as three problems.
    const markup = renderProviders([
      account({ modelCooldowns: { a: inMinutes(5), b: inMinutes(10), c: inMinutes(15) } }),
    ]);

    expect(markup).toContain(">1 Cooling<");
  });

  test("an account with no live backoff adds no cooling badge", () => {
    const markup = renderProviders([account({})]);

    expect(markup).not.toContain("Cooling");
    expect(markup).toContain("1 Connected");
  });
});

describe("provider list card — clickable area", () => {
  /** The `<a>` wrapping a provider card's content. */
  function providerLink(markup: string): string {
    const match = markup.match(/<a style="[^"]*" href="\/providers\/[^"]*"/);
    if (match === null) throw new Error("provider card link not found");
    return match[0];
  }

  test("the card is a column so the link can stretch to the grid row height", () => {
    const markup = renderProviders([account({})]);

    // Both halves are required: the card must be a flex column for `flex: 1`
    // on the link to have anything to grow into.
    expect(markup).toContain('class="card-solid" style="position:relative;overflow:hidden;display:flex;flex-direction:column');
    expect(providerLink(markup)).toContain("flex:1");
  });

  test("a short card still fills its grid cell", () => {
    // The reported case: a provider whose badges wrap to a second line makes
    // its row taller than a sibling card's content. The sibling must still be
    // clickable across its whole height.
    const tall = renderProviders([
      account({ id: "a", label: "one", modelCooldowns: { m: inMinutes(5) } }),
      account({ id: "b", label: "two", status: "cooldown" }),
    ]);
    const short = renderProviders([account({})]);

    expect(providerLink(tall)).toContain("flex:1");
    expect(providerLink(short)).toContain("flex:1");
  });
});
