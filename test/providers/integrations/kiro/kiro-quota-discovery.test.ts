/**
 * Kiro quota and model discovery.
 *
 * Both are region- and profile-scoped surfaces reached with the account's own
 * auth configuration, so these pin that the configuration actually reaches the
 * request and that an account-bound credential is never sent the shared profile
 * placeholder.
 */
import { describe, expect, test } from "bun:test";
import { fetchKiroQuota } from "../../../../src/providers/integrations/kiro/kiro-quota";
import { fetchKiroModels } from "../../../../src/providers/integrations/kiro/kiro-discovery";

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
}

function recording(handler: (url: string) => Response): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url);
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchKiroQuota", () => {
  test("reads usage windows from the first surface that answers", async () => {
    const { calls, fetch } = recording(() =>
      json({
        subscriptionInfo: { subscriptionTitle: "Kiro Pro" },
        nextDateReset: 1_800_000_000,
        usageBreakdownList: [
          { resourceType: "AGENTIC_REQUEST", currentUsageWithPrecision: 25, usageLimitWithPrecision: 100 },
        ],
      }),
    );
    const result = await fetchKiroQuota("token-value", fetch, {
      auth_state: { authMethod: "builder-id", region: "eu-west-1" },
    });
    expect(calls[0]?.url).toContain("q.eu-west-1.amazonaws.com/getUsageLimits");
    // The usage surface is profile-scoped and refuses a request without the
    // field, so the sign-in family's public default travels with it.
    expect(calls[0]?.url).toContain("profileArn=");
    expect(result.plan).toBe("Kiro Pro");
    expect(result.error).toBeNull();
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.usedPercent).toBe(25);
    expect(result.windows[0]?.resetsAt).not.toBeNull();
  });

  test("declares the API key token type and never the shared profile for an account-bound key", async () => {
    const { calls, fetch } = recording(() =>
      json({ usageBreakdownList: [{ resourceType: "AGENTIC_REQUEST", currentUsageWithPrecision: 1, usageLimitWithPrecision: 10 }] }),
    );
    await fetchKiroQuota("key-value", fetch, {
      auth_state: { authMethod: "api_key", region: "us-east-1" },
      credential_kind: "api_key",
    });
    expect(calls[0]?.headers["tokentype"]).toBe("API_KEY");
  });

  test("rotates to the next surface when one refuses the credential", async () => {
    const { calls, fetch } = recording((url) =>
      url.includes("getUsageLimits")
        ? json({ usageBreakdownList: [{ resourceType: "AGENTIC_REQUEST", currentUsageWithPrecision: 3, usageLimitWithPrecision: 30 }] })
        : new Response("nope", { status: 403 }),
    );
    const result = await fetchKiroQuota("token-value", fetch, {
      auth_state: { authMethod: "builder-id", region: "us-east-1" },
    });
    expect(result.error).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test("names the credential as the cause when every surface refuses it", async () => {
    const { fetch } = recording(() => new Response("denied", { status: 403 }));
    const result = await fetchKiroQuota("token-value", fetch, {
      auth_state: { authMethod: "idc", region: "us-east-1" },
    });
    expect(result.windows).toEqual([]);
    expect(result.error).toMatch(/rejected the stored credential/);
  });

  test("reports a transport failure rather than an empty success", async () => {
    const { fetch } = recording(() => new Response("boom", { status: 500 }));
    const result = await fetchKiroQuota("token-value", fetch, {
      auth_state: { authMethod: "builder-id", region: "us-east-1" },
    });
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/HTTP 500/);
  });

  test("rejects an empty credential", async () => {
    const { fetch } = recording(() => json({}));
    await expect(fetchKiroQuota("  ", fetch)).rejects.toThrow(/empty/);
  });

  test("falls back to us-east-1 for a region that is not an AWS region", async () => {
    const { calls, fetch } = recording(() =>
      json({ usageBreakdownList: [{ resourceType: "AGENTIC_REQUEST", currentUsageWithPrecision: 1, usageLimitWithPrecision: 10 }] }),
    );
    await fetchKiroQuota("token-value", fetch, {
      auth_state: { authMethod: "builder-id", region: "../../evil" },
    });
    expect(calls[0]?.url).toContain("q.us-east-1.amazonaws.com");
  });
});

describe("fetchKiroModels", () => {
  test("reads the account's model list scoped by region and profile", async () => {
    const { calls, fetch } = recording(() =>
      json({
        models: [
          { modelId: "claude-sonnet-4.5", tokenLimits: { maxInputTokens: 500_000 } },
          { modelId: "gpt-5.6-sol", tokenLimits: { maxInputTokens: 272_000 } },
        ],
      }),
    );
    const models = await fetchKiroModels({
      credential: "token-value",
      fetcher: fetch,
      authState: { authMethod: "idc", region: "eu-central-1", profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/AAA" },
    });
    expect(calls[0]?.url).toContain("q.eu-central-1.amazonaws.com/ListAvailableModels");
    expect(calls[0]?.url).toContain("profileArn=");
    expect(calls[0]?.headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
    expect(models).toHaveLength(2);
    expect(models?.[0]?.modelId).toBe("claude-sonnet-4.5");
    expect(models?.[0]?.contextLimit).toBe(500_000);
    expect(models?.[0]?.toolCall).toBe(true);
  });

  test("returns null rather than an empty list when the catalog cannot be read", async () => {
    const { fetch } = recording(() => new Response("denied", { status: 403 }));
    expect(await fetchKiroModels({ credential: "token-value", fetcher: fetch })).toBeNull();
    const { fetch: badShape } = recording(() => json({ unexpected: true }));
    expect(await fetchKiroModels({ credential: "token-value", fetcher: badShape })).toBeNull();
  });

  test("returns null for an empty catalog so the seeded rows stand", async () => {
    // An empty list is not an answer to sync from: returning it would replace
    // the seeded catalog with nothing.
    const { fetch } = recording(() => json({ models: [] }));
    expect(await fetchKiroModels({ credential: "token-value", fetcher: fetch })).toBeNull();
  });

  test("returns null for an empty credential without calling upstream", async () => {
    const { calls, fetch } = recording(() => json({ models: [] }));
    expect(await fetchKiroModels({ credential: "  ", fetcher: fetch })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("sends the family's public default for an interactive sign-in with none resolved", async () => {
    const { calls, fetch } = recording(() => json({ models: [{ modelId: "claude-sonnet-4.5" }] }));
    await fetchKiroModels({
      credential: "token-value",
      fetcher: fetch,
      authState: { authMethod: "builder-id", region: "us-east-1" },
    });
    // Discovery scopes by the same resolution dispatch uses, so the surface
    // never sees a request the generation surface would not send.
    expect(calls[0]?.url).toContain("profileArn=");
  });

  test("presents the same device identity the generation surface presents", async () => {
    // One account must be one machine on every surface. A credential that reports
    // one device at dispatch and another while reading its own catalog is the
    // signal this gateway exists to avoid.
    const frozen = "d".repeat(64);
    const { calls, fetch } = recording(() => json({ models: [{ modelId: "claude-sonnet-4.5" }] }));
    await fetchKiroModels({
      credential: "token-value",
      fetcher: fetch,
      authState: { authMethod: "builder-id", region: "us-east-1", machineId: frozen },
    });
    expect(calls[0]?.headers["user-agent"]).toContain(frozen);
    expect(calls[0]?.headers["x-amz-user-agent"]).toContain(frozen);
    expect(calls[0]?.headers.connection).toBe("close");
  });

  test("uses the same fallback device id the quota surface uses when none is frozen", async () => {
    const authState = { authMethod: "builder-id", region: "us-east-1", clientId: "client-1" };
    const { calls: modelCalls, fetch: modelFetch } = recording(() => json({ models: [{ modelId: "m" }] }));
    await fetchKiroModels({ credential: "t", fetcher: modelFetch, authState });
    const { calls: quotaCalls, fetch: quotaFetch } = recording(() => json({ usageBreakdownList: [] }));
    await fetchKiroQuota("t", quotaFetch, { auth_state: authState });

    const idFrom = (headers: Record<string, string>): string | undefined =>
      /KiroIDE-[\d.]+-([0-9a-f]{64})/.exec(headers["user-agent"] ?? "")?.[1];
    expect(idFrom(modelCalls[0]?.headers ?? {})).toBeDefined();
    expect(idFrom(modelCalls[0]?.headers ?? {})).toBe(idFrom(quotaCalls[0]?.headers ?? {}));
  });

  test("deduplicates a model the catalog lists twice", async () => {
    const { fetch } = recording(() =>
      json({ models: [{ modelId: "claude-sonnet-4.5" }, { modelId: "claude-sonnet-4.5" }] }),
    );
    const models = await fetchKiroModels({ credential: "token-value", fetcher: fetch });
    expect(models).toHaveLength(1);
  });
});
