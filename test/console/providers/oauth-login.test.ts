import { describe, expect, test } from "bun:test";
import { ConsoleDomainError } from "../../../src/console/shared/errors";
import { GatewayError } from "../../../src/transport/gateway-error";
import {
  createOAuthLoginOperations,
  createOAuthLoginRoutes,
  type OAuthAccountStore,
} from "../../../src/console/providers/oauth/routes";
import type { AccessDecision } from "../../../src/security/access-control";
import { OAuthFlowStore } from "../../../src/providers/authentication/oauth-flow-store";
import type { OAuthLoginClient } from "../../../src/providers/authentication/oauth-flow-store";
import { OAuthCallbackListener } from "../../../src/console/providers/oauth/callback-listener";
import { parseProviderId, ProviderRegistry } from "../../../src/providers/provider-registry";
import type { RedisClient } from "../../../src/persistence/redis";

function registryWith(providerId: string, client: OAuthLoginClient): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({
    provider_id: parseProviderId(providerId),
    load: async () => {
      throw new Error("adapter loading is not part of the OAuth login test");
    },
    loadAuthentication: async () => ({ client }),
  });
  return registry;
}

function emptyRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}

describe("oauth.test.ts", () => {
function fakeRedis(shared?: Map<string, string>): RedisClient {
  const store = shared ?? new Map<string, string>();
  return {
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    eval: async (_script: string, _numKeys: number, ...args: string[]) => {
      const key = args[0];
      if (!key) return null;
      const v = store.get(key) ?? null;
      if (v) store.delete(key);
      return v;
    },
  } as unknown as RedisClient;
}

function fakeAccess(overrides: Partial<AccessDecision> = {}): AccessDecision {
  return {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:write"],
        admissionIdentity: "key-1",
    ...overrides,
  };
}

function fakeAccountStore(): OAuthAccountStore & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    persistAccount: async (tenantId, providerId, input) => {
      calls.push({ tenantId, providerId, input });
      return { accountId: "account-1" };
    },
  };
}

function claudeClient(overrides: Partial<OAuthLoginClient> = {}): OAuthLoginClient {
  return {
    supportsDeviceCode: false,
    buildAuthorizeUrl: ({ state, codeChallenge }) =>
      `https://claude.ai/oauth/authorize?state=${state}&code_challenge=${codeChallenge}`,
    exchangeCode: async () => ({
      access: "access-token",
      refresh: "refresh-token",
      expiresAt: new Date(),
      accountLabel: "resolved-account",
    }),
    ...overrides,
  };
}

/**
 * A browser client whose redirect is loopback, like the real Codex/OpenRouter
 * clients. `claudeClient` uses a remote host, which the listener correctly
 * declines to bind, so this is the shape that exercises the bind path.
 */
function loopbackClient(): OAuthLoginClient {
  return {
    supportsDeviceCode: false,
    supportsBrowserCode: true,
    browserRedirectUri: "http://127.0.0.1:54549/callback",
    buildAuthorizeUrl: ({ state, codeChallenge }) =>
      `https://openrouter.ai/auth?state=${state}&code_challenge=${codeChallenge}`,
    exchangeCode: async () => ({
      access: "key",
      refresh: "key",
      expiresAt: new Date(),
    }),
  };
}

/**
 * A callback listener that never binds a real socket.
 *
 * `claudeClient`'s redirect is a remote host, so `register` already declines to
 * bind — but a test that later uses a loopback redirect must not grab a real
 * port on the machine running the suite. The injected `serve` records the binds
 * instead, which also lets a test assert that the port was claimed and released.
 */
function testCallbackListener(): OAuthCallbackListener {
  return new OAuthCallbackListener({
    completer: { complete: async () => ({ ok: true, message: "unused" }) },
    serve: () => ({ port: 1, stop: () => undefined }),
  });
}

function setup(client?: OAuthLoginClient) {
  const redis = fakeRedis();
  const oauthFlowStore = new OAuthFlowStore(redis);
  const accountStore = fakeAccountStore();
  const providerRegistry = client ? registryWith("claude", client) : emptyRegistry();
  const factory = createOAuthLoginOperations({
    providerRegistry,
    oauthFlowStore,
    accountStore,
    accessResolver: () => fakeAccess(),
      callbackListener: testCallbackListener(),
  });
  return { factory, accountStore, providerRegistry, oauthFlowStore };
}

describe("OAuthLoginOperations.beginAuthorize", () => {
  test("requires dashboard:write", async () => {
    const { factory } = setup(claudeClient());
    await expect(factory.beginAuthorize(undefined, "claude", "label")).rejects.toThrow(
      ConsoleDomainError,
    );
  });

  test("404s for a provider with no registered login client", async () => {
    const { factory } = setup();
    await expect(factory.beginAuthorize(fakeAccess(), "claude", "label")).rejects.toThrow(
      "Provider claude has no OAuth login client registered",
    );
  });

  test("returns an authorize URL carrying the generated state and PKCE challenge", async () => {
    const { factory } = setup(claudeClient());
    const result = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    expect(result.authorizeUrl).toContain(`state=${result.state}`);
    expect(result.authorizeUrl).toContain("code_challenge=");
  });

  test("binds the loopback port a browser redirect will arrive on", async () => {
    // The redirect URI these clients advertise is loopback, so it names the
    // operator's machine. Without binding it here the browser lands on a dead
    // page and the code stays in the address bar — the defect that made every
    // browser login require a manual paste.
    const binds: { hostname: string; port: number }[] = [];
    const listener = new OAuthCallbackListener({
      completer: { complete: async () => ({ ok: true, message: "unused" }) },
      serve: (options) => {
        binds.push({ hostname: options.hostname, port: options.port });
        return { port: options.port, stop: () => undefined };
      },
    });
    const factory = createOAuthLoginOperations({
      providerRegistry: registryWith("openrouter", loopbackClient()),
      oauthFlowStore: new OAuthFlowStore(fakeRedis()),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
      callbackListener: listener,
    });

    await factory.beginAuthorize(fakeAccess(), "openrouter", "label");
    expect(binds.map((bind) => bind.port)).toEqual([54549, 54549]);
    expect(binds.map((bind) => bind.hostname)).toEqual(["127.0.0.1", "::1"]);
    listener.stop();
  });
});

describe("OAuthLoginOperations full authorize -> callback round trip", () => {
  test("persists the account with the tenant captured at authorize time", async () => {
    const { factory, accountStore } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(
      fakeAccess({ tenantId: "tenant-42" }),
      "claude",
      "my-account",
    );
    const response = await factory.handleCallback("claude", "auth-code", state);
    expect(response.status).toBeLessThan(400);
    expect(accountStore.calls).toHaveLength(1);
    expect(accountStore.calls[0]).toMatchObject({
      tenantId: "tenant-42",
      providerId: "claude",
      input: { label: "resolved-account", access: "access-token", refresh: "refresh-token" },
    });
  });

  test("callback success page CSP allows its inline close script by hash", async () => {
    const { factory } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const response = await factory.handleCallback("claude", "auth-code", state);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  test("a successful callback invalidates the route snapshot exactly once", async () => {
    let invalidations = 0;
    const redis = fakeRedis();
    const providerRegistry = registryWith("claude", claudeClient());
    const factory = createOAuthLoginOperations({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
      callbackListener: testCallbackListener(),
      snapshotInvalidator: {
        invalidate: async () => {
          invalidations += 1;
          return invalidations;
        },
      },
    });
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const response = await factory.handleCallback("claude", "auth-code", state);
    expect(response.status).toBeLessThan(400);
    expect(invalidations).toBe(1);
  });

  test("falls back to the requested label when the provider doesn't resolve one", async () => {
    const { factory, accountStore } = setup(
      claudeClient({
        exchangeCode: async () => ({
          access: "a",
          refresh: "r",
          expiresAt: new Date(),
        }),
      }),
    );
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "my-label");
    await factory.handleCallback("claude", "code", state);
    expect(accountStore.calls[0]).toMatchObject({ input: { label: "my-label" } });
  });

  test("rejects a callback with an unknown state", async () => {
    const { factory } = setup(claudeClient());
    const response = await factory.handleCallback("claude", "code", "never-issued-state");
    expect(response.status).toBe(400);
  });

  test("a state cannot be replayed for a second callback", async () => {
    const { factory } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    await factory.handleCallback("claude", "code", state);
    const second = await factory.handleCallback("claude", "code", state);
    expect(second.status).toBe(400);
  });

  test("a state issued for one provider is rejected on another provider's callback path", async () => {
    const { factory } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const response = await factory.handleCallback("codex", "code", state);
    expect(response.status).toBe(400);
  });

  test("returns a failure page when token exchange throws", async () => {
    const { factory, accountStore } = setup(
      claudeClient({
        exchangeCode: async () => {
          throw new Error("invalid_grant");
        },
      }),
    );
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const response = await factory.handleCallback("claude", "code", state);
    expect(response.status).toBe(400);
    expect(accountStore.calls).toHaveLength(0);
  });

  test("keeps the generic message for an arbitrary throw", async () => {
    // An upstream body can echo credentials, so anything that is not an error
    // this process authored keeps the generic wording.
    const { factory } = setup(
      claudeClient({
        exchangeCode: async () => {
          throw new Error("upstream said: refresh_token=secret-value");
        },
      }),
    );
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const body = await (await factory.handleCallback("claude", "code", state)).text();
    expect(body).not.toContain("secret-value");
    expect(body).toContain("check the console log");
  });

  test("shows the reason of a cartethyia-origin failure, which the operator must act on", async () => {
    // Regression: a locked Desktop cookie store produced an actionable reason
    // that only reached the server log, so the dialog showed nothing the
    // operator could act on. GatewayError.origin already marks which boundary
    // authored the message, and its contract calls a non-upstream error safe.
    const { factory } = setup(
      claudeClient({
        exchangeCode: async () => {
          throw new GatewayError("authentication_failed", 401, "quit the Desktop app, then retry");
        },
      }),
    );
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const body = await (await factory.handleCallback("claude", "code", state)).text();
    expect(body).toContain("quit the Desktop app, then retry");
  });

  test("consumes a valid state when the provider denies authorization", async () => {
    const { factory } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const denied = await factory.handleCallbackError("claude", state);
    expect(denied.status).toBe(400);
    const replay = await factory.handleCallback("claude", "code", state);
    expect(replay.status).toBe(400);
  });
});


describe("OAuthLoginOperations device-code flow", () => {
  function deviceClient(): OAuthLoginClient & {
    readonly startedContext?: { readonly providerId: string; readonly tenantId: string | null; readonly accountLabel: string };
    readonly polledContext?: {
      readonly providerId: string;
      readonly tenantId: string | null;
      readonly accountLabel: string;
      readonly providerState?: string;
    };
  } {
    let polls = 0;
    // Device-only client: browser authorize/exchange are omitted entirely, so
    // the console reports browser support as unavailable for this provider.
    const client = {
      supportsDeviceCode: true,
      startDeviceAuth: async (context?: {
        readonly providerId: string;
        readonly tenantId: string | null;
        readonly accountLabel: string;
      }) => {
        (client as { startedContext?: typeof context }).startedContext = context;
        return {
          verificationUri: "https://example.com/device",
          userCode: "ABCD-1234",
          deviceAuthId: "device-1",
          intervalSeconds: 5,
          expiresInSeconds: 600,
          providerState: "private-device-state",
        };
      },
      pollDeviceAuth: async (
        _deviceAuthId: string,
        context?: {
          readonly providerId: string;
          readonly tenantId: string | null;
          readonly accountLabel: string;
          readonly providerState?: string;
        },
      ) => {
        (client as { polledContext?: typeof context }).polledContext = context;
        polls += 1;
        if (polls < 2) return { status: "pending" as const };
        return {
          status: "complete" as const,
          result: { access: "a", refresh: "r", expiresAt: new Date() },
        };
      },
    };
    return client;
  }

  test("rejects device start for a provider that does not support it", async () => {
    const { factory } = setup(claudeClient());
    await expect(factory.startDevice(fakeAccess(), "claude", "label")).rejects.toThrow(
      "Provider claude does not support device-code login",
    );
  });

  test("rejects browser authorize for device-only providers", async () => {
    const client = deviceClient();
    const providerRegistry = registryWith("muse", client);
    const factory = createOAuthLoginOperations({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(fakeRedis()),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess({ tenantId: "tenant-7" }),
      callbackListener: testCallbackListener(),
    });
    await expect(
      factory.beginAuthorize(fakeAccess({ tenantId: "tenant-7" }), "muse", "device-account"),
    ).rejects.toMatchObject({
      code: "browser_code_not_supported",
      status: 409,
    });
  });

  test("start -> poll(pending) -> poll(complete) persists the account", async () => {
    const client = deviceClient();
    const providerRegistry = registryWith("codex", client);
    const redis = fakeRedis();
    const accountStore = fakeAccountStore();
    const factory = createOAuthLoginOperations({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore,
      accessResolver: () => fakeAccess({ tenantId: "tenant-7" }),
      callbackListener: testCallbackListener(),
    });
    const started = await factory.startDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      "device-account",
    );
    expect(client.startedContext).toMatchObject({
      providerId: "codex",
      tenantId: "tenant-7",
      accountLabel: "device-account",
    });

    const first = await factory.pollDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      started.deviceAuthId,
    );
    expect(first).toEqual({ status: "pending" });

    const second = await factory.pollDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      started.deviceAuthId,
    );
    expect(second).toEqual({ status: "complete", accountId: "account-1" });
    expect(client.polledContext).toMatchObject({
      providerId: "codex",
      tenantId: "tenant-7",
      accountLabel: "device-account",
      providerState: "private-device-state",
    });
    expect(accountStore.calls[0]).toMatchObject({ tenantId: "tenant-7", providerId: "codex" });

    // Correlation is deleted once resolved — a further poll is unknown.
    await expect(
      factory.pollDevice(fakeAccess({ tenantId: "tenant-7" }), "codex", started.deviceAuthId),
    ).rejects.toThrow("Unknown or expired device-code flow");
  });

  test("poll rejects an unknown deviceAuthId", async () => {
    const { factory } = setup(claudeClient());
    await expect(factory.pollDevice(fakeAccess(), "claude", "never-started")).rejects.toThrow(
      "Unknown or expired device-code flow",
    );
  });

  test("a completing device poll invalidates the route snapshot exactly once", async () => {
    let invalidations = 0;
    const client = deviceClient();
    const providerRegistry = registryWith("codex", client);
    const factory = createOAuthLoginOperations({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(fakeRedis()),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess({ tenantId: "tenant-7" }),
      callbackListener: testCallbackListener(),
      snapshotInvalidator: {
        invalidate: async () => {
          invalidations += 1;
          return invalidations;
        },
      },
    });
    const started = await factory.startDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      "device-account",
    );
    const first = await factory.pollDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      started.deviceAuthId,
    );
    expect(first).toEqual({ status: "pending" });
    expect(invalidations).toBe(0);
    const second = await factory.pollDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      started.deviceAuthId,
    );
    expect(second).toEqual({ status: "complete", accountId: "account-1" });
    expect(invalidations).toBe(1);
  });
});

describe("OAuthLoginOperations imported-credential flow", () => {
  /** A client that completes a login from pasted material. */
  function importingClient() {
    let seen: { readonly credential: string; readonly fields: Readonly<Record<string, string>> } | undefined;
    const client = {
      supportsDeviceCode: false,
      supportsBrowserCode: false,
      importCredential: async (input: {
        readonly credential: string;
        readonly fields: Readonly<Record<string, string>>;
      }) => {
        if (input.credential === "dead") throw new Error("the refresh token was rejected by the upstream");
        seen = input;
        return { access: "imported-access", refresh: "imported-refresh", expiresAt: new Date() };
      },
      seenInput: () => seen,
    };
    return client;
  }

  test("persists an account from pasted material and returns its id", async () => {
    const client = importingClient();
    const accountStore = fakeAccountStore();
    let invalidations = 0;
    const factory = createOAuthLoginOperations({
      providerRegistry: registryWith("kiro", client),
      oauthFlowStore: new OAuthFlowStore(fakeRedis()),
      accountStore,
      accessResolver: () => fakeAccess({ tenantId: "tenant-7" }),
      callbackListener: testCallbackListener(),
      snapshotInvalidator: {
        invalidate: async () => {
          invalidations += 1;
          return invalidations;
        },
      },
    });
    const result = await factory.importCredential(
      fakeAccess({ tenantId: "tenant-7" }),
      "kiro",
      "operator-label",
      "pasted-material",
      { authMethod: "idc", region: "eu-west-1" },
    );
    expect(result.accountId).toBe("account-1");
    expect(client.seenInput()).toEqual({
      credential: "pasted-material",
      fields: { authMethod: "idc", region: "eu-west-1" },
    });
    expect(accountStore.calls[0]).toMatchObject({ tenantId: "tenant-7", providerId: "kiro" });
    expect(invalidations).toBe(1);
  });

  test("refuses an import for a provider that cannot complete one", async () => {
    const { factory } = setup(claudeClient());
    await expect(
      factory.importCredential(fakeAccess(), "claude", "label", "material", {}),
    ).rejects.toMatchObject({ code: "import_not_supported", status: 409 });
  });

  test("does not persist material the upstream rejected", async () => {
    // The client validates before returning, so a dead credential never reaches
    // the account table and the operator sees the upstream's own reason.
    const accountStore = fakeAccountStore();
    const factory = createOAuthLoginOperations({
      providerRegistry: registryWith("kiro", importingClient()),
      oauthFlowStore: new OAuthFlowStore(fakeRedis()),
      accountStore,
      accessResolver: () => fakeAccess({ tenantId: "tenant-7" }),
      callbackListener: testCallbackListener(),
    });
    await expect(
      factory.importCredential(fakeAccess({ tenantId: "tenant-7" }), "kiro", "label", "dead", {}),
    ).rejects.toThrow("rejected by the upstream");
    expect(accountStore.calls).toHaveLength(0);
  });
});

describe("oauth routes — real Elysia schema validation", () => {
  test("device/poll rejects a missing body with 422 instead of crashing on a null read", async () => {
    const { providerRegistry } = setup(claudeClient());
    const redis = fakeRedis();
    const app = createOAuthLoginRoutes({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
      callbackListener: testCallbackListener(),
    });
    const response = await app.handle(
      new Request("http://localhost/providers/claude/oauth/device/poll", { method: "POST" }),
    );
    expect(response.status).toBe(422);
  });

  test("device/poll rejects a body with the wrong deviceAuthId type", async () => {
    const { providerRegistry } = setup(claudeClient());
    const redis = fakeRedis();
    const app = createOAuthLoginRoutes({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
      callbackListener: testCallbackListener(),
    });
    const response = await app.handle(
      new Request("http://localhost/providers/claude/oauth/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceAuthId: 12345 }),
      }),
    );
    expect(response.status).toBe(422);
  });

  test("authorize accepts a body with no accountLabel field", async () => {
    const { providerRegistry } = setup(claudeClient());
    const redis = fakeRedis();
    const app = createOAuthLoginRoutes({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
      callbackListener: testCallbackListener(),
    });
    const response = await app.handle(
      new Request("http://localhost/providers/claude/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(201);
  });

  test("callback route consumes state for an OAuth error callback", async () => {
    const { factory, providerRegistry, oauthFlowStore } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const app = createOAuthLoginRoutes({
      providerRegistry,
      oauthFlowStore,
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
      callbackListener: testCallbackListener(),
    });
    const denied = await app.handle(
      new Request(`http://localhost/providers/claude/oauth/callback?state=${state}&error=access_denied`),
    );
    expect(denied.status).toBe(400);
    const replay = await app.handle(
      new Request(`http://localhost/providers/claude/oauth/callback?state=${state}&code=code`),
    );
    expect(replay.status).toBe(400);
  });
});
});
