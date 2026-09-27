import { describe, expect, test } from "bun:test";
import {
  GITHUB_LONG_CONTEXT_THRESHOLD,
  githubModelUsesLongContext,
  createGithubAdapter,
  recordGithubLongContextModels,
  resetGithubLongContextModelsForTesting,
} from "../../../../src/providers/integrations/github/github";
import { discoverGithubModels } from "../../../../src/providers/integrations/github/github-discovery";
import { fetchGithubQuota, parseGithubQuota } from "../../../../src/providers/integrations/github/github-quota";
import { encodeGithubCredential } from "../../../../src/providers/integrations/github/github-oauth";
import { candidateFor, canonicalRequest, dispatchContext, dispatchJson } from "../../../helpers/provider-dispatch";
import type { ModelDefinition } from "../../../../src/providers/provider-registry";

/** A discovery-shaped row whose window qualifies for the long-context tier. */
function longContextRow(modelId: string): ModelDefinition {
  return {
    modelId,
    wireFamily: "chat",
    endpointPath: "/chat/completions",
    contextLimit: GITHUB_LONG_CONTEXT_THRESHOLD,
    outputLimit: 64_192,
    modalities: { input: ["text"], output: ["text"] },
    reasoning: true,
    toolCall: true,
    webSearch: false,
    cost: { input: null, output: null, pricing_model: "unknown" },
  };
}

/**
 * Copilot's `/models` envelope is OpenAI-shaped but its entries are not: the
 * surface a SKU answers on is `supported_endpoints`, and the window is nested
 * under `capabilities.limits`. A reader that assumed the flat OpenAI shape would
 * publish every row at the default window and pin every row to chat — so a
 * responses-only SKU would be registered on an endpoint it rejects.
 */

const CREDENTIAL = encodeGithubCredential("minted-token", "api.enterprise.githubcopilot.com", "gh-token");

function modelsServer(payload: unknown, calls: { url: string; headers: Record<string, string> }[] = []) {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("GitHub Copilot — model discovery", () => {
  test("reads the window from capabilities.limits, not a flat context_length", async () => {
    const { fetcher } = modelsServer({
      data: [
        {
          id: "gpt-5.6-luna",
          supported_endpoints: ["/v1/chat/completions"],
          capabilities: { limits: { max_context_window_tokens: 872_000 } },
        },
      ],
    });
    const models = await discoverGithubModels({ credential: CREDENTIAL, fetcher });
    expect(models).not.toBeNull();
    expect(models![0]!.contextLimit).toBe(872_000);
  });

  test("routes a responses-only SKU to /responses instead of chat", async () => {
    const { fetcher } = modelsServer({
      data: [
        { id: "o3-only", supported_endpoints: ["/v1/responses"], capabilities: { limits: { max_context_window_tokens: 200_000 } } },
        { id: "chatty", supported_endpoints: ["/v1/chat/completions"], capabilities: { limits: { max_context_window_tokens: 200_000 } } },
      ],
    });
    const models = await discoverGithubModels({ credential: CREDENTIAL, fetcher });
    const byId = new Map(models!.map((m) => [m.modelId, m]));
    expect(byId.get("o3-only")!.wireFamily).toBe("responses");
    expect(byId.get("o3-only")!.endpointPath).toBe("/responses");
    expect(byId.get("chatty")!.wireFamily).toBe("chat");
  });

  test("skips a SKU that answers on neither chat nor responses", async () => {
    const { fetcher } = modelsServer({
      data: [
        { id: "embed-only", supported_endpoints: ["/v1/embeddings"] },
        { id: "usable", supported_endpoints: ["/v1/chat/completions"] },
      ],
    });
    const models = await discoverGithubModels({ credential: CREDENTIAL, fetcher });
    expect(models!.map((m) => m.modelId)).toEqual(["usable"]);
  });

  test("sends the minted token and the account host, never the raw envelope", async () => {
    const { fetcher, calls } = modelsServer({ data: [{ id: "m", supported_endpoints: ["/v1/chat/completions"] }] });
    await discoverGithubModels({ credential: CREDENTIAL, fetcher });
    expect(calls[0]!.url).toBe("https://api.enterprise.githubcopilot.com/models");
    expect(calls[0]!.headers.authorization).toBe("Bearer minted-token");
  });

  test("returns null — not an empty list — when the directory cannot be read", async () => {
    const fetcher = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await discoverGithubModels({ credential: CREDENTIAL, fetcher })).toBeNull();
  });
});

describe("GitHub Copilot — long context tier", () => {
  test("records only models at or above the threshold", async () => {
    resetGithubLongContextModelsForTesting();
    const { fetcher } = modelsServer({
      data: [
        { id: "big", supported_endpoints: ["/v1/chat/completions"], capabilities: { limits: { max_context_window_tokens: GITHUB_LONG_CONTEXT_THRESHOLD } } },
        { id: "small", supported_endpoints: ["/v1/chat/completions"], capabilities: { limits: { max_context_window_tokens: GITHUB_LONG_CONTEXT_THRESHOLD - 1 } } },
      ],
    });
    await discoverGithubModels({ credential: CREDENTIAL, fetcher });
    expect(githubModelUsesLongContext("big")).toBe(true);
    expect(githubModelUsesLongContext("small")).toBe(false);
  });

  test("injects contextTier for a recorded model and omits it otherwise", async () => {
    resetGithubLongContextModelsForTesting();
    recordGithubLongContextModels([longContextRow("big")]);
    const secret = new TextEncoder().encode(CREDENTIAL);
    const big = await dispatchJson({
      create: (fetchImpl) => createGithubAdapter(fetchImpl),
      candidate: candidateFor("github", "chat", "/chat/completions", "big"),
      request: canonicalRequest({ model: "big" }),
      context: dispatchContext("github", { credential_kind: "oauth", secret }),
    });
    expect(big.body.contextTier).toBe("long_context");
    const small = await dispatchJson({
      create: (fetchImpl) => createGithubAdapter(fetchImpl),
      candidate: candidateFor("github", "chat", "/chat/completions", "small"),
      request: canonicalRequest({ model: "small" }),
      context: dispatchContext("github", { credential_kind: "oauth", secret }),
    });
    expect(small.body.contextTier).toBeUndefined();
  });

  test("does not inject contextTier on the messages wire", async () => {
    resetGithubLongContextModelsForTesting();
    recordGithubLongContextModels([longContextRow("big")]);
    const sent = await dispatchJson({
      create: (fetchImpl) => createGithubAdapter(fetchImpl),
      candidate: candidateFor("github", "messages", "/v1/messages", "big"),
      request: canonicalRequest({ model: "big", surface: "messages" }),
      context: dispatchContext("github", {
        credential_kind: "oauth",
        secret: new TextEncoder().encode(CREDENTIAL),
      }),
    });
    // The native Anthropic surface validates against its own schema and rejects
    // an unknown top-level key, so the extension must not ride on it.
    expect(sent.body.contextTier).toBeUndefined();
  });
});

describe("GitHub Copilot — quota", () => {
  test("reads plan and windows from the token response", () => {
    const result = parseGithubQuota({
      copilot_plan: "individual",
      limited_user_quotas: { chat: 300, completions: 4000 },
      limited_user_quotas_remaining: { chat: 120, completions: 4000 },
      limited_user_reset_date: "2026-10-01",
    });
    expect(result.plan).toBe("individual");
    const chat = result.windows.find((w) => w.kind === "chat")!;
    expect(chat.used).toBe(180);
    expect(chat.limit).toBe(300);
    expect(chat.usedPercent).toBeCloseTo(60, 5);
  });

  test("emits no window rather than a fabricated one", () => {
    expect(parseGithubQuota({}).windows).toEqual([]);
    expect(parseGithubQuota({ limited_user_quotas: { chat: 0 } }).windows).toEqual([]);
  });

  test("authenticates the usage call with the GitHub token from the envelope", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(input), auth: headers.authorization ?? "" });
      return new Response(JSON.stringify({ copilot_plan: "individual" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await fetchGithubQuota(CREDENTIAL, fetcher);
    expect(calls[0]!.url).toBe("https://api.github.com/copilot_internal/v2/token");
    expect(calls[0]!.auth).toBe("Bearer gh-token");
  });
});
