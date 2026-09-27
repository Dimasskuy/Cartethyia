import { describe, expect, test } from "bun:test";
import { discoverWorkBuddyModels } from "../../../../src/providers/integrations/buddy/workbuddy";
import { discoverCodeBuddyModels } from "../../../../src/providers/integrations/buddy/codebuddy";
import { discoverCodeBuddyCnModels } from "../../../../src/providers/integrations/buddy/codebuddy-cn";

/**
 * The buddy console directory is not the OpenAI `{data:[…]}` envelope, so it
 * cannot go through the shared OpenAI-compatible discovery. These tests pin the
 * reader's contract against the real upstream shape:
 * `{ code, msg, data: { models: [...], agents: [...] } }`.
 *
 * A JWT-shaped credential is used because the directory scores by account: the
 * token's `sub` becomes `X-User-Id`. An opaque key must instead declare the
 * header absent rather than send an empty one.
 */

/** Minimal unsigned JWT with a `sub` claim — the shape `buddyAccountUid` reads. */
function jwtWithSub(sub: string): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub })}.sig`;
}

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function directoryServer(
  body: unknown,
  options: { readonly status?: number } = {},
): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
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

const OK_DIRECTORY = {
  code: 0,
  msg: "ok",
  data: {
    models: [
      {
        id: "glm-5.3",
        name: "GLM 5.3",
        maxInputTokens: 1_000_000,
        maxOutputTokens: 131_072,
        supportsImages: true,
        supportsToolCall: true,
        supportsReasoning: true,
      },
      { id: "retired-model", name: "Retired", disabled: true },
      { id: "web-only", name: "Web Only" },
    ],
    agents: [{ name: "cli", models: ["glm-5.3", "retired-model"] }],
  },
};

describe("buddy console directory discovery", () => {
  test("reads the console envelope and maps the upstream's own metadata", async () => {
    const { fetcher } = directoryServer(OK_DIRECTORY);
    const models = await discoverWorkBuddyModels({ credential: jwtWithSub("u-1"), fetcher });
    expect(models).toHaveLength(1);
    expect(models?.[0]).toMatchObject({
      modelId: "glm-5.3",
      contextLimit: 1_000_000,
      outputLimit: 131_072,
      reasoning: true,
      toolCall: true,
    });
    // WorkBuddy's base URL carries no version segment, so every row must keep
    // the explicit path or dispatch would 405 upstream.
    expect(models?.[0]?.endpointPath).toBe("/v2/chat/completions");
  });

  test("drops a disabled row and a row outside the cli agent's roster", async () => {
    // Both filters come from the payload: `disabled` is advertised-but-not-served,
    // and the `cli` agent's list is the subset a CLI token may actually call.
    const { fetcher } = directoryServer(OK_DIRECTORY);
    const models = await discoverWorkBuddyModels({ credential: jwtWithSub("u-1"), fetcher });
    const ids = models?.map((model) => model.modelId) ?? [];
    expect(ids).not.toContain("retired-model");
    expect(ids).not.toContain("web-only");
  });

  test("uses the international path on intl hosts and the console path on CN", async () => {
    // The two paths are NOT interchangeable: the CN path on an international
    // host answers HTTP 500 from the edge rather than 404, so a single shared
    // path makes every intl sync fail while looking like an upstream outage.
    const { fetcher, calls } = directoryServer(OK_DIRECTORY);
    await discoverCodeBuddyModels({ credential: jwtWithSub("u-1"), fetcher });
    await discoverWorkBuddyModels({ credential: jwtWithSub("u-1"), fetcher });
    await discoverCodeBuddyCnModels({ credential: jwtWithSub("u-1"), fetcher });
    expect(calls[0]?.url).toBe("https://www.codebuddy.ai/v2/enterprises/personal/models");
    expect(calls[1]?.url).toBe("https://www.workbuddy.ai/v2/enterprises/personal/models");
    expect(calls[2]?.url).toBe("https://copilot.tencent.com/console/enterprises/personal/models");
  });

  test("sends the account uid as X-User-Id when the token carries one", async () => {
    const { fetcher, calls } = directoryServer(OK_DIRECTORY);
    await discoverWorkBuddyModels({ credential: jwtWithSub("acct-42"), fetcher });
    expect(calls[0]?.headers["x-user-id"]).toBe("acct-42");
    expect(calls[0]?.headers["x-no-user-id"]).toBeUndefined();
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${jwtWithSub("acct-42")}`);
  });

  test("declares the uid absent for an opaque key instead of sending an empty one", async () => {
    // An API key is not a JWT and carries no identity. Sending `X-User-Id: ""`
    // would claim an account; omitting the pair is the fail-closed shape.
    const { fetcher, calls } = directoryServer(OK_DIRECTORY);
    await discoverWorkBuddyModels({ credential: "opaque-api-key", fetcher });
    expect(calls[0]?.headers["x-user-id"]).toBeUndefined();
    expect(calls[0]?.headers["x-no-user-id"]).toBe("1");
  });

  test("returns null on a non-zero envelope code rather than an empty catalog", async () => {
    // The caller must report a failed sync. Returning `[]` would look like a
    // successful sync of an empty roster and let it overwrite a working list.
    const { fetcher } = directoryServer({ code: 40100, msg: "unauthorized", data: null });
    expect(await discoverWorkBuddyModels({ credential: jwtWithSub("u-1"), fetcher })).toBeNull();
  });

  test("returns null on a non-200 response", async () => {
    const { fetcher } = directoryServer({ code: 0, data: { models: [] } }, { status: 500 });
    expect(await discoverCodeBuddyModels({ credential: jwtWithSub("u-1"), fetcher })).toBeNull();
  });

  test("returns null when the body is not JSON", async () => {
    const fetcher = (async () =>
      new Response("<html>405</html>", { status: 200 })) as unknown as typeof fetch;
    expect(await discoverCodeBuddyCnModels({ credential: jwtWithSub("u-1"), fetcher })).toBeNull();
  });

  test("returns null when every row is filtered out", async () => {
    const { fetcher } = directoryServer({
      code: 0,
      data: { models: [{ id: "only", disabled: true }], agents: [] },
    });
    expect(await discoverWorkBuddyModels({ credential: jwtWithSub("u-1"), fetcher })).toBeNull();
  });

  test("keeps every row when no cli agent is published", async () => {
    // A site that does not declare the agent roster has no CLI subset to apply,
    // so filtering on a missing list would drop the whole catalog.
    const { fetcher } = directoryServer({
      code: 0,
      data: { models: [{ id: "a" }, { id: "b" }], agents: [] },
    });
    const models = await discoverWorkBuddyModels({ credential: jwtWithSub("u-1"), fetcher });
    expect(models?.map((model) => model.modelId)).toEqual(["a", "b"]);
  });
});
