import { describe, expect, test } from "bun:test";
import { requestProviderId } from "../src/shared/provider-names";

/**
 * `providerId` is the provider that actually served a request, so it is absent
 * on a request that failed before a candidate was leased (`model_not_found`,
 * `accounts_unavailable`). The caller's `model` still carries the qualified
 * `provider/model` ref it asked for, and the Usage table must name a provider
 * either way instead of rendering a bare dash.
 */
describe("requestProviderId", () => {
  test("falls back to the qualified model ref when no provider served the request", () => {
    expect(requestProviderId(undefined, "antigravity/claude-opus-4-6")).toBe("antigravity");
    expect(requestProviderId(undefined, "github/claude-opus-4.7")).toBe("github");
  });

  test("prefers the serving provider over the requested ref", () => {
    // A failover served by another provider must name the one that answered.
    expect(requestProviderId("codex", "antigravity/gemini-3-flash")).toBe("codex");
  });

  test("returns undefined for a bare model id, which names no provider", () => {
    expect(requestProviderId(undefined, "mimo-chat")).toBeUndefined();
    expect(requestProviderId(undefined, undefined)).toBeUndefined();
    expect(requestProviderId(undefined, "")).toBeUndefined();
  });

  test("treats a leading slash as unqualified rather than an empty provider", () => {
    expect(requestProviderId(undefined, "/gpt-6-luna")).toBeUndefined();
  });

  test("keeps the prefix verbatim so an unknown provider renders as itself", () => {
    // Display only: the column shows what was asked for. `providerDisplayName`
    // already falls back to the raw id, so a bad ref is not mislabelled.
    expect(requestProviderId(undefined, "not-a-provider/some-model")).toBe("not-a-provider");
  });
});
