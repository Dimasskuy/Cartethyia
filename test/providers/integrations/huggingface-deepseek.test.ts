import { describe, expect, test } from "bun:test";
import {
  discoverHuggingfaceModels,
  HUGGINGFACE_ENDPOINT_PATH,
  HUGGINGFACE_MODELS_URL,
  HUGGINGFACE_SPEC,
} from "../../../src/providers/integrations/huggingface";
import { GENERIC_API_KEY_SPECS } from "../../../src/providers/integrations/configured-openai-providers";
import { providerBaseUrl } from "../../../src/providers/provider-metadata";
import {
  candidateFor,
  dispatchContext,
  dispatchJson,
} from "../../helpers/provider-dispatch";
import { createApiKeyAdapter } from "../../../src/providers/integrations/configured-provider";

/**
 * The Hugging Face router serves an OpenAI-shaped envelope whose *entries* are
 * not OpenAI-shaped: a model's limits live under a nested `providers[]` array
 * (the router brokers to several backends at different prices) and capability
 * lives under `architecture.input_modalities` plus a per-backend
 * `supports_tools`. The shared fetcher reads a top-level `context_length` and a
 * `modality` string, so against this listing it would publish every row at the
 * 200k/64k defaults, drop tools everywhere, and lose the image input 28 of the
 * 78 bundled rows declare.
 *
 * These tests pin the fields that would otherwise silently degrade, and the two
 * judgement calls in the reader: the cheapest live backend decides the window
 * and the price, and tools are ANDed across backends.
 */

function directoryServer(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const DIRECTORY = {
  data: [
    {
      id: "acme/Only-Live-Entry",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      providers: [
        {
          provider: "together",
          status: "live",
          context_length: 777_777,
          pricing: { input: 0.3, output: 1.2 },
          supports_tools: true,
        },
        {
          provider: "deepinfra",
          status: "live",
          context_length: 777_777,
          pricing: { input: 0.2, output: 1.0 },
          supports_tools: true,
        },
      ],
    },
    {
      id: "google/gemma-3-27b-it",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      providers: [
        {
          provider: "novita",
          status: "live",
          context_length: 131_072,
          pricing: { input: 0.1, output: 0.4 },
          supports_tools: false,
        },
      ],
    },
  ],
};

describe("Hugging Face directory — nesting", () => {
  test("reads the context window from the cheapest live backend, not the defaults", async () => {
    const { fetcher } = directoryServer(DIRECTORY);
    const models = await discoverHuggingfaceModels({ credential: "hf-token", fetcher });
    expect(models).not.toBeNull();
    const row = models!.find((model) => model.modelId === "acme/Only-Live-Entry");
    expect(row?.contextLimit).toBe(777_777);
    expect(row?.contextLimit).not.toBe(200_000);
  });

  test("keeps the image input the entry's architecture declares", async () => {
    const { fetcher } = directoryServer(DIRECTORY);
    const models = await discoverHuggingfaceModels({ credential: "hf-token", fetcher });
    const row = models!.find((model) => model.modelId === "google/gemma-3-27b-it");
    expect(row?.modalities.input).toEqual(["text", "image"]);
  });

  test("a backend that does not support tools makes the row tool-incapable", async () => {
    const { fetcher } = directoryServer(DIRECTORY);
    const models = await discoverHuggingfaceModels({ credential: "hf-token", fetcher });
    // gemma's only live backend reports supports_tools: false. Declaring true
    // would make capability preflight send a `tools` array that backend rejects.
    const gemma = models!.find((model) => model.modelId === "google/gemma-3-27b-it");
    expect(gemma?.toolCall).toBe(false);
    const flash = models!.find((model) => model.modelId === "acme/Only-Live-Entry");
    expect(flash?.toolCall).toBe(true);
  });

  test("registers rows on the provider's own chat path", async () => {
    const { fetcher } = directoryServer(DIRECTORY);
    const models = await discoverHuggingfaceModels({ credential: "hf-token", fetcher });
    for (const model of models!) {
      expect(model.wireFamily).toBe("chat");
      expect(model.endpointPath).toBe(HUGGINGFACE_ENDPOINT_PATH);
    }
  });

  test("sends the token as a bearer to the router directory", async () => {
    const { fetcher, calls } = directoryServer(DIRECTORY);
    await discoverHuggingfaceModels({ credential: "hf_abc", fetcher });
    expect(calls[0]?.url).toBe(HUGGINGFACE_MODELS_URL);
    expect(calls[0]?.headers.authorization).toBe("Bearer hf_abc");
  });

  test("returns null — not an empty list — on any failure", async () => {
    for (const [body, status] of [
      [{ data: [] }, 200],
      [{ data: [] }, 500],
      ["not-an-object", 200],
    ] as const) {
      const { fetcher } = directoryServer(body, status);
      expect(await discoverHuggingfaceModels({ credential: "t", fetcher })).toBeNull();
    }
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await discoverHuggingfaceModels({ credential: "t", fetcher: throwing })).toBeNull();
  });

  test("a model with no live backend still yields a row rather than being dropped", async () => {
    const { fetcher } = directoryServer({
      data: [{ id: "org/model", architecture: { input_modalities: ["text"] }, providers: [] }],
    });
    const models = await discoverHuggingfaceModels({ credential: "t", fetcher });
    expect(models).toHaveLength(1);
    expect(models![0]?.modelId).toBe("org/model");
  });
});

describe("DeepSeek and Hugging Face dispatch", () => {
  test("DeepSeek posts to the /v1-prefixed path on its bare-root base", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(GENERIC_API_KEY_SPECS.deepseek, fetchImpl),
      candidate: candidateFor("deepseek", "chat", "/v1/chat/completions"),
      context: dispatchContext("deepseek", { credential_kind: "api_key" }),
    });
    expect(captured.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(captured.headers.authorization).toBe("Bearer test-secret-token");
  });

  test("Hugging Face posts to the /v1 base without doubling the segment", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(HUGGINGFACE_SPEC, fetchImpl),
      candidate: candidateFor("huggingface", "chat", HUGGINGFACE_ENDPOINT_PATH),
      context: dispatchContext("huggingface", { credential_kind: "api_key" }),
    });
    // The base URL already carries `/v1`, so the row path is the suffix that
    // completes it — a `/v1/chat/completions` row would join to `/v1/v1/...`.
    expect(captured.url).toBe("https://router.huggingface.co/v1/chat/completions");
    expect(captured.url).not.toContain("/v1/v1/");
    expect(captured.headers.authorization).toBe("Bearer test-secret-token");
  });

  test("both providers resolve their base URL from the single metadata row", () => {
    expect(providerBaseUrl("deepseek")).toBe("https://api.deepseek.com");
    expect(providerBaseUrl("huggingface")).toBe("https://router.huggingface.co/v1");
  });
});
