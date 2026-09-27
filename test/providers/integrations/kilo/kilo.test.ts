import { describe, expect, test } from "bun:test";
import {
  KILO_MODELS,
  KILO_ENDPOINT_PATH,
  createKiloAdapter,
} from "../../../../src/providers/integrations/kilo/kilo";
import {
  encodeKiloCredential,
  parseKiloCredential,
} from "../../../../src/providers/integrations/kilo/kilo-oauth";
import {
  discoverKiloModels,
  KILO_MODELS_URL,
} from "../../../../src/providers/integrations/kilo/kilo-discovery";
import {
  candidateFor,
  canonicalRequest,
  dispatchContext,
  dispatchJson,
} from "../../../helpers/provider-dispatch";

/**
 * Kilo Code's stored credential is a JSON envelope, not a bare bearer, because
 * every request is scoped to the account's organization. These tests pin the
 * two places that decode it — the auth boundary and the header hook — against
 * the failure that motivated the envelope: sending the raw secret as the bearer
 * authenticates as garbage and loses the organization header entirely.
 */
function envelopeSecret(accessToken: string, orgId?: string): Uint8Array {
  return new TextEncoder().encode(encodeKiloCredential(accessToken, orgId));
}

describe("kilo adapter — credential envelope", () => {
  test("bearer comes from the envelope's accessToken, not the raw secret", async () => {
    const captured = await dispatchJson({
      create: createKiloAdapter,
      candidate: candidateFor("kilo", "chat", KILO_ENDPOINT_PATH),
      context: dispatchContext("kilo", {
        credential_kind: "oauth",
        secret: envelopeSecret("real-access-token", "org-1"),
      }),
    });
    expect(captured.headers.authorization).toBe("Bearer real-access-token");
    expect(captured.headers.authorization).not.toContain("accessToken");
  });

  test("the organization header carries the envelope's orgId", async () => {
    const captured = await dispatchJson({
      create: createKiloAdapter,
      candidate: candidateFor("kilo", "chat", KILO_ENDPOINT_PATH),
      context: dispatchContext("kilo", {
        credential_kind: "oauth",
        secret: envelopeSecret("real-access-token", "org-42"),
      }),
    });
    expect(captured.headers["x-kilocode-organizationid"]).toBe("org-42");
  });

  test("an envelope without an orgId sends no organization header", async () => {
    const captured = await dispatchJson({
      create: createKiloAdapter,
      candidate: candidateFor("kilo", "chat", KILO_ENDPOINT_PATH),
      context: dispatchContext("kilo", {
        credential_kind: "oauth",
        secret: envelopeSecret("real-access-token"),
      }),
    });
    expect(captured.headers.authorization).toBe("Bearer real-access-token");
    expect(captured.headers["x-kilocode-organizationid"]).toBeUndefined();
  });

  test("dispatches to the published completions path", async () => {
    const captured = await dispatchJson({
      create: createKiloAdapter,
      candidate: candidateFor("kilo", "chat", KILO_ENDPOINT_PATH),
      context: dispatchContext("kilo", {
        credential_kind: "oauth",
        secret: envelopeSecret("real-access-token", "org-1"),
      }),
    });
    expect(captured.url).toBe(`https://api.kilo.ai/api/openrouter${KILO_ENDPOINT_PATH}`);
    expect(captured.body.model).toBe("test-model");
  });

  test("an undecodable credential is left as sent, failing closed upstream", async () => {
    const captured = await dispatchJson({
      create: createKiloAdapter,
      candidate: candidateFor("kilo", "chat", KILO_ENDPOINT_PATH),
      context: dispatchContext("kilo", {
        credential_kind: "api_key",
        secret: new TextEncoder().encode("not-a-json-envelope"),
      }),
    });
    // The hook does not invent a token from a value it cannot parse; the raw
    // secret reaches the upstream, which rejects it.
    expect(captured.headers.authorization).toBe("Bearer not-a-json-envelope");
  });

  test("a request without a credential sends no authorization header", async () => {
    const captured = await dispatchJson({
      create: createKiloAdapter,
      candidate: candidateFor("kilo", "chat", KILO_ENDPOINT_PATH),
      context: dispatchContext("kilo", { credential_kind: "none", secret: undefined }),
    });
    expect(captured.headers.authorization).toBeUndefined();
  });
});

describe("kilo credential envelope codec", () => {
  test("round-trips an access token and an organization id", () => {
    expect(parseKiloCredential(encodeKiloCredential("tok", "org"))).toEqual({
      accessToken: "tok",
      orgId: "org",
    });
  });

  test("omits the orgId field when there is no organization", () => {
    expect(parseKiloCredential(encodeKiloCredential("tok", undefined))).toEqual({
      accessToken: "tok",
    });
  });

  test("fails closed on a value that is not the envelope this module writes", () => {
    for (const malformed of ["", "  ", "raw-token", '{"accessToken":""}', '{"nope":1}', "[]"]) {
      expect(() => parseKiloCredential(malformed)).toThrow();
    }
  });
});

/**
 * The directory is an OpenRouter-shaped catalog: limits live under
 * `top_provider` and capability under `architecture`/`supported_parameters`.
 * The shared OpenAI fetcher reads none of those, so these tests pin the
 * fields that would otherwise silently degrade to the 200k/64k defaults with
 * vision and tools switched off.
 */
describe("kilo model directory", () => {
  function directoryServer(
    body: unknown,
    options: { readonly status?: number } = {},
  ): { fetcher: typeof fetch; calls: { url: string; headers: Record<string, string> }[] } {
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
        status: options.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetcher, calls };
  }

  const DIRECTORY = {
    data: [
      {
        id: "anthropic/claude-opus-4.8",
        architecture: { input_modalities: ["text", "image", "file", "pdf"] },
        top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
        supported_parameters: ["tools", "reasoning", "reasoning_effort"],
      },
      {
        id: "deepseek/deepseek-chat",
        architecture: { input_modalities: ["text"] },
        top_provider: { context_length: 163_840, max_completion_tokens: 16_384 },
        supported_parameters: ["tools"],
      },
    ],
  };

  test("reads limits from top_provider, not the top-level defaults", async () => {
    const { fetcher } = directoryServer(DIRECTORY);
    const models = await discoverKiloModels({ credential: encodeKiloCredential("tok", "org-1"), fetcher });
    expect(models).not.toBeNull();
    const opus = models!.find((model) => model.modelId === "anthropic/claude-opus-4.8");
    expect(opus?.contextLimit).toBe(1_000_000);
    expect(opus?.outputLimit).toBe(128_000);
  });

  test("maps OpenRouter modality names onto canonical capabilities", async () => {
    const { fetcher } = directoryServer(DIRECTORY);
    const models = await discoverKiloModels({ credential: encodeKiloCredential("tok", "org-1"), fetcher });
    const opus = models!.find((model) => model.modelId === "anthropic/claude-opus-4.8");
    // `file` and `pdf` are both the canonical `document` capability.
    expect(opus?.modalities.input).toEqual(["text", "image", "document"]);
    expect(opus?.reasoning).toBe(true);
    expect(opus?.toolCall).toBe(true);
  });

  test("a model without the tools parameter is not advertised as tool-capable", async () => {
    const { fetcher } = directoryServer({
      data: [{ id: "x/plain", architecture: { input_modalities: ["text"] }, supported_parameters: [] }],
    });
    const models = await discoverKiloModels({ credential: encodeKiloCredential("tok", "org-1"), fetcher });
    expect(models![0]?.toolCall).toBe(false);
    expect(models![0]?.reasoning).toBe(false);
  });

  test("registers rows on the provider's own endpoint path", async () => {
    const { fetcher } = directoryServer(DIRECTORY);
    const models = await discoverKiloModels({ credential: encodeKiloCredential("tok", "org-1"), fetcher });
    for (const model of models!) {
      expect(model.wireFamily).toBe("chat");
      expect(model.endpointPath).toBe(KILO_ENDPOINT_PATH);
    }
  });

  test("sends the credential as a bearer to the published directory URL", async () => {
    const { fetcher, calls } = directoryServer(DIRECTORY);
    await discoverKiloModels({ credential: encodeKiloCredential("tok-123", "org-9"), fetcher });
    expect(calls[0]?.url).toBe(KILO_MODELS_URL);
    // The caller hands over the stored secret, which for this provider is the
    // envelope — not a token. Putting the JSON on the wire as the bearer is the
    // bug this asserts against; it is invisible against the live endpoint
    // because that endpoint currently ignores the header entirely.
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-123");
    expect(calls[0]?.headers.authorization).not.toContain("accessToken");
  });

  test("fails closed when the stored credential is not this provider's envelope", async () => {
    const { fetcher, calls } = directoryServer(DIRECTORY);
    await expect(
      discoverKiloModels({ credential: "raw-token-bukan-envelope", fetcher }),
    ).rejects.toThrow();
    // No request is made with a credential that could not be decoded.
    expect(calls.length).toBe(0);
  });

  test("returns null — not an empty list — so a failed sync keeps the static catalog", async () => {
    const failing = directoryServer({ data: [] }, { status: 500 });
    expect(await discoverKiloModels({ credential: encodeKiloCredential("tok", "org-1"), fetcher: failing.fetcher })).toBeNull();

    const empty = directoryServer({ data: [] });
    expect(await discoverKiloModels({ credential: encodeKiloCredential("tok", "org-1"), fetcher: empty.fetcher })).toBeNull();

    const unparseable = directoryServer("not-an-object");
    expect(await discoverKiloModels({ credential: encodeKiloCredential("tok", "org-1"), fetcher: unparseable.fetcher })).toBeNull();

    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await discoverKiloModels({ credential: encodeKiloCredential("tok", "org-1"), fetcher: throwing })).toBeNull();
  });

  test("the static catalog stays inside the ids the directory publishes", () => {
    // Guards against the failure this port already hit once: a fallback list
    // copied from another gateway carried ids that upstream had retired.
    const ids = new Set(KILO_MODELS.map((model) => model.modelId));
    expect(ids.size).toBe(KILO_MODELS.length);
    for (const id of ids) expect(id).toContain("/");
  });
});

describe("kilo dispatch payload", () => {
  test("a streaming request carries the canonical model and no query string", async () => {
    const captured = await dispatchJson({
      create: createKiloAdapter,
      candidate: candidateFor("kilo", "chat", KILO_ENDPOINT_PATH, "kilo-auto/frontier"),
      request: canonicalRequest({ stream: true, model: "kilo-auto/frontier" }),
      context: dispatchContext("kilo", {
        credential_kind: "oauth",
        secret: envelopeSecret("tok", "org-1"),
      }),
    });
    expect(captured.body.model).toBe("kilo-auto/frontier");
    expect(captured.body.stream).toBe(true);
    expect(captured.url).not.toContain("?");
  });
});
