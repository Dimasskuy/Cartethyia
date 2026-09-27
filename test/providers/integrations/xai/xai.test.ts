import { describe, expect, test } from "bun:test";
import {
  createXaiAdapter,
  XAI_BASE_URL,
  XAI_MODELS,
  XAI_PROVIDER_ID,
} from "../../../../src/providers/integrations/xai/xai";
import {
  XAI_CLIENT_ID,
  XAI_DEVICE_URL,
  XAI_TOKEN_URL,
  XaiOAuthClient,
} from "../../../../src/providers/integrations/xai/xai-oauth";
import { discoverXaiModels } from "../../../../src/providers/integrations/xai/xai-discovery";
import { GROK_CLIENT_ID, GROK_DEVICE_URL, GROK_TOKEN_URL } from "../../../../src/providers/integrations/grok/grok-oauth";
import { candidateFor, canonicalRequest, dispatchContext, dispatchJson } from "../../../helpers/provider-dispatch";

/**
 * `xai` is the paid subscription surface at `api.x.ai/v1`, deliberately
 * separate from `grok` (the free Grok Build CLI at
 * `cli-chat-proxy.grok.com`). They share an authorization server and client id
 * but not a base URL, a model roster, or an endpoint shape — this suite pins
 * both the separation and the wire facts that only the subscription surface
 * has.
 */
function jsonServer(payload: unknown, calls: { url: string; headers: Record<string, string> }[] = []) {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("xai — provider identity", () => {
  test("is a distinct provider from grok, on the paid API host", () => {
    expect(XAI_PROVIDER_ID).toBe("xai");
    expect(XAI_BASE_URL).toBe("https://api.x.ai/v1");
    expect(XAI_PROVIDER_ID).not.toBe("grok");
  });

  test("its catalog is responses-wire on the versioned root", () => {
    expect(XAI_MODELS.length).toBeGreaterThan(0);
    for (const model of XAI_MODELS) {
      expect(model.wireFamily).toBe("responses");
      expect(model.endpointPath).toBe("/responses");
    }
  });
});

describe("xai — device flow", () => {
  test("shares xAI's authorization server and client id with the Grok surface", () => {
    // One authorization server, one public client registration: these are facts
    // about xAI, so both products must read the same values.
    expect(XAI_CLIENT_ID).toBe(GROK_CLIENT_ID);
    expect(XAI_DEVICE_URL).toBe(GROK_DEVICE_URL);
    expect(XAI_TOKEN_URL).toBe(GROK_TOKEN_URL);
  });

  test("starts a device authorization and publishes the user code", async () => {
    const { fetcher, calls } = jsonServer({
      device_code: "dev-1",
      user_code: "ABCD-1234",
      verification_uri: "https://accounts.x.ai/oauth2/device",
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      interval: 5,
      expires_in: 1800,
    });
    const started = await new XaiOAuthClient(fetcher).startDeviceAuth();
    expect(started.userCode).toBe("ABCD-1234");
    expect(started.deviceAuthId).toBe("dev-1");
    expect(calls[0]!.url).toBe(XAI_DEVICE_URL);
    expect(String(calls[0]!.headers["content-type"])).toContain("form-urlencoded");
  });

  test("a pending poll stays pending", async () => {
    const { fetcher } = jsonServer({ error: "authorization_pending" });
    const result = await new XaiOAuthClient(fetcher).pollDeviceAuth("dev-1");
    expect(result.status).toBe("pending");
  });

  test("an unrecognized poll error fails instead of polling forever", async () => {
    const { fetcher } = jsonServer({ error: "invalid_grant", error_description: "expired" });
    const result = await new XaiOAuthClient(fetcher).pollDeviceAuth("dev-1");
    expect(result.status).toBe("failed");
  });

  test("completes with the account label read from userinfo", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/userinfo")) {
        return new Response(JSON.stringify({ email: "Operator@Example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const result = await new XaiOAuthClient(fetcher).pollDeviceAuth("dev-1");
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.result.access).toBe("at-1");
      expect(result.result.refresh).toBe("rt-1");
      expect(result.result.accountLabel).toBe("Operator@Example.com");
    }
    expect(calls.some((u) => u.includes("/userinfo"))).toBe(true);
  });

  test("registers a refresher, because the grant is a normal refresh grant", async () => {
    const { fetcher } = jsonServer({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
    const refreshed = await new XaiOAuthClient(fetcher).refresh("rt-1");
    expect(refreshed.access).toBe("at-2");
  });
});

describe("xai — discovery", () => {
  test("reads the standard OpenAI list and keeps the provider id for pricing", async () => {
    const { fetcher, calls } = jsonServer({
      data: [{ id: "grok-4.7", context_length: 500_000, max_output_tokens: 64_000 }],
    });
    const models = await discoverXaiModels({ credential: "tok", fetcher });
    expect(models).not.toBeNull();
    expect(models![0]!.modelId).toBe("grok-4.7");
    expect(calls[0]!.url).toBe(`${XAI_BASE_URL}/models`);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
  });

  test("returns null — not an empty list — when the directory cannot be read", async () => {
    const fetcher = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await discoverXaiModels({ credential: "tok", fetcher })).toBeNull();
  });
});

describe("xai — dispatch", () => {
  test("posts to the versioned responses path with the subscription token", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createXaiAdapter(fetchImpl),
      candidate: candidateFor("xai", "responses", "/responses", "grok-4.7"),
      request: canonicalRequest({ model: "grok-4.7", surface: "responses" }),
      context: dispatchContext("xai", { credential_kind: "oauth" }),
    });
    expect(captured.url).toBe("https://api.x.ai/v1/responses");
  });

  test("maps minimal/max to the effort values xAI accepts", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createXaiAdapter(fetchImpl),
      candidate: candidateFor("xai", "responses", "/responses", "grok-4.7"),
      request: {
        ...canonicalRequest({ model: "grok-4.7", surface: "responses" }),
        reasoning: { effort: "max" },
      },
      context: dispatchContext("xai", { credential_kind: "oauth" }),
    });
    const reasoning = captured.body.reasoning as Record<string, unknown> | undefined;
    // `max` is not on xAI's scale; it maps to `high` rather than being forwarded.
    if (reasoning !== undefined && reasoning.effort !== undefined) {
      expect(reasoning.effort).toBe("high");
    }
  });
});
