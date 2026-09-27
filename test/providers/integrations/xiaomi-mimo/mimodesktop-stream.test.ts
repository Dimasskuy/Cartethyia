import { afterEach, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "../../../../src/providers/default-registry";
import { MIMODESKTOP_SPEC } from "../../../../src/providers/integrations/xiaomi-mimo/mimodesktop";
import {
  acquireMimoServiceSession,
  invalidateMimoSessionCache,
  MIMO_API_UA,
} from "../../../../src/providers/integrations/xiaomi-mimo/mimodesktop-sso";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../../src/providers/provider-registry";
import type { CanonicalEvent, CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ValidatedFetch } from "../../../../src/network/outbound-fetch";

afterEach(() => invalidateMimoSessionCache());

test("Desktop negotiates SSE, emits reasoning before the remaining frames, and never forwards the passToken as bearer", async () => {
  invalidateMimoSessionCache();
  let ssoLegs = 0;
  const fetchSso = (async (input: RequestInfo | URL) => {
    ssoLegs++;
    const url = String(input);
    if (url.includes("/api/user/xiaomi/me")) {
      const callback = encodeURIComponent("https://mimo-server-sgp.xiaomimimo.com/sts");
      return new Response(null, {
        status: 302,
        headers: { location: `https://account.xiaomi.com/pass/serviceLogin?callback=${callback}&sid=mimosgp` },
      });
    }
    if (url.includes("sid=passportapi") && !url.includes("clientSign="))
      return Response.json({ nonce: "nonce", location: "https://account.xiaomi.com/pass/confirm?nonce=nonce", ssecurity: "secret" });
    if (url.includes("clientSign=")) return new Response(null, { status: 302 });
    if (url.includes("sid=mimosgp"))
      return Response.json({ location: "https://mimo-server-sgp.xiaomimimo.com/sts" });
    if (url.endsWith("/sts")) {
      const headers = new Headers();
      headers.append("set-cookie", "serviceToken=live-session; Path=/");
      headers.append("set-cookie", "mimosgp_ph=ph; Path=/");
      headers.append("set-cookie", "mimosgp_slh=slh; Path=/");
      return new Response(null, { status: 302, headers });
    }
    throw new Error("Unexpected SSO destination");
  }) as typeof fetch;
  const firstCookie = await acquireMimoServiceSession({ passToken: "pass-test", userId: "user-test" }, fetchSso);
  expect(firstCookie).toContain("serviceToken=live-session");
  expect(await acquireMimoServiceSession({ passToken: "pass-test", userId: "user-test" }, fetchSso))
    .toBe(firstCookie);
  expect(ssoLegs).toBe(5);

  const registry = createDefaultProviderRegistry();
  const adapter = await registry.resolve("mimodesktop");
  if (!adapter) throw new Error("MiMo Desktop adapter missing");
  let releaseTail: (() => void) | undefined;
  const tailReady = new Promise<void>((resolve) => { releaseTail = resolve; });
  let tailSent = false;
  const sse = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(
        `data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n`,
      ));
      void tailReady.then(() => {
        controller.enqueue(encoder.encode(
          `data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        ));
        tailSent = true;
        controller.close();
      });
    },
  });
  let seenHeaders: Headers | undefined;
  let seenPayload: Record<string, unknown> | undefined;
  const outboundFetch: ValidatedFetch = async (_input, init) => {
    seenHeaders = new Headers(init?.headers);
    if (typeof init?.body === "string") seenPayload = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  };
  const request: CanonicalRequest = {
    model: "mimo-v2.6-flash",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    source_surface: "chat",
    stream: true,
  };
  const candidate: ProviderDispatchTarget = {
    provider_id: "mimodesktop", model_id: "mimo-v2.6-flash", wire_family: "chat",
    endpoint_path: "/api/route/chat/completions", capabilities: {},
  };
  const context: ProviderDispatchContext = {
    credential: {
      provider_id: "mimodesktop", account_id: "test", credential_kind: "oauth",
      secret: new TextEncoder().encode(JSON.stringify({ passToken: "pass-test", userId: "user-test" })),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: outboundFetch,
  };
  const events: CanonicalEvent[] = [];
  const iterator = adapter.dispatch(request, candidate, context)[Symbol.asyncIterator]();
  try {
    while (!events.some((event) => event.type === "content_delta")) {
      const first = await iterator.next();
      if (first.done) throw new Error("Desktop stream ended before the first delta");
      events.push(first.value);
    }
    expect(tailSent).toBe(false);
  } finally {
    releaseTail?.();
  }
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  expect(ssoLegs).toBe(5);
  expect(seenHeaders?.get("cookie")).toContain("serviceToken=live-session");
  expect(seenHeaders?.get("user-agent")).toBe(MIMO_API_UA);
  expect(seenHeaders?.get("x-mimo-source")).toBe("mimocode-cli-free");
  expect(seenHeaders?.get("x-client-version")).toBe("26.924.240030");
  expect(seenPayload?.["stream"]).toBe(true);
  expect(seenHeaders?.get("accept")).toBe("text/event-stream");
  expect(seenHeaders?.has("authorization")).toBe(false);
  expect(events.filter((event) => event.type === "content_delta").map((event) => event.content))
    .toEqual([{ kind: "reasoning", payload: null, summary: "thinking" }, { kind: "text", text: "answer" }]);
  expect(events.filter((event) => event.type === "terminal").map((event) => event.state)).toEqual(["complete"]);
  const nonStreaming = await MIMODESKTOP_SPEC.buildExtraHeaders?.(context, { ...request, stream: false }, candidate);
  expect(nonStreaming?.["Accept"]).toBe("application/json");
});
