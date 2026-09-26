import { describe, expect, test } from "bun:test";
import { providerCanConfigureUserAgent } from "../../src/lib/provider-user-agent";

describe("provider User-Agent setting visibility", () => {
  test("shows the setting for built-in authenticated providers without OAuth", () => {
    expect(
      providerCanConfigureUserAgent({
        isBuiltIn: true,
        requiresAccount: true,
        oauthFlows: undefined,
      }),
    ).toBe(true);
  });

  test("hides the setting for OAuth and custom providers", () => {
    expect(
      providerCanConfigureUserAgent({
        isBuiltIn: true,
        requiresAccount: true,
        oauthFlows: { browser: false, device: true },
      }),
    ).toBe(false);
    expect(
      providerCanConfigureUserAgent({
        isBuiltIn: false,
        requiresAccount: true,
        oauthFlows: undefined,
      }),
    ).toBe(false);
  });

  test("hides the setting for credential-free providers", () => {
    expect(
      providerCanConfigureUserAgent({
        isBuiltIn: true,
        requiresAccount: false,
        oauthFlows: undefined,
      }),
    ).toBe(false);
  });
});
