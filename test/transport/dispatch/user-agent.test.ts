import { describe, expect, test } from "bun:test";
import { buildUpstreamDispatchContext } from "../../../src/transport/dispatch/upstream";

function dispatchFetch(context: Record<string, unknown>): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const fetcher = context["outbound_fetch"];
  if (typeof fetcher !== "function") throw new Error("dispatch context is missing outbound fetch");
  return fetcher as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

describe("provider route User-Agent dispatch", () => {
  test("fills an absent User-Agent for API-key dispatch at the bound fetch boundary", async () => {
    let sentHeaders: Headers | undefined;
    const routeUserAgent = "codex_cli_rs/0.156.1";
    const context = buildUpstreamDispatchContext({
      credential: { credential_kind: "api_key" },
      deadline: Date.now() + 5_000,
      signal: new AbortController().signal,
      headers: {},
      userAgent: routeUserAgent,
      outboundFetch: async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      },
    });

    await dispatchFetch(context)("https://upstream.example/v1/chat/completions", {
      headers: { accept: "application/json" },
    });
    expect(sentHeaders?.get("user-agent")).toBe(routeUserAgent);
  });

  test("preserves Qoder's API-key User-Agent over the route identity", async () => {
    let sentHeaders: Headers | undefined;
    const routeUserAgent = "codex_cli_rs/0.156.1";
    const context = buildUpstreamDispatchContext({
      credential: { credential_kind: "api_key" },
      deadline: Date.now() + 5_000,
      signal: new AbortController().signal,
      headers: {},
      userAgent: routeUserAgent,
      outboundFetch: async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      },
    });
    const qoderUserAgent = "Go-http-client/2.0";

    await dispatchFetch(context)("https://upstream.example/qoder", {
      headers: { "user-agent": qoderUserAgent },
    });
    expect(sentHeaders?.get("user-agent")).toBe(qoderUserAgent);

    await dispatchFetch(context)(
      new Request("https://upstream.example/qoder", { headers: { "User-Agent": qoderUserAgent } }),
    );
    expect(sentHeaders?.get("user-agent")).toBe(qoderUserAgent);
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
