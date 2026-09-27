import { describe, expect, test } from "bun:test";
import {
  parseMimoStudioCredential,
  buildMimoStudioCookieHeader,
} from "../../../../src/providers/integrations/xiaomi-mimo/mimostudio-auth";
import {
  MIMOSTUDIO_MODELS,
  resolveMimoStudioModelId,
  createMimoStudioAdapter,
} from "../../../../src/providers/integrations/xiaomi-mimo/mimostudio";
import { parseMimoStudioQuota } from "../../../../src/providers/integrations/xiaomi-mimo/mimostudio-quota";
import { createDefaultProviderRegistry } from "../../../../src/providers/default-registry";
import { providerDisplayName } from "../../../../dashboard/src/lib/provider-names";
import type { CanonicalRequest, ToolDefinition } from "../../../../src/transport/canonical-model";
import { GatewayError } from "../../../../src/transport/gateway-error";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../../src/providers/provider-registry";
import { MimoThinkSplitter } from "../../../../src/providers/integrations/xiaomi-mimo/think-stream";

test("splits MiMo think tags across chunks and strips NUL bytes", () => {
  const splitter = new MimoThinkSplitter();
  const first = splitter.push("answer <thi");
  const second = splitter.push("nk>\u0000thought");
  const third = splitter.push("</think> final");
  const last = splitter.flush();
  expect(first.text).toBe("answer ");
  expect(second.reasoning).toBe("thought");
  expect(third.text).toBe(" final");
  expect(last.text).toBe("");
});

describe("MiMo Studio provider integration", () => {
  test("parseMimoStudioCredential parses JSON, cURL, and Cookie-Editor export formats", () => {
    // 1. JSON
    const jsonStr = JSON.stringify({
      serviceToken: "st-token-123",
      userId: "6691605628",
      phToken: "ph-token-456",
    });
    const parsed1 = parseMimoStudioCredential(jsonStr);
    expect(parsed1.serviceToken).toBe("st-token-123");
    expect(parsed1.userId).toBe("6691605628");
    expect(parsed1.phToken).toBe("ph-token-456");

    // 2. cURL
    const curl = `curl 'https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=ph-abc-999' -H 'Cookie: userId=998877; serviceToken=st-xyz-111; other=foo'`;
    const parsed2 = parseMimoStudioCredential(curl);
    expect(parsed2.serviceToken).toBe("st-xyz-111");
    expect(parsed2.userId).toBe("998877");
    expect(parsed2.phToken).toBe("ph-abc-999");

    // 3. Cookie-Editor export array (like xiaomimimo.com-ame.json)
    const exportArray = JSON.stringify([
      {
        id: "1790445521344",
        name: "ame",
        cookies: [
          { name: "xiaomichatbot_serviceToken", value: '"st-token-from-extension"' },
          { name: "userId", value: "6874327696" },
          { name: "xiaomichatbot_ph", value: '"ph-token-from-extension"' },
        ],
      },
    ]);
    const parsed3 = parseMimoStudioCredential(exportArray);
    expect(parsed3.serviceToken).toBe("st-token-from-extension");
    expect(parsed3.userId).toBe("6874327696");
    expect(parsed3.phToken).toBe("ph-token-from-extension");
  });

  test("buildMimoStudioCookieHeader constructs correct cookie line", () => {
    const header = buildMimoStudioCookieHeader({
      serviceToken: "st-1",
      userId: "u-1",
      phToken: "ph-1",
    });
    expect(header).toContain("serviceToken=st-1");
    expect(header).toContain("userId=u-1");
    expect(header).toContain("xiaomichatbot_ph=ph-1");
  });

  test("model aliases resolve to canonical 2.6 flash and pro models", () => {
    expect(resolveMimoStudioModelId("mimo-v2.6-flash")).toBe("mimo-v2.6-flash");
    expect(resolveMimoStudioModelId("mimo-v2.6-pro")).toBe("mimo-v2.6-pro");
    expect(resolveMimoStudioModelId("mimo-x-flash")).toBe("mimo-v2.6-flash");
    expect(resolveMimoStudioModelId("mimo-x-pro")).toBe("mimo-v2.6-pro");
    expect(resolveMimoStudioModelId("mimo-flash")).toBe("mimo-v2.6-flash");
    expect(resolveMimoStudioModelId("mimo-pro")).toBe("mimo-v2.6-pro");
  });

  test("ultraspeed resolves to the Studio wire id and uses the fastchat endpoint", () => {
    expect(resolveMimoStudioModelId("mimo-v2.6-pro-ultraspeed")).toBe("mimo-v2.6-pro-ultraspeed-studio");
    expect(resolveMimoStudioModelId("mimo-v2.6-pro-ultraspeed-studio")).toBe("mimo-v2.6-pro-ultraspeed-studio");
    const byId = new Map(MIMOSTUDIO_MODELS.map((m) => [m.modelId, m]));
    expect(byId.get("mimo-v2.6-pro-ultraspeed")?.endpointPath).toBe("/fastchat/open-apis/bot/chat");
    expect(byId.get("mimo-v2.6-pro-ultraspeed-studio")?.endpointPath).toBe("/fastchat/open-apis/bot/chat");
    expect(byId.get("mimo-v2.6-pro")?.endpointPath).toBe("/open-apis/bot/chat");
  });

  test("advertised model catalog contains 2.6 flash and pro models", () => {
    const ids = MIMOSTUDIO_MODELS.map((m) => m.modelId);
    expect(ids).toContain("mimo-v2.6-flash");
    expect(ids).toContain("mimo-v2.6-pro");
    expect(ids).toContain("mimo-v2.6-pro-ultraspeed");
    expect(ids).toContain("mimo-v2.6-pro-ultraspeed-studio");
  });

  test("parseMimoStudioQuota extracts weekly quota accurately", () => {
    const raw = {
      code: 0,
      data: {
        percent: 98.4,
        resetDate: "2026-10-01",
        resetAt: 1790838698,
      },
    };
    const quota = parseMimoStudioQuota(raw);
    expect(quota.source).toBe("mimostudio");
    expect(quota.error).toBeNull();
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]!.usedPercent).toBe(1.6);
    expect(quota.windows[0]!.remainingPercent).toBe(98.4);
    expect(quota.windows[0]!.resetsAt).toBe(new Date(1790838698 * 1000).toISOString());
  });

  test("registry resolves mimostudio adapter, models, and quota collector", async () => {
    const registry = createDefaultProviderRegistry();
    const adapter = await registry.resolve("mimostudio");
    expect(adapter).toBeDefined();
    expect(adapter?.provider_id).toBe("mimostudio");

    const collector = await registry.resolveQuotaCollector("mimostudio");
    expect(collector).toBeDefined();

    expect(providerDisplayName("mimostudio")).toBe("MiMo Studio");
  });

  test("adapter streams SSE content_delta, usage, and terminal events", async () => {
    const mockSseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message\ndata: {\"content\":\"Hello\"}\n\n"));
        controller.enqueue(new TextEncoder().encode("event: message\ndata: {\"content\":\" world\"}\n\n"));
        controller.enqueue(new TextEncoder().encode("event: usage\ndata: {\"promptTokens\":10,\"completionTokens\":5}\n\n"));
        controller.enqueue(new TextEncoder().encode("event: finish\ndata: {}\n\n"));
        controller.close();
      },
    });

    let outbound: RequestInit | undefined;
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound = init;
      return new Response(mockSseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = createMimoStudioAdapter({ fetch: mockFetch });
    const request = {
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      model: "mimo-v2.6-flash",
    } as unknown as CanonicalRequest;
    const candidate = {
      provider_id: "mimostudio",
      model_id: "mimo-v2.6-flash",
      endpoint_path: "/open-apis/bot/chat",
      wire_family: "chat",
    } as unknown as ProviderDispatchTarget;
    const context = {
      credential: {
        credential_kind: "api_key",
        secret: new TextEncoder().encode(
          JSON.stringify({ serviceToken: "st-test", userId: "u-test", phToken: "ph-test" }),
        ),
      },
    } as unknown as ProviderDispatchContext;

    const events = [];
    for await (const event of adapter.dispatch(request, candidate, context)) {
      events.push(event);
    }

    const textDeltas = events.filter((e) => e.type === "content_delta");
    expect(textDeltas).toHaveLength(2);
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events.some((e) => e.type === "terminal")).toBe(true);
    const headers = new Headers(outbound?.headers);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("origin")).toBe("https://aistudio.xiaomimimo.com");
    expect(headers.get("referer")).toBe("https://aistudio.xiaomimimo.com/");
    expect(headers.get("x-timezone")).toBe("Asia/Shanghai");
    expect(headers.get("cookie")).toContain("serviceToken=st-test");
    expect(headers.has("authorization")).toBe(false);
    expect(outbound?.signal).toBe(context.abort_signal);
  });
  test("reuses one Studio conversation per client session and separates concurrent callers", async () => {
    const bodies: Record<string, unknown>[] = [];
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("event: finish\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = createMimoStudioAdapter({ fetch: mockFetch });
    const candidate: ProviderDispatchTarget = {
      provider_id: "mimostudio",
      model_id: "mimo-v2.6-flash",
      endpoint_path: "/open-apis/bot/chat",
      wire_family: "chat",
      capabilities: {},
    };
    const contextFor = (sessionId?: string): ProviderDispatchContext => ({
      credential: {
        provider_id: "mimostudio",
        account_id: "acct-1",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(JSON.stringify({ serviceToken: "st", userId: "uid", phToken: "ph" })),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
      ...(sessionId === undefined ? {} : { request_headers: { "x-session-id": sessionId } }),
    });
    const turn = (messages: CanonicalRequest["messages"]): CanonicalRequest => ({
      model: "mimo-v2.6-flash",
      messages,
      generation_controls: {},
      source_surface: "chat",
      stream: true,
    });
    const user = (text: string) => ({ role: "user" as const, content: [{ kind: "text" as const, text }] });
    const assistant = (text: string) => ({ role: "assistant" as const, content: [{ kind: "text" as const, text }] });
    const first = turn([user("halo")]);
    const followUp = turn([user("halo"), assistant("hai"), user("lanjut")]);

    const run = async (request: CanonicalRequest, context: ProviderDispatchContext) => {
      const events = [];
      for await (const event of adapter.dispatch(request, candidate, context)) events.push(event);
      expect(events.some((event) => event.type === "terminal")).toBe(true);
    };

    // The same client session continues its own upstream conversation.
    await run(first, contextFor("chat-a"));
    await run(followUp, contextFor("chat-a"));
    expect(bodies[1]?.["conversationId"]).toBe(bodies[0]?.["conversationId"]);

    // A different caller on the same account never shares that conversation.
    await run(first, contextFor("chat-b"));
    expect(bodies[2]?.["conversationId"]).not.toBe(bodies[0]?.["conversationId"]);
    expect(String(bodies[0]?.["conversationId"])).toMatch(/^conv_[0-9a-f]{24}$/);

    // Without a client session id, only a real history continuation may reuse.
    const soloA = turn([user("tanya-a")]);
    const soloB = turn([user("tanya-b")]);
    await run(soloA, contextFor());
    await run(soloB, contextFor());
    expect(bodies[4]?.["conversationId"]).not.toBe(bodies[3]?.["conversationId"]);
    await run(turn([user("tanya-a"), assistant("ok"), user("lagi")]), contextFor());
    expect(bodies[5]?.["conversationId"]).toBe(bodies[3]?.["conversationId"]);
    await run(turn([user("tanya-b"), assistant("ok"), user("lagi")]), contextFor());
    expect(bodies[6]?.["conversationId"]).toBe(bodies[4]?.["conversationId"]);

    // An identical opening message is not a continuation of an earlier chat.
    await run(soloA, contextFor());
    expect(bodies[7]?.["conversationId"]).not.toBe(bodies[3]?.["conversationId"]);

    // Every request still carries a fresh message id.
    expect(bodies[1]?.["msgId"]).not.toBe(bodies[0]?.["msgId"]);

    // The reused conversation already holds the earlier turns upstream, so the
    // follow-up sends only what is new — replaying the whole history is what
    // pushed a long chat over the endpoint's ~50k-character `query` limit.
    const followUpQuery = String(bodies[1]?.["query"]);
    expect(String(bodies[0]?.["query"])).toContain("halo");
    expect(followUpQuery).not.toContain("halo");
    expect(followUpQuery).toContain("lanjut");
    expect(followUpQuery.match(/\[当前问题\]/g)).toHaveLength(1);
  });

  test("turns MiMo tool blocks into canonical tool calls and carries the tool contract in the prompt", async () => {
    const bodies: Record<string, unknown>[] = [];
    const answer =
      "<think>calling</think><tool_call><function=write>" +
      "<parameter=path>C:/temp/a.txt</parameter><parameter=content>hi</parameter>" +
      "</function></tool_call>";
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        `event: message\ndata: ${JSON.stringify({ content: answer })}\n\nevent: finish\ndata: {}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createMimoStudioAdapter({ fetch: mockFetch });
    const candidate: ProviderDispatchTarget = {
      provider_id: "mimostudio",
      model_id: "mimo-v2.6-pro-ultraspeed",
      endpoint_path: "/fastchat/open-apis/bot/chat",
      wire_family: "chat",
      capabilities: {},
    };
    const context: ProviderDispatchContext = {
      credential: {
        provider_id: "mimostudio",
        account_id: "acct-tools",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(JSON.stringify({ serviceToken: "st", userId: "uid", phToken: "ph" })),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    const tools: readonly ToolDefinition[] = [
      { name: "write", description: "Write a file", jsonSchema: { type: "object" } },
    ];

    const run = async (request: CanonicalRequest) => {
      const events = [];
      for await (const event of adapter.dispatch(request, candidate, context)) events.push(event);
      return events;
    };

    const toolTurn = await run({
      model: "mimo-v2.6-pro-ultraspeed",
      messages: [{ role: "user", content: [{ kind: "text", text: "write hi" }] }],
      generation_controls: {},
      source_surface: "chat",
      stream: true,
      tools,
    });

    // The endpoint ignores a `tools` field, so the contract travels in the prompt.
    const prompt = String(bodies[0]?.["query"]);
    expect(prompt).toContain("<tool_call>");
    expect(prompt).toContain("- write: Write a file");
    expect(bodies[0]?.["tools"]).toBeUndefined();

    const calls = toolTurn.filter((event) => event.type === "tool_call_delta");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "write",
      arguments_delta: JSON.stringify({ path: "C:/temp/a.txt", content: "hi" }),
    });
    // The block itself must not leak to the client as prose.
    const leaked = toolTurn
      .flatMap((event) =>
        event.type === "content_delta" && event.content.kind === "text" ? [event.content.text] : [],
      )
      .join("");
    expect(leaked).not.toContain("<tool_call>");
    expect(toolTurn.find((event) => event.type === "terminal")).toMatchObject({
      state: "complete",
      stop_reason: "tool_use",
    });

    // History tool calls and results are replayed in the model's own convention.
    const history = await run({
      model: "mimo-v2.6-pro-ultraspeed",
      messages: [
        { role: "user", content: [{ kind: "text", text: "write hi" }] },
        {
          role: "assistant",
          content: [
            { kind: "toolCall", call_id: "c1", name: "write", arguments: JSON.stringify({ path: "C:/temp/a.txt", content: "hi" }) },
          ],
        },
        { role: "tool", content: [{ kind: "toolResult", call_id: "c1", content: "wrote 2 bytes" }] },
        { role: "user", content: [{ kind: "text", text: "thanks" }] },
      ],
      generation_controls: {},
      source_surface: "chat",
      stream: true,
      tools,
    });
    expect(history.some((event) => event.type === "terminal")).toBe(true);
    const replayPrompt = String(bodies[1]?.["query"]);
    expect(replayPrompt).toContain("<function=write>");
    expect(replayPrompt).toContain("<tool_result>");
    expect(replayPrompt).toContain("wrote 2 bytes");
    // A `tool` turn has no upstream role, so it travels as a user turn.
    expect(replayPrompt).toContain("user: <tool_result>");

    // With no declared tools a block is prose, never an invented call.
    const noTools = await run({
      model: "mimo-v2.6-pro-ultraspeed",
      messages: [{ role: "user", content: [{ kind: "text", text: "write hi" }] }],
      generation_controls: {},
      source_surface: "chat",
      stream: true,
    });
    expect(noTools.some((event) => event.type === "tool_call_delta")).toBe(false);
    expect(String(bodies[2]?.["query"])).not.toContain("You can call tools");
  });

  test("keeps the query inside the endpoint limit and resends from the turn the upstream actually received", async () => {
    const bodies: Record<string, unknown>[] = [];
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("event: finish\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = createMimoStudioAdapter({ fetch: mockFetch });
    const candidate: ProviderDispatchTarget = {
      provider_id: "mimostudio",
      model_id: "mimo-v2.6-flash",
      endpoint_path: "/open-apis/bot/chat",
      wire_family: "chat",
      capabilities: {},
    };
    const context: ProviderDispatchContext = {
      credential: {
        provider_id: "mimostudio",
        account_id: "acct-long",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(JSON.stringify({ serviceToken: "st", userId: "uid", phToken: "ph" })),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
      request_headers: { "x-session-id": "long-chat" },
    };
    const filler = "f".repeat(4_000);
    const messages: { role: "user" | "assistant"; content: { kind: "text"; text: string }[] }[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "user", content: [{ kind: "text", text: `TURN${i}MARK ${filler}` }] });
      messages.push({ role: "assistant", content: [{ kind: "text", text: `${i} ok` }] });
    }
    messages.push({ role: "user", content: [{ kind: "text", text: "FINAL QUESTION" }] });
    const request: CanonicalRequest = {
      model: "mimo-v2.6-flash",
      messages,
      generation_controls: {},
      source_surface: "chat",
      stream: true,
    };

    const run = async (input: CanonicalRequest) => {
      for await (const _event of adapter.dispatch(input, candidate, context)) {
        // Drain.
      }
    };

    await run(request);
    const firstQuery = String(bodies[0]?.["query"]);
    // The endpoint rejects a `query` above 50 000 characters.
    expect(firstQuery.length).toBeLessThanOrEqual(48_000 + 200);
    expect(firstQuery).toContain("FINAL QUESTION");
    expect(firstQuery).toContain("[提示]");
    // The oldest turns were the ones dropped.
    expect(firstQuery).not.toContain("TURN0MARK");
    expect(firstQuery).toContain("TURN29MARK");

    // The next turn resumes from the turns the upstream actually received, not
    // from the whole history: only the new question is sent.
    await run({
      ...request,
      messages: [...messages, { role: "assistant", content: [{ kind: "text", text: "answered" }] }, { role: "user", content: [{ kind: "text", text: "SECOND QUESTION" }] }],
    });
    const secondQuery = String(bodies[1]?.["query"]);
    expect(secondQuery).toContain("SECOND QUESTION");
    expect(secondQuery).not.toContain("FINAL QUESTION");
    expect(secondQuery.length).toBeLessThan(firstQuery.length);
  });

  test("surfaces an upstream error frame as a typed gateway error instead of a truncated stream", async () => {
    const request: CanonicalRequest = {
      model: "mimo-v2.6-pro-ultraspeed",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      source_surface: "chat",
      stream: true,
    };
    const candidate: ProviderDispatchTarget = {
      provider_id: "mimostudio",
      model_id: "mimo-v2.6-pro-ultraspeed",
      endpoint_path: "/fastchat/open-apis/bot/chat",
      wire_family: "chat",
      capabilities: {},
    };
    const context: ProviderDispatchContext = {
      credential: {
        provider_id: "mimostudio",
        account_id: "test",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(JSON.stringify({ serviceToken: "st", userId: "uid", phToken: "ph" })),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    const cases = [
      { frame: "query is too long", code: "context_length_exceeded", status: 413 },
      { frame: "Request processed. Please do not submit repeatedly", code: "upstream_conflict", status: 409 },
      { frame: "模型名称错误", code: "upstream_unprocessable", status: 422 },
      { frame: "", code: "upstream_unprocessable", status: 422 },
    ] as const;
    for (const { frame, code, status } of cases) {
      const fetcher = (async () => new Response(
        `event:error\ndata:${JSON.stringify({ type: "text", content: frame, usage: null })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
      let thrown: unknown;
      try {
        for await (const _event of createMimoStudioAdapter({ fetch: fetcher }).dispatch(request, candidate, context)) {
          // `response_start` is emitted before the upstream is read; no content
          // or terminal event may follow an error frame.
          if (_event.type !== "response_start") throw new Error(`unexpected event after error frame: ${_event.type}`);
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GatewayError);
      const gatewayError = thrown as GatewayError;
      expect(gatewayError.code).toBe(code);
      expect(gatewayError.status).toBe(status);
      expect(gatewayError.origin).toBe("upstream");
    }
  });

  test("reports a cut-off SSE stream as failed and emits at most one terminal", async () => {
    const request: CanonicalRequest = {
      model: "mimo-v2.6-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      source_surface: "chat",
      stream: true,
    };
    const candidate: ProviderDispatchTarget = {
      provider_id: "mimostudio",
      model_id: "mimo-v2.6-flash",
      endpoint_path: "/open-apis/bot/chat",
      wire_family: "chat",
      capabilities: {},
    };
    const context: ProviderDispatchContext = {
      credential: {
        provider_id: "mimostudio",
        account_id: "test",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(JSON.stringify({ serviceToken: "st", userId: "uid", phToken: "ph" })),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    for (const [suffix, expectedState] of [
      ["", "failed"],
      ["event: finish\ndata: {}\n\ndata: [DONE]\n\n", "complete"],
    ] as const) {
      const fetcher = (async () => new Response(
        `event: message\ndata: {"content":"partial"}\n\n${suffix}`,
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
      const events = [];
      for await (const event of createMimoStudioAdapter({ fetch: fetcher }).dispatch(request, candidate, context))
        events.push(event);
      expect(events.filter((event) => event.type === "terminal").map((event) => event.state))
        .toEqual([expectedState]);
      expect(events.some((event) => event.type === "content_delta" && event.content.kind === "text" && event.content.text === "partial"))
        .toBe(true);
    }
  });
});
