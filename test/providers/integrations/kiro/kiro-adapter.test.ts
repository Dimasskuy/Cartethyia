/**
 * Kiro adapter dispatch.
 *
 * These exercise the real adapter over a fake transport, so they pin the
 * decisions that would otherwise only fail against the live upstream: which
 * endpoint is tried first and which refusals rotate, which auth families get a
 * `TokenType` header and which get the shared profile placeholder, and how an
 * EventStream answer becomes canonical events.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CanonicalEvent, CanonicalRequest } from "../../../../src/transport/canonical-model";
import { GatewayError } from "../../../../src/transport/gateway-error";
import {
  createKiroAdapter,
  kiroEffortPath,
  kiroEndpoint,
  kiroHeaders,
} from "../../../../src/providers/integrations/kiro/kiro";
import { crc32 } from "../../../../src/providers/integrations/kiro/aws-event-stream";
import { VERSION_SOURCES, _resetKiroVersion } from "../../../../src/providers/operations/client-versions";

const ACCOUNT_PROFILE = "arn:aws:codewhisperer:us-east-1:111122223333:profile/ACCOUNT";
/**
 * The public default for a Builder ID account that resolved no profile of its
 * own. Verified against the live surface: a Builder ID token reaches generation
 * with this ARN and is answered `200`, while the same request without the field
 * is answered `400 profileArn is required for this request.`
 */
const BUILDER_DEFAULT_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
/** A device id in the shape the upstream accepts, so a fixture is never why a header is blank. */
const MACHINE_ID = "a".repeat(64);

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-sonnet-4.5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
    ...overrides,
  };
}

function candidate(modelId = "claude-sonnet-4.5") {
  return {
    provider_id: "kiro" as const,
    model_id: modelId,
    wire_family: "chat" as const,
    endpoint_path: "/generateAssistantResponse",
    capabilities: {},
  };
}

function context(authMethod: string, profileArn?: string, region = "us-east-1", machineId = MACHINE_ID) {
  return {
    credential: {
      provider_id: "kiro" as const,
      account_id: "account-1",
      credential_kind: "oauth" as const,
      secret: new TextEncoder().encode("token-value"),
      auth_state: {
        authMethod,
        region,
        machineId,
        ...(profileArn === undefined ? {} : { profileArn }),
      },
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

/**
 * Wraps a plain function as a `fetch` the adapter accepts.
 *
 * The adapter only ever calls the function, so the extra members `typeof fetch`
 * carries are irrelevant here; this keeps the fake honest without casting.
 */
function asFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

/** Captures the conversation id each dispatch sends, for stability assertions. */
function conversationIds(): { ids: string[]; fetch: typeof fetch } {
  const ids: string[] = [];
  const fetchImpl = asFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      conversationState?: { conversationId?: string };
    };
    if (typeof body.conversationState?.conversationId === "string") {
      ids.push(body.conversationState.conversationId);
    }
    return bytesResponse(frame("messageStopEvent", { stopReason: "end_turn" }));
  });
  return { ids, fetch: fetchImpl };
}

/** Encodes one EventStream message with valid CRCs and the given headers. */
function encodeFrame(headers: Record<string, string>, payload: unknown): Buffer {
  const headerBytes = Buffer.concat(
    Object.entries(headers).map(([key, value]) => {
      const name = Buffer.from(key, "utf8");
      const encoded = Buffer.from(value, "utf8");
      const head = Buffer.alloc(1 + name.length + 1 + 2);
      head.writeUInt8(name.length, 0);
      name.copy(head, 1);
      head.writeUInt8(7, 1 + name.length);
      head.writeUInt16BE(encoded.length, 2 + name.length);
      return Buffer.concat([head, encoded]);
    }),
  );
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = 12 + headerBytes.length + payloadBytes.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(totalLength, 0);
  prelude.writeUInt32BE(headerBytes.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const body = Buffer.concat([prelude, headerBytes, payloadBytes]);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([body, trailer]);
}

/** Encodes one EventStream message carrying an event type. */
function frame(eventType: string, payload: unknown): Buffer {
  return encodeFrame({ ":message-type": "event", ":event-type": eventType }, payload);
}

/** A `Response` whose body is a byte sequence the decoder can read. */
function bytesResponse(bytes: Buffer, status = 200): Response {
  return new Response(new Uint8Array(bytes), { status });
}

/** Collects a dispatch's events. */
async function drain(
  adapter: ReturnType<typeof createKiroAdapter>,
  req: CanonicalRequest,
  ctx: ReturnType<typeof context>,
): Promise<readonly CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of adapter.dispatch(req, candidate(), ctx)) events.push(event);
  return events;
}

describe("kiroEndpoint", () => {
  test("is the single generation surface, in the account's region", () => {
    expect(kiroEndpoint({ authMethod: "api_key", region: "us-east-1" })).toBe(
      "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    );
    expect(kiroEndpoint({ authMethod: "idc", region: "eu-west-1" })).toBe(
      "https://q.eu-west-1.amazonaws.com/generateAssistantResponse",
    );
  });

  test("never names another service entry the real client does not call", () => {
    for (const authMethod of ["builder-id", "idc", "api_key", "external_idp", "google", "imported"]) {
      const url = kiroEndpoint({ authMethod, region: "us-east-1" });
      expect(url).not.toContain("codewhisperer.");
      expect(url).not.toContain("kiro.dev");
    }
  });

  test("falls back to us-east-1 for a region that is not an AWS region", () => {
    expect(kiroEndpoint({ authMethod: "idc", region: "not a region" })).toContain("q.us-east-1.amazonaws.com");
  });
});

describe("kiroHeaders", () => {
  const headersFor = (authMethod: string, profileArn?: string, machineId = MACHINE_ID) =>
    kiroHeaders("t", {
      authMethod,
      region: "us-east-1",
      machineId,
      ...(profileArn === undefined ? {} : { profileArn }),
    }, machineId);

  test("carries the device identity the upstream correlates on", () => {
    const headers = headersFor("builder-id");
    const version = VERSION_SOURCES.kiro.fallback;
    expect(headers["user-agent"]).toBe(
      `aws-sdk-js/1.0.39 ua/2.1 os/win32#10.0.22631 lang/js md/nodejs#24.18.0 ` +
        `api/codewhispererstreaming#1.0.39 m/E KiroIDE-${version}-${MACHINE_ID}`,
    );
    expect(headers["x-amz-user-agent"]).toBe(`aws-sdk-js/1.0.39 KiroIDE-${version}-${MACHINE_ID}`);
  });

  test("closes the connection so one session never carries two accounts", () => {
    expect(headersFor("builder-id").connection).toBe("close");
  });

  test("opts out of data collection and declares the agent mode", () => {
    const headers = headersFor("builder-id");
    expect(headers["x-amzn-codewhisperer-optout"]).toBe("true");
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("spec");
  });

  test("never sends the bearer a second time under a header the real client omits", () => {
    expect(headersFor("builder-id")["x-amz-sso-bearer"]).toBeUndefined();
  });

  test("declares the API key token type and never a profile for an account-bound key", () => {
    const headers = headersFor("api_key");
    expect(headers["tokentype"]).toBe("API_KEY");
    expect(headers["x-amzn-codewhisperer-profile-arn"]).toBeUndefined();
  });

  test("declares the external IdP token type", () => {
    expect(headersFor("external_idp", ACCOUNT_PROFILE)["tokentype"]).toBe("EXTERNAL_IDP");
  });

  test("sends no token type header for an ordinary OAuth token", () => {
    const headers = headersFor("builder-id");
    expect(headers["tokentype"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer t");
  });

  test("carries no profile ARN header: the ARN travels in the body", () => {
    // The generation surface scopes a request by the `profileArn` body field.
    // The header form belongs to a different endpoint, so sending it here would
    // be a field the real client never produces.
    expect(headersFor("external_idp", ACCOUNT_PROFILE)["x-amzn-codewhisperer-profile-arn"]).toBeUndefined();
    expect(headersFor("builder-id")["x-amzn-codewhisperer-profile-arn"]).toBeUndefined();
  });
});

describe("kiroEffortPath", () => {
  test("selects the reasoning schema for the GPT family", () => {
    expect(kiroEffortPath("gpt-5.6-sol")).toBe("reasoning");
  });

  test("selects the output_config schema for newer Claude models", () => {
    expect(kiroEffortPath("claude-sonnet-5")).toBe("output_config");
    expect(kiroEffortPath("claude-opus-4.8")).toBe("output_config");
  });

  test("sends no effort field for the generation that rejects it", () => {
    expect(kiroEffortPath("claude-sonnet-4.5")).toBeUndefined();
    expect(kiroEffortPath("claude-opus-4.5")).toBeUndefined();
  });

  test("sends no effort field for a model outside both schemas", () => {
    expect(kiroEffortPath("deepseek-3.2")).toBeUndefined();
  });
});

describe("KiroAdapter dispatch", () => {
  beforeEach(() => _resetKiroVersion(VERSION_SOURCES.kiro.fallback));
  afterEach(() => _resetKiroVersion());
  test("posts the ledger to the one generation surface, with the account's device identity", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const adapter = createKiroAdapter({
      fetch: asFetch(async (input, init) => {
        calls.push({
          url: String(input),
          body: String(init?.body ?? ""),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return bytesResponse(frame("messageStopEvent", { stopReason: "end_turn" }));
      }),
    });
    const events = await drain(adapter, request(), context("builder-id"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse");
    const body = JSON.parse(calls[0]?.body ?? "{}") as { conversationState?: { chatTriggerType?: string } };
    expect(body.conversationState?.chatTriggerType).toBe("MANUAL");
    expect(events.some((event) => event.type === "terminal")).toBe(true);
    const version = VERSION_SOURCES.kiro.fallback;
    expect(calls[0]?.headers["user-agent"]).toContain(`KiroIDE-${version}-${MACHINE_ID}`);
    expect(calls[0]?.headers["x-amz-user-agent"]).toBe(`aws-sdk-js/1.0.39 KiroIDE-${version}-${MACHINE_ID}`);
    expect(calls[0]?.headers.connection).toBe("close");
  });

  test("uses the fetched Kiro IDE version on inference requests", async () => {
    _resetKiroVersion();
    let requestHeaders: Record<string, string> | undefined;
    const adapter = createKiroAdapter({
      fetch: asFetch(async (input, init) => {
        const url = String(input);
        if (url === VERSION_SOURCES.kiro.sources[0]?.url)
          return new Response(String.raw`<script>\"currentVersion\":\"1.1.71\"</script>`, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        requestHeaders = (init?.headers ?? {}) as Record<string, string>;
        return bytesResponse(frame("messageStopEvent", { stopReason: "end_turn" }));
      }),
    });
    await drain(adapter, request(), context("builder-id"));
    expect(requestHeaders?.["user-agent"]).toContain(`KiroIDE-1.1.71-${MACHINE_ID}`);
    expect(requestHeaders?.["x-amz-user-agent"]).toBe(`aws-sdk-js/1.0.39 KiroIDE-1.1.71-${MACHINE_ID}`);
  });

  test("reports a refusal instead of scanning other service entries with the same token", async () => {
    const urls: string[] = [];
    const adapter = createKiroAdapter({
      fetch: asFetch(async (input) => {
        urls.push(String(input));
        return new Response(
          JSON.stringify({ message: "Your User ID is temporarily suspended." }),
          { status: 403 },
        );
      }),
    });
    await expect(drain(adapter, request(), context("idc"))).rejects.toThrow(GatewayError);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("q.us-east-1.amazonaws.com");
  });

  test("keeps one conversation id across the turns of a session, so the upstream can cache", async () => {
    // The upstream scopes its prompt cache to the conversation, so an id that
    // changes per request makes every turn re-read the whole ledger. A client
    // that sends no id gets the affinity key derived from its opening turn,
    // which is the same value on each turn of that conversation.
    const { ids, fetch } = conversationIds();
    const adapter = createKiroAdapter({ fetch });
    const ctx = context("builder-id");
    await drain(
      adapter,
      request({ messages: [{ role: "user", content: [{ kind: "text", text: "opening question about the deployment pipeline" }] }] }),
      ctx,
    );
    await drain(
      adapter,
      request({
        messages: [
          { role: "user", content: [{ kind: "text", text: "opening question about the deployment pipeline" }] },
          { role: "assistant", content: [{ kind: "text", text: "answer" }] },
          { role: "user", content: [{ kind: "text", text: "follow-up" }] },
        ],
      }),
      ctx,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  test("honours a conversation id the client supplied", async () => {
    const { ids, fetch } = conversationIds();
    const adapter = createKiroAdapter({ fetch });
    await drain(
      adapter,
      request({ conversation: { conversation_id: "client-supplied-id" } }),
      context("builder-id"),
    );
    expect(ids).toEqual(["client-supplied-id"]);
  });

  test("honours an inbound session header over the derived affinity key", async () => {
    const { ids, fetch } = conversationIds();
    const adapter = createKiroAdapter({ fetch });
    const ctx = { ...context("builder-id"), request_headers: { "x-session-id": "header-session" } };
    await drain(adapter, request(), ctx);
    expect(ids).toEqual(["header-session"]);
  });

  test("sends the sign-in family's public default when the account resolved none", async () => {
    // Verified against the live surface: a Builder ID token reaches generation
    // with this ARN and is answered `200`, while the same request with the field
    // omitted is answered `400 profileArn is required for this request.` The ARN
    // is part of the wire contract for the family, not a stand-in for an identity
    // the account has.
    let body = "";
    const adapter = createKiroAdapter({
      fetch: asFetch(async (_input, init) => {
        body = String(init?.body ?? "");
        return bytesResponse(frame("messageStopEvent", { stopReason: "end_turn" }));
      }),
    });
    await drain(adapter, request(), context("builder-id"));
    expect(JSON.parse(body).profileArn).toBe(BUILDER_DEFAULT_PROFILE);
  });

  test("sends the account's own profile when it resolved one", async () => {
    let body = "";
    const adapter = createKiroAdapter({
      fetch: asFetch(async (_input, init) => {
        body = String(init?.body ?? "");
        return bytesResponse(frame("messageStopEvent", { stopReason: "end_turn" }));
      }),
    });
    await drain(adapter, request(), context("external_idp", ACCOUNT_PROFILE));
    expect(JSON.parse(body).profileArn).toBe(ACCOUNT_PROFILE);
  });

  test("never sends a default to a credential that is scoped by the credential itself", async () => {
    // An API key is account-bound: the key names the account, and a profile the
    // key does not own is refused. Sending it a default would scope the request
    // to a subscription the credential has no claim to.
    let body = "";
    const adapter = createKiroAdapter({
      fetch: asFetch(async (_input, init) => {
        body = String(init?.body ?? "");
        return bytesResponse(frame("messageStopEvent", { stopReason: "end_turn" }));
      }),
    });
    await drain(adapter, request(), context("api_key"));
    expect(JSON.parse(body)).not.toHaveProperty("profileArn");
  });

  test("sends the social default for the social sign-in families", async () => {
    // The builder default under a social token is answered `403 Invalid token`,
    // so the family picks the default — a social account must not be scoped to
    // the builder profile.
    let body = "";
    const adapter = createKiroAdapter({
      fetch: asFetch(async (_input, init) => {
        body = String(init?.body ?? "");
        return bytesResponse(frame("messageStopEvent", { stopReason: "end_turn" }));
      }),
    });
    await drain(adapter, request(), context("google"));
    expect(JSON.parse(body).profileArn).toBe(
      "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
    );
  });

  test("carries the resolved profile ARN for an account that has one", async () => {
    let body = "";
    const adapter = createKiroAdapter({
      fetch: asFetch(async (_input, init) => {
        body = String(init?.body ?? "");
        return bytesResponse(frame("messageStopEvent", { stopReason: "end_turn" }));
      }),
    });
    await drain(adapter, request(), context("external_idp", ACCOUNT_PROFILE));
    expect(body).toContain(ACCOUNT_PROFILE);
  });

  test("refuses a conversation the upstream would reject, without a request", async () => {
    let called = false;
    const adapter = createKiroAdapter({
      fetch: asFetch(async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }),
    });
    const req = request({
      messages: [
        { role: "user", content: [{ kind: "text", text: "go" }] },
        { role: "assistant", content: [{ kind: "toolCall", call_id: "c1", name: "undefined_tool", arguments: {} }] },
        { role: "tool", content: [{ kind: "toolResult", call_id: "c1", content: "ok" }] },
      ],
    });
    await expect(drain(adapter, req, context("builder-id"))).rejects.toThrow(GatewayError);
    expect(called).toBe(false);
  });

  test("rejects a dispatch with no credential", async () => {
    const adapter = createKiroAdapter({ fetch: asFetch(async () => new Response("", { status: 200 })) });
    const ctx = context("builder-id");
    const empty = {
      ...ctx,
      credential: { ...ctx.credential, secret: new Uint8Array() },
    };
    await expect(drain(adapter, request(), empty)).rejects.toThrow(GatewayError);
  });

  test("maps text, reasoning and tool events onto canonical events", async () => {
    const adapter = createKiroAdapter({
      fetch: asFetch(async () =>
        bytesResponse(
          Buffer.concat([
            frame("assistantResponseEvent", { content: "hello " }),
            frame("reasoningContentEvent", { text: "thinking" }),
            frame("toolUseEvent", { name: "search", toolUseId: "call-1", input: { q: "x" } }),
            frame("metricsEvent", { metricsEvent: { inputTokens: 5, outputTokens: 7 } }),
            frame("messageStopEvent", { stopReason: "tool_use" }),
          ]),
        )),
    });
    const events = await drain(adapter, request(), context("builder-id"));
    const texts = events.filter((event) => event.type === "content_delta").map((event) => event.content);
    expect(texts).toContainEqual({ kind: "text", text: "hello " });
    expect(texts.some((part) => part.kind === "reasoning")).toBe(true);
    const toolCall = events.find((event) => event.type === "tool_call_delta");
    expect(toolCall?.type === "tool_call_delta" ? toolCall.name : undefined).toBe("search");
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal?.type === "terminal" ? terminal.stop_reason : undefined).toBe("tool_use");
    expect(terminal?.type === "terminal" ? terminal.usage?.output_tokens : undefined).toBe(7);
  });

  test("recovers a token count from the context percentage the upstream reports", async () => {
    // This surface sends no token field at all — only a percentage of the model's
    // window. Reporting 0 for input and output is what made Kiro the one provider
    // whose tokens never showed up in the usage view.
    const adapter = createKiroAdapter({
      fetch: asFetch(async () =>
        bytesResponse(
          Buffer.concat([
            frame("assistantResponseEvent", { content: "a".repeat(40) }),
            frame("contextUsageEvent", { contextUsagePercentage: 2 }),
            frame("meteringEvent", { unit: "credit", usage: 0.05 }),
            frame("messageStopEvent", { stopReason: "end_turn" }),
          ]),
        )),
    });
    const events = await drain(adapter, request(), context("builder-id"));
    const terminal = events.find((event) => event.type === "terminal");
    const usage = terminal?.type === "terminal" ? terminal.usage : undefined;
    // 2% of the 500k window is 10000 tokens for the whole turn; the 40-character
    // answer is 10 of them, so the prompt is the rest.
    expect(usage?.output_tokens).toBe(10);
    expect(usage?.input_tokens).toBe(9_990);
    expect(usage?.total_tokens).toBe(10_000);
    expect(usage?.credit_used).toBe(0.05);
  });

  test("counts reasoning and tool arguments as output", async () => {
    // Reasoning is generated and billed as output, and a tool call's arguments
    // are generated text too; counting only the visible answer would understate
    // the completion side and inflate the derived prompt by the same amount.
    const adapter = createKiroAdapter({
      fetch: asFetch(async () =>
        bytesResponse(
          Buffer.concat([
            frame("reasoningContentEvent", { text: "b".repeat(40) }),
            frame("toolUseEvent", { name: "search", toolUseId: "c1", input: { q: "c".repeat(40) } }),
            frame("contextUsageEvent", { contextUsagePercentage: 2 }),
            frame("messageStopEvent", { stopReason: "tool_use" }),
          ]),
        )),
    });
    const events = await drain(adapter, request(), context("builder-id"));
    const terminal = events.find((event) => event.type === "terminal");
    const usage = terminal?.type === "terminal" ? terminal.usage : undefined;
    expect(usage?.output_tokens).toBeGreaterThan(10);
    expect(usage?.total_tokens).toBe(10_000);
  });

  test("reports no tokens rather than a fabricated count when the percentage never arrives", async () => {
    // Without the percentage there is no measurement to scale, and a guessed
    // number would be indistinguishable from a real one in the usage view.
    const adapter = createKiroAdapter({
      fetch: asFetch(async () =>
        bytesResponse(
          Buffer.concat([
            frame("assistantResponseEvent", { content: "hello" }),
            frame("messageStopEvent", { stopReason: "end_turn" }),
          ]),
        )),
    });
    const events = await drain(adapter, request(), context("builder-id"));
    const terminal = events.find((event) => event.type === "terminal");
    const usage = terminal?.type === "terminal" ? terminal.usage : undefined;
    expect(usage?.input_tokens).toBe(0);
    expect(usage?.output_tokens).toBe(0);
  });

  test("restores the caller's tool name on the way back", async () => {
    const adapter = createKiroAdapter({
      fetch: asFetch(async () =>
        bytesResponse(Buffer.concat([frame("toolUseEvent", { name: "my_tool_search", toolUseId: "c1", input: {} })])),
      ),
    });
    const req = request({
      tools: [{ name: "my.tool/search", description: "d", jsonSchema: { type: "object" } }],
    });
    const events = await drain(adapter, req, context("builder-id"));
    const toolCall = events.find((event) => event.type === "tool_call_delta");
    expect(toolCall?.type === "tool_call_delta" ? toolCall.name : undefined).toBe("my.tool/search");
  });

  test("reports a corrupt EventStream rather than a partial answer", async () => {
    const good = frame("assistantResponseEvent", { content: "ok" });
    const corrupted = Buffer.from(good);
    corrupted[corrupted.length - 6] = corrupted[corrupted.length - 6]! ^ 0xff;
    const adapter = createKiroAdapter({ fetch: asFetch(async () => bytesResponse(corrupted)) });
    await expect(drain(adapter, request(), context("builder-id"))).rejects.toThrow(GatewayError);
  });

  test("reports an upstream error message as a failure", async () => {
    const errorFrame = encodeFrame({ ":message-type": "error" }, { message: "boom" });
    const failing = createKiroAdapter({ fetch: asFetch(async () => bytesResponse(errorFrame)) });
    await expect(drain(failing, request(), context("builder-id"))).rejects.toThrow(/boom/);
  });
});
