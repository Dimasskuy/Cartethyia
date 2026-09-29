import { describe, expect, test } from "bun:test";
import type { ProviderWebSocketSession } from "../../../../src/providers/provider-registry";
import { createAutoClawAdapter } from "../../../../src/providers/integrations/autoclaw/autoclaw";
import { AutoClawOAuthClient } from "../../../../src/providers/integrations/autoclaw/autoclaw-oauth";
import {
  AUTOCLAW_CN_BASE_URL,
  buildAutoClawChatHeaders,
  buildAutoClawUserApiHeaders,
} from "../../../../src/providers/integrations/autoclaw/autoclaw-shared";
import { discoverAutoClawModels } from "../../../../src/providers/integrations/autoclaw/autoclaw-discovery";
import { fetchAutoClawQuota } from "../../../../src/providers/integrations/autoclaw/autoclaw-quota";
import { candidateFor, canonicalRequest, dispatchContext } from "../../../helpers/provider-dispatch";
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function fetcherWith(handler: (url: URL, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input)), init)) as typeof fetch;
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected the operation to reject");
}

async function rejectionError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject");
}

describe("AutoClaw request headers", () => {
  test("signs UserAPI requests and sends the chat token in both required auth headers", () => {
    const userApi = buildAutoClawUserApiHeaders("access-token");
    const chat = buildAutoClawChatHeaders("access-token", "glm-5.3-flash");

    expect(userApi["authorization"]).toBe("Bearer access-token");
    expect(userApi["x-auth-appid"]).toBe("100003");
    expect(userApi["x-auth-timestamp"]).toMatch(/^\d+$/);
    expect(userApi["x-auth-sign"]).toMatch(/^[a-f0-9]{32}$/);
    expect(chat["authorization"]).toBe("Bearer access-token");
    expect(chat["x-authorization"]).toBe("Bearer access-token");
    expect(chat["x-request-model"]).toBe("glm-5.3-flash");
    expect(chat["user-agent"]).toBe("AutoClaw/1.18.5");
  });
});

describe("AutoClaw OAuth import and refresh", () => {
  test("validates the supplied token pair and persists rotated tokens with CN auth state", async () => {
    const requests: Array<{ url: URL; method: string; authorization: string; body: string }> = [];
    const fetcher = fetcherWith((url, init) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url.pathname.endsWith("/userapi/v1/refresh")) {
        return jsonResponse({
          code: 0,
          data: {
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          },
        });
      }
      return jsonResponse({ code: 0, data: { total_balance: 125 } });
    });
    const client = new AutoClawOAuthClient(fetcher);

    const result = await client.importCredential({
      credential: "initial-access",
      fields: { refreshToken: "initial-refresh", deviceId: "device-1", userId: "user-1" },
    });

    expect(result.access).toBe("rotated-access");
    expect(result.refresh).toBe("rotated-refresh");
    expect(result.auth_state).toEqual({ region: "cn", deviceId: "device-1", userId: "user-1" });
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.origin).toBe(AUTOCLAW_CN_BASE_URL);
    expect(requests[0]?.url.pathname).toBe("/userapi/v1/refresh");
    expect(requests[0]?.authorization).toBe("Bearer initial-access");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      source_id: "autoclaw",
      device_id: "device-1",
      refresh_token: "initial-refresh",
    });
    expect(requests[1]?.url.pathname).toBe("/agent-assetmgr/api/v2/wallets");
    expect(requests[1]?.authorization).toBe("Bearer rotated-access");
  });

  test("rejects expired imports and refuses an exported blank token field", async () => {
    const fetcher = fetcherWith(() => jsonResponse({ code: 410000, msg: "session expired" }));
    const client = new AutoClawOAuthClient(fetcher);

    expect(await rejectionMessage(client.importCredential({
      credential: "access-token",
      fields: { refreshToken: "refresh-token", deviceId: "device-1" },
    }))).toBe("invalid_token");
    expect(await rejectionMessage(client.importCredential({
      credential: JSON.stringify({ accessToken: "", refreshToken: "refresh-token", deviceId: "device-1" }),
      fields: {},
    }))).toBe("AutoClaw credential accessToken is blank");
  });

  test("refresh requires the current access token and account device id", async () => {
    const client = new AutoClawOAuthClient(fetcherWith(() => jsonResponse({ code: 0, data: {} })));
    expect(await rejectionMessage(client.refresh("refresh-token"))).toBe(
      "AutoClaw refresh requires the current access token",
    );
  });
});

describe("AutoClaw model discovery", () => {
  test("uses account model config limits instead of an inferred or stale limit", async () => {
    const fetcher = fetcherWith((url, init) => {
      expect(url.pathname).toBe("/autoclaw-proxy/proxy/autoclaw-model-config");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      return jsonResponse({
        code: 0,
        data: {
          models: [
            { id: "glm-5.3-flash", contextWindow: 1_000_000, maxTokens: 32_000, reasoning: true },
            { id: "unsupported", contextWindow: "bad" },
          ],
        },
      });
    });

    const models = await discoverAutoClawModels({ credential: "access-token", fetcher });

    expect(models?.map((model) => model.modelId)).toEqual(["glm-5.3-flash", "unsupported"]);
    expect(models?.[0]).toMatchObject({ contextLimit: 1_000_000, outputLimit: 32_000, reasoning: true });
  });
});

describe("AutoClaw wallet credits", () => {
  test("returns the upstream absolute wallet balance as available credits", async () => {
    const fetcher = fetcherWith((url) => {
      expect(url.pathname).toBe("/agent-assetmgr/api/v2/wallets");
      expect(url.searchParams.get("biz_app_id")).toBe("autoclaw");
      return jsonResponse({ code: 0, data: { total_balance: "123.5", wallets: [] } });
    });

    const result = await fetchAutoClawQuota("access-token", fetcher);

    expect(result.error).toBeNull();
    expect(result.windows).toEqual([
      {
        kind: "credits",
        label: "Credits available",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        used: null,
        limit: 123.5,
        remaining: 123.5,
        recurring: false,
      },
    ]);
  });

  test("rejects an unreported wallet balance instead of inventing zero credits", async () => {
    const fetcher = fetcherWith(() => jsonResponse({ code: 0, data: { wallets: [] } }));
    expect(await rejectionMessage(fetchAutoClawQuota("access-token", fetcher))).toBe(
      "AutoClaw wallet response did not contain a valid total balance",
    );
  });
});

describe("AutoClaw adapter routing", () => {
  const candidate = candidateFor("autoclaw", "chat", "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions", "glm-5.3-flash");
  const request = canonicalRequest({ stream: true, model: "glm-5.3-flash" });


  test("uses the direct chat endpoint without opening the sandbox when it works", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      calls.push(String(input));
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"direct\"},\"finish_reason\":null}]}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const baseContext = dispatchContext("autoclaw", {
      credential_kind: "oauth",
      auth_state: { region: "cn", deviceId: "device-1" },
    });
    const context = {
      ...baseContext,
      outbound_fetch: fetcher,
      outbound_websocket: async () => { throw new Error("unexpected sandbox fallback"); },
    };

    const events = [];
    for await (const event of createAutoClawAdapter(fetcher).dispatch(request, candidate, context)) events.push(event);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/autoclaw-proxy/proxy/autoclaw/v1/chat/completions");
    expect(events.some((event) => event.type === "content_delta" && event.content.kind === "text")).toBe(true);
  });

  test("authenticates the CN sandbox and converts matching relay SSE snapshots", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
      if (url.pathname.endsWith("/agentdr/v2/assistant/sandbox/list")) {
        return jsonResponse({ code: 0, data: { sandbox_list: [{ sandbox_id: "sandbox-1", sandbox_endpoint: "https://sandbox.example/autoclaw-cloud", end_timestamp: 0 }] } });
      }
      if (url.pathname.endsWith("/api/events")) {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("data: {\"event\":\"agent:stream\",\"payload\":{\"runId\":\"run-1\",\"type\":\"text\",\"delta\":\"hello\"}}\n\n"));
            controller.enqueue(encoder.encode("data: {\"event\":\"agent:stream\",\"payload\":{\"runId\":\"run-1\",\"type\":\"text\",\"delta\":\"hello world\"}}\n\n"));
            controller.enqueue(encoder.encode("data: {\"event\":\"agent:stream\",\"payload\":{\"runId\":\"run-1\",\"type\":\"done\"}}\n\n"));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/api/electron/agent/send")) return jsonResponse({ ok: true, data: { runId: "run-1" } });
      throw new Error(`unexpected URL ${url.pathname}`);
    }) as typeof fetch;
    const wsMessages: string[] = [];
    let wsUrl: URL | undefined;
    const session: ProviderWebSocketSession = {
      send(message) { wsMessages.push(message); },
      async receive() { return JSON.stringify({ type: "auth.inject.ok" }); },
      close() {},
    };
    const baseContext = dispatchContext("autoclaw", {
      credential_kind: "oauth",
      auth_state: { region: "cn", deviceId: "device-1", userId: "user-1" },
    });
    const context = {
      ...baseContext,
      outbound_fetch: fetcher,
      outbound_websocket: async (url: URL) => { wsUrl = url; return session; },
    };

    const events = [];
    for await (const event of createAutoClawAdapter(fetcher).dispatch(request, candidate, context)) events.push(event);

    expect(calls).toContain("/autoclaw-cloud/proxy/sandbox-1/api/events");
    expect(calls).toContain("/autoclaw-cloud/proxy/sandbox-1/api/electron/agent/send");
    expect(wsUrl?.protocol).toBe("wss:");
    expect(wsUrl?.searchParams.get("device_id")).toBe("sandbox-1");
    expect(JSON.parse(wsMessages[0] ?? "{}")).toMatchObject({ type: "auth.inject", userId: "user-1" });
    expect(events.filter((event) => event.type === "content_delta")).toEqual([
      expect.objectContaining({ content: { kind: "text", text: "hello" } }),
      expect.objectContaining({ content: { kind: "text", text: " world" } }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });

  test("uses the sandbox fallback for the observed direct 406 channel block", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      return url.pathname.endsWith("/chat/completions")
        ? new Response("{}", { status: 406 })
        : jsonResponse({ code: 0, data: { sandbox_list: [] } });
    }) as typeof fetch;
    const context = {
      ...dispatchContext("autoclaw", {
        credential_kind: "oauth",
        auth_state: { region: "cn", deviceId: "device-1" },
      }),
      outbound_fetch: fetcher,
      outbound_websocket: async () => { throw new Error("unexpected sandbox"); },
    };

    const iterator = createAutoClawAdapter(fetcher).dispatch(request, candidate, context)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ status: 502 });
    expect(calls).toContain("/agentdr/v2/assistant/sandbox/list");
  });

  test("does not fall back to sandbox after invalid access credentials", async () => {
    const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 401 })) as typeof fetch;
    let socketCount = 0;
    const context = {
      ...dispatchContext("autoclaw", {
        credential_kind: "oauth",
        auth_state: { region: "cn", deviceId: "device-1" },
      }),
      outbound_fetch: fetcher,
      outbound_websocket: async () => { socketCount += 1; throw new Error("unexpected sandbox"); },
    };
    const iterator = createAutoClawAdapter(fetcher).dispatch(request, candidate, context)[Symbol.asyncIterator]();

    const error = await rejectionError(iterator.next());
    expect(error instanceof Error).toBe(true);
    expect(socketCount).toBe(0);
  });

  test("does not fall back to the sandbox after a different direct failure", async () => {
    const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 500 })) as typeof fetch;
    let socketCount = 0;
    const baseContext = dispatchContext("autoclaw", {
      credential_kind: "oauth",
      auth_state: { region: "cn", deviceId: "device-1" },
    });
    const context = {
      ...baseContext,
      outbound_fetch: fetcher,
      outbound_websocket: async () => { socketCount += 1; throw new Error("unexpected sandbox"); },
    };
    const iterator = createAutoClawAdapter(fetcher).dispatch(request, candidate, context)[Symbol.asyncIterator]();

    const error = await rejectionError(iterator.next());
    expect(error instanceof Error).toBe(true);
    expect(error instanceof Error ? error.message : "").toContain("HTTP 500");
    expect(socketCount).toBe(0);
  });
});
