import { describe, expect, test } from "bun:test";
import { USAGE_PERIODS as BACKEND_USAGE_PERIODS } from "../../src/console/observability/usage-periods";
import { DEFAULT_PROXY_BYPASS_PROVIDER_IDS } from "../../src/providers/provider-registry";
import { PROXY_UNSUPPORTED_HINT_PROVIDERS } from "../src/hooks/use-routing-strategy";
import generatedPeriods from "../src/data/generated/usage-periods.json";

/**
 * Dashboard hand-maintains a browser-safe copy of
 * `DEFAULT_PROXY_BYPASS_PROVIDER_IDS` because importing the backend value
 * would bundle Elysia + `node:crypto` into the browser build. USAGE_PERIODS
 * is generated from the backend contract by `bun run generate:usage-periods`.
 */
describe("dashboard/backend parity — usage constants", () => {
  test("dashboard bypass-proxy hint set matches the backend default set", () => {
    expect([...PROXY_UNSUPPORTED_HINT_PROVIDERS].sort()).toEqual(
      [...DEFAULT_PROXY_BYPASS_PROVIDER_IDS].sort(),
    );
  });

  test("the committed usage-period file matches the backend contract", () => {
    // Every dashboard script runs `codegen` first, so a stale committed file is
    // overwritten before anything reads it — which means a period added to the
    // backend and not regenerated here fails nothing and shows up nowhere. The
    // file is committed, so a reader and a reviewer have to be able to trust it.
    expect(generatedPeriods).toEqual([...BACKEND_USAGE_PERIODS]);
  });
});
