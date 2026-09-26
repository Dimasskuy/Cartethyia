import { describe, expect, test } from "bun:test";
import { buildUpstreamDispatchContext } from "../../../src/transport/dispatch/upstream";

function dispatchFetch(context: Record<string, unknown>): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const fetcher = context["outbound_fetch"];
  if (typeof fetcher !== "function") throw new Error("dispatch context is missing outbound fetch");
  return fetcher as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

describe("provider route User-Agent dispatch", () => {
  test("overrides adapter headers for non-OAuth dispatches at the bound fetch boundary", async () => {
    let sentHeaders: Headers | undefined;
    const context = buildUpstreamDispatchContext({
      credential: { credential_kind: "api_key" },
      deadline: Date.now() + 5_000,
      signal: new AbortController().signal,
      headers: {},
      userAgent: "codex_cli_rs/0.156.1",
      outboundFetch: async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      },
    });

    await dispatchFetch(context)("https://upstream.example/v1/chat/completions", {
      headers: { "user-agent": "adapter-specific/1" },
    });
    expect(sentHeaders?.get("user-agent")).toBe("codex_cli_rs/0.156.1");
  });

  test("does not replace OAuth-native User-Agent headers", async () => {
    let sentHeaders: Headers | undefined;
    const context = buildUpstreamDispatchContext({
      credential: { credential_kind: "oauth" },
      deadline: Date.now() + 5_000,
      signal: new AbortController().signal,
      headers: {},
      userAgent: "codex_cli_rs/0.156.1",
      outboundFetch: async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      },
    });

    await dispatchFetch(context)("https://upstream.example/v1/responses", {
      headers: { "user-agent": "oauth-native/2" },
    });
    expect(sentHeaders?.get("user-agent")).toBe("oauth-native/2");
  });

  test("leaves custom-provider client identity untouched when no route identity is selected", async () => {
    let sentHeaders: Headers | undefined;
    const context = buildUpstreamDispatchContext({
      credential: { credential_kind: "api_key" },
      deadline: Date.now() + 5_000,
      signal: new AbortController().signal,
      headers: {},
      outboundFetch: async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      },
    });

    await dispatchFetch(context)("https://custom.example/v1/chat/completions", {
      headers: { "user-agent": "custom-client/4" },
    });
    expect(sentHeaders?.get("user-agent")).toBe("custom-client/4");
  });
});
