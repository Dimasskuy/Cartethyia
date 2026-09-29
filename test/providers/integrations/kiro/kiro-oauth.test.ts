/**
 * Kiro authentication flows.
 *
 * The load-bearing properties here are the ones that fail only against the real
 * upstream: the device flow's client registration is replayed at refresh, the
 * profile ARN rule differs per auth family, and the enterprise token endpoint is
 * restricted before the account's refresh token is posted to it.
 */
import { describe, expect, test } from "bun:test";
import { VERSION_SOURCES, _resetKiroVersion } from "../../../../src/providers/operations/client-versions";
import {
  KiroOAuthClient,
  normalizeRegion,
  parseKiroAuthState,
  validateMicrosoftTokenEndpoint,
} from "../../../../src/providers/integrations/kiro/kiro-oauth";
import { resolveKiroProfileArn } from "../../../../src/providers/integrations/kiro/kiro-profile";
import {
  deriveApiKeyMachineId,
  deriveOAuthMachineId,
} from "../../../../src/providers/integrations/kiro/kiro-machine-id";

const ACCOUNT_PROFILE = "arn:aws:codewhisperer:us-east-1:999988887777:profile/ACCOUNT";

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** A recording transport that answers each URL from a map. */
function transport(answers: Record<string, () => Response>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const rawBody = init?.body;
    calls.push({
      url,
      method: init?.method,
      // Form bodies arrive as `URLSearchParams`; both shapes are recorded as text
      // so an assertion can read whichever a provider sends.
      body:
        typeof rawBody === "string"
          ? rawBody
          : rawBody instanceof URLSearchParams
            ? rawBody.toString()
            : "",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    for (const [fragment, build] of Object.entries(answers)) {
      if (url.includes(fragment)) return build();
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("normalizeRegion", () => {
  test("accepts an AWS region and rejects anything else", () => {
    expect(normalizeRegion("eu-west-1")).toBe("eu-west-1");
    expect(normalizeRegion("not a region")).toBe("us-east-1");
    expect(normalizeRegion(undefined)).toBe("us-east-1");
  });
});

describe("resolveKiroProfileArn", () => {
  test("never sends a default to a credential that is scoped by the credential itself", () => {
    // An API key names the account itself, and an enterprise export carries its
    // own ARN; a default would scope the request to a subscription neither has
    // a claim to, which the upstream refuses.
    for (const authMethod of ["api_key", "external_idp"] as const) {
      expect(resolveKiroProfileArn({ authMethod, region: "us-east-1" })).toBe("");
    }
    expect(
      resolveKiroProfileArn({ authMethod: "api_key", region: "us-east-1", profileArn: ACCOUNT_PROFILE }),
    ).toBe(ACCOUNT_PROFILE);
  });

  test("sends the family's public default for an interactive account that resolved none", () => {
    // The field is part of the wire contract for these families: a request
    // without it is answered `400 profileArn is required for this request.`
    for (const authMethod of ["builder-id", "idc", "imported"] as const) {
      expect(resolveKiroProfileArn({ authMethod, region: "us-east-1" })).toBe(
        "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
      );
    }
  });

  test("scopes a social account to the social default, not the builder one", () => {
    // The builder default under a social token is answered `403 Invalid token`.
    for (const authMethod of ["google", "github"] as const) {
      expect(resolveKiroProfileArn({ authMethod, region: "us-east-1" })).toBe(
        "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
      );
    }
  });

  test("returns the profile the account resolved over any default", () => {
    for (const authMethod of ["builder-id", "google", "idc", "imported"] as const) {
      expect(resolveKiroProfileArn({ authMethod, region: "us-east-1", profileArn: ACCOUNT_PROFILE })).toBe(
        ACCOUNT_PROFILE,
      );
    }
  });

  test("returns nothing when the account carries no auth method to choose a default from", () => {
    expect(resolveKiroProfileArn(undefined)).toBe("");
    expect(resolveKiroProfileArn({})).toBe("");
  });
});

describe("validateMicrosoftTokenEndpoint", () => {
  test("accepts the Microsoft login hosts", () => {
    expect(
      validateMicrosoftTokenEndpoint("https://login.microsoftonline.com/tenant/oauth2/v2.0/token"),
    ).toContain("login.microsoftonline.com");
  });

  test("refuses a non-Microsoft host, a non-https scheme, and an empty value", () => {
    expect(() => validateMicrosoftTokenEndpoint("https://evil.example.com/token")).toThrow();
    expect(() => validateMicrosoftTokenEndpoint("http://login.microsoftonline.com/token")).toThrow();
    expect(() => validateMicrosoftTokenEndpoint("")).toThrow();
  });
});

describe("parseKiroAuthState", () => {
  test("reads a stored state and rejects one with no recognized method", () => {
    expect(parseKiroAuthState({ authMethod: "idc", region: "eu-west-1" })).toEqual({
      authMethod: "idc",
      region: "eu-west-1",
    });
    expect(parseKiroAuthState({ authMethod: "unknown-method" })).toBeUndefined();
    expect(parseKiroAuthState(undefined)).toBeUndefined();
  });
});

describe("KiroOAuthClient device flow", () => {
  test("registers a client, starts authorization, and returns the registration as private state", async () => {
    const { calls, fetch } = transport({
      "client/register": () => json({ clientId: "cid", clientSecret: "csecret" }),
      device_authorization: () =>
        json({
          deviceCode: "device-1",
          userCode: "USER-1",
          verificationUri: "https://example.test/verify",
          interval: 5,
          expiresIn: 900,
        }),
    });
    const client = new KiroOAuthClient(fetch);
    const started = await client.startDeviceAuth({
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
      parameters: { region: "eu-west-1", startUrl: "https://org.awsapps.com/start", authMethod: "idc" },
    });
    expect(started.deviceAuthId).toBe("device-1");
    expect(started.userCode).toBe("USER-1");
    const registration = JSON.parse(started.providerState ?? "{}") as Record<string, unknown>;
    expect(registration.clientId).toBe("cid");
    expect(registration.region).toBe("eu-west-1");
    expect(registration.authMethod).toBe("idc");
    expect(calls[0]?.url).toContain("oidc.eu-west-1.amazonaws.com/client/register");
    expect(calls[1]?.url).toContain("oidc.eu-west-1.amazonaws.com/device_authorization");
  });

  test("completes the poll with the registration's client secret kept beside the tokens", async () => {
    const { fetch } = transport({
      "oidc.us-east-1.amazonaws.com/token": () =>
        json({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600, profileArn: ACCOUNT_PROFILE }),
    });
    const client = new KiroOAuthClient(fetch);
    const polled = await client.pollDeviceAuth("device-1", {
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
      providerState: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        region: "us-east-1",
        startUrl: "https://view.awsapps.com/start",
        authMethod: "builder-id",
      }),
    });
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    expect(polled.result.access).toBe("access-1");
    expect(polled.result.client_secret).toBe("csecret");
    expect(polled.result.auth_state?.["profileArn"]).toBe(ACCOUNT_PROFILE);
    expect(polled.result.auth_state?.["authMethod"]).toBe("builder-id");
  });

  test("resolves the account's own profile when the OIDC token response omits it", async () => {
    // AWS SSO OIDC answers with the tokens only — it never reports a profile —
    // so an Identity Center account has to resolve its own before it is
    // persisted. The account's region wins over a profile minted elsewhere.
    const { calls, fetch } = transport({
      "oidc.us-east-1.amazonaws.com/token": () =>
        json({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 }),
      "codewhisperer.us-east-1.amazonaws.com": () =>
        json({
          profiles: [
            { arn: "arn:aws:codewhisperer:eu-west-1:1:profile/ELSEWHERE" },
            { arn: ACCOUNT_PROFILE },
          ],
        }),
    });
    const client = new KiroOAuthClient(fetch);
    const polled = await client.pollDeviceAuth("device-1", {
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
      providerState: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        region: "us-east-1",
        startUrl: "https://view.awsapps.com/start",
        authMethod: "idc",
      }),
    });
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    expect(polled.result.auth_state?.["profileArn"]).toBe(ACCOUNT_PROFILE);
    // The listing is the awsJson operation on the CodeWhisperer service entry,
    // reached by POST with an x-amz-target — not a path on the generation host.
    const listing = calls.find((call) => call.url.includes("codewhisperer."));
    expect(listing?.url).toContain("codewhisperer.us-east-1.amazonaws.com");
    expect(listing?.headers["x-amz-target"]).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
  });

  test("never asks the profile listing for a Builder ID, which it refuses outright", async () => {
    // The operation answers a Builder ID with `403 AWS Builder ID is not
    // supported for this operation.` A login path must not spend a request that
    // is known to be refused; the account is served by its family's default.
    const { calls, fetch } = transport({
      "oidc.us-east-1.amazonaws.com/token": () =>
        json({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 }),
      "codewhisperer.us-east-1.amazonaws.com": () =>
        json({ profiles: [{ arn: ACCOUNT_PROFILE }] }),
    });
    const client = new KiroOAuthClient(fetch);
    const polled = await client.pollDeviceAuth("device-1", {
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
      providerState: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        region: "us-east-1",
        startUrl: "https://view.awsapps.com/start",
        authMethod: "builder-id",
      }),
    });
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    expect(calls.some((call) => call.url.includes("codewhisperer."))).toBe(false);
    expect(polled.result.auth_state).not.toHaveProperty("profileArn");
  });

  test("falls back to a profile minted elsewhere when none matches the region", async () => {
    // An account can hold only profiles outside the region it authenticates
    // against; one of its own is still the right answer, and better than none.
    const { fetch } = transport({
      "oidc.us-east-1.amazonaws.com/token": () =>
        json({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 }),
      "codewhisperer.us-east-1.amazonaws.com": () =>
        json({ profiles: [{ arn: "arn:aws:codewhisperer:eu-west-1:1:profile/ELSEWHERE" }] }),
    });
    const client = new KiroOAuthClient(fetch);
    const polled = await client.pollDeviceAuth("device-1", {
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
      providerState: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        region: "us-east-1",
        startUrl: "https://view.awsapps.com/start",
        authMethod: "idc",
      }),
    });
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    expect(polled.result.auth_state?.["profileArn"]).toBe("arn:aws:codewhisperer:eu-west-1:1:profile/ELSEWHERE");
  });

  test("prefers the profile the token response reports over a listing", async () => {
    // The social families answer with the account's ARN in the token response
    // itself; that value is stated rather than inferred, so it is used as-is.
    const { calls, fetch } = transport({
      "oidc.us-east-1.amazonaws.com/token": () =>
        json({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600, profileArn: ACCOUNT_PROFILE }),
      "codewhisperer.us-east-1.amazonaws.com": () =>
        json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/ELSEWHERE" }] }),
    });
    const client = new KiroOAuthClient(fetch);
    const polled = await client.pollDeviceAuth("device-1", {
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
      providerState: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        region: "us-east-1",
        startUrl: "https://view.awsapps.com/start",
        authMethod: "idc",
      }),
    });
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    expect(polled.result.auth_state?.["profileArn"]).toBe(ACCOUNT_PROFILE);
    expect(calls.some((call) => call.url.includes("codewhisperer."))).toBe(false);
  });

  test("persists no profile rather than failing the sign-in when none can be read", async () => {
    // Resolution runs on the login path, so a listing the account cannot read
    // must not block a sign-in that otherwise succeeded — the operator can still
    // supply the ARN by import.
    const { fetch } = transport({
      "oidc.us-east-1.amazonaws.com/token": () =>
        json({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 }),
      "codewhisperer.us-east-1.amazonaws.com": () => new Response("denied", { status: 403 }),
    });
    const client = new KiroOAuthClient(fetch);
    const polled = await client.pollDeviceAuth("device-1", {
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
      providerState: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        region: "us-east-1",
        startUrl: "https://view.awsapps.com/start",
        authMethod: "builder-id",
      }),
    });
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    expect(polled.result.access).toBe("access-1");
    expect(polled.result.auth_state).not.toHaveProperty("profileArn");
  });

  test("reports a pending authorization without failing the flow", async () => {
    const { fetch } = transport({
      "oidc.us-east-1.amazonaws.com/token": () => json({ error: "authorization_pending" }, 400),
    });
    const client = new KiroOAuthClient(fetch);
    const polled = await client.pollDeviceAuth("device-1", {
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
      providerState: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        region: "us-east-1",
        startUrl: "https://view.awsapps.com/start",
        authMethod: "builder-id",
      }),
    });
    expect(polled.status).toBe("pending");
  });

  test("fails a poll whose registration is missing rather than guessing a client", async () => {
    const { calls, fetch } = transport({});
    const client = new KiroOAuthClient(fetch);
    const polled = await client.pollDeviceAuth("device-1", {
      providerId: "kiro",
      tenantId: null,
      accountLabel: "kiro",
    });
    expect(polled.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

describe("KiroOAuthClient refresh", () => {
  test("replays the registered client credentials at the regional OIDC endpoint", async () => {
    const { calls, fetch } = transport({
      "oidc.eu-west-1.amazonaws.com/token": () => json({ accessToken: "a2", refreshToken: "r2", expiresIn: 60 }),
    });
    const client = new KiroOAuthClient(fetch);
    const result = await client.refresh("r1", undefined, {
      account_id: "acct-1",
      auth_state: { authMethod: "idc", region: "eu-west-1", clientId: "cid" },
      client_secret: "csecret",
    });
    expect(result.access).toBe("a2");
    expect(calls[0]?.url).toContain("oidc.eu-west-1.amazonaws.com/token");
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.clientId).toBe("cid");
    expect(body.clientSecret).toBe("csecret");
    expect(body.grantType).toBe("refresh_token");
  });

  test("refuses a device-flow refresh with no client secret rather than posting without one", async () => {
    const { calls, fetch } = transport({});
    const client = new KiroOAuthClient(fetch);
    await expect(
      client.refresh("r1", undefined, {
        account_id: "acct-1",
        auth_state: { authMethod: "builder-id", region: "us-east-1", clientId: "cid" },
      }),
    ).rejects.toThrow(/client registration/);
    expect(calls).toHaveLength(0);
  });

  test("refreshes an enterprise account at its own token endpoint", async () => {
    const { calls, fetch } = transport({
      "login.microsoftonline.com": () => json({ access_token: "a3", refresh_token: "r3", expires_in: 1800 }),
    });
    const client = new KiroOAuthClient(fetch);
    const result = await client.refresh("r1", undefined, {
      account_id: "acct-1",
      auth_state: {
        authMethod: "external_idp",
        region: "us-east-1",
        clientId: "ent-client",
        tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
        scope: "openid offline_access",
      },
    });
    expect(result.access).toBe("a3");
    expect(calls[0]?.url).toContain("login.microsoftonline.com");
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
  });

  test("refreshes a social or imported account at the vendor service", async () => {
    const { calls, fetch } = transport({
      "auth.desktop.kiro.dev/refreshToken": () => json({ accessToken: "a4", refreshToken: "r4", expiresIn: 3600 }),
    });
    const client = new KiroOAuthClient(fetch);
    const machineId = "a".repeat(64);
    const result = await client.refresh("r1", undefined, {
      account_id: "acct-1",
      auth_state: { authMethod: "google", region: "us-east-1", machineId },
    });
    expect(result.access).toBe("a4");
    expect(calls[0]?.url).toContain("auth.desktop.kiro.dev/refreshToken");
    // This surface is plain HTTPS with no AWS SDK behind it, so the real client
    // identifies itself with the device marker alone. Adding an `aws-sdk-js/`
    // segment here would describe a client that does not exist.
    const device = `KiroIDE-${VERSION_SOURCES.kiro.fallback}-${machineId}`;
    expect(calls[0]?.headers["user-agent"]).toBe(device);
    expect(calls[0]?.headers["x-amz-user-agent"]).toBe(device);
  });

  test("carries a profile the refresh discovered back into the stored state", async () => {
    const { fetch } = transport({
      "auth.desktop.kiro.dev/refreshToken": () =>
        json({ accessToken: "a5", refreshToken: "r5", expiresIn: 3600, profileArn: ACCOUNT_PROFILE }),
    });
    const client = new KiroOAuthClient(fetch);
    const result = await client.refresh("r1", undefined, {
      account_id: "acct-1",
      auth_state: { authMethod: "imported", region: "us-east-1" },
    });
    expect(result.auth_state?.["profileArn"]).toBe(ACCOUNT_PROFILE);
    expect(result.auth_state?.["authMethod"]).toBe("imported");
  });
});

describe("KiroOAuthClient imports and API keys", () => {
  test("validates an API key against the model catalog and stores no profile", async () => {
    _resetKiroVersion(VERSION_SOURCES.kiro.fallback);
    try {
      const { calls, fetch } = transport({
        ListAvailableModels: () => json({ models: [{ modelId: "claude-sonnet-4.5" }] }),
      });
      const client = new KiroOAuthClient(fetch);
      const result = await client.validateApiKey("key-value", "eu-west-1");
      expect(calls[0]?.url).toContain("q.eu-west-1.amazonaws.com/ListAvailableModels");
      expect(calls[0]?.headers["tokentype"]).toBe("API_KEY");
      const machineId = deriveApiKeyMachineId("key-value");
      expect(calls[0]?.headers["user-agent"]).toContain(
        `KiroIDE-${VERSION_SOURCES.kiro.fallback}-${machineId}`,
      );
      expect(calls[0]?.headers["x-amz-user-agent"]).toBe(
        `aws-sdk-js/1.0.39 KiroIDE-${VERSION_SOURCES.kiro.fallback}-${machineId}`,
      );
      expect(calls[0]?.headers.connection).toBe("close");
      expect(result.auth_state).toEqual({
        authMethod: "api_key",
        region: "eu-west-1",
        machineId: deriveApiKeyMachineId("key-value"),
      });
      expect(result.refresh).toBe("");
    } finally {
      _resetKiroVersion();
    }
  });

  test("rejects an API key that reaches no models", async () => {
    const { fetch } = transport({ ListAvailableModels: () => json({ models: [] }) });
    const client = new KiroOAuthClient(fetch);
    await expect(client.validateApiKey("key-value")).rejects.toThrow(/no available models/);
  });

  test("validates an imported refresh token by actually refreshing it", async () => {
    const { fetch } = transport({
      "auth.desktop.kiro.dev/refreshToken": () => json({ accessToken: "imported-access", refreshToken: "imported-refresh" }),
    });
    const client = new KiroOAuthClient(fetch);
    const result = await client.importRefreshToken("aorAAAAAG-token", {});
    expect(result.access).toBe("imported-access");
    expect(result.auth_state?.["authMethod"]).toBe("imported");
  });

  test("imports an Identity Center refresh token with its client credentials", async () => {
    const { calls, fetch } = transport({
      "oidc.eu-central-1.amazonaws.com/token": () => json({ accessToken: "idc-access", refreshToken: "idc-refresh" }),
    });
    const client = new KiroOAuthClient(fetch);
    const result = await client.importRefreshToken("aorAAAAAG-token", {
      clientId: "idc-client",
      clientSecret: "idc-secret",
      region: "eu-central-1",
    });
    expect(calls[0]?.url).toContain("oidc.eu-central-1.amazonaws.com/token");
    expect(result.auth_state?.["authMethod"]).toBe("idc");
    expect(result.client_secret).toBe("idc-secret");
  });

  test("imports enterprise JSON with every field required", () => {
    const client = new KiroOAuthClient();
    const result = client.importExternalIdp({
      auth_method: "external_idp",
      access_token: "ent-access",
      refresh_token: "ent-refresh",
      client_id: "ent-client",
      token_endpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      profile_arn: ACCOUNT_PROFILE,
      scopes: ["openid", "offline_access"],
      region: "us-east-1",
    });
    expect(result.access).toBe("ent-access");
    expect(result.auth_state).toEqual({
      authMethod: "external_idp",
      region: "us-east-1",
      profileArn: ACCOUNT_PROFILE,
      clientId: "ent-client",
      tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      scope: "openid offline_access",
      machineId: deriveOAuthMachineId("ent-refresh"),
    });
  });

  test("refuses enterprise JSON missing a required field or naming a foreign endpoint", () => {
    const client = new KiroOAuthClient();
    const base = {
      access_token: "a",
      refresh_token: "r",
      client_id: "c",
      token_endpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      profile_arn: ACCOUNT_PROFILE,
      scopes: "openid",
    };
    expect(() => client.importExternalIdp({ ...base, access_token: undefined })).toThrow();
    expect(() => client.importExternalIdp({ ...base, profile_arn: undefined })).toThrow();
    expect(() =>
      client.importExternalIdp({ ...base, token_endpoint: "https://evil.example.com/token" }),
    ).toThrow();
    expect(() => client.importExternalIdp({ ...base, auth_method: "builder-id" })).toThrow();
  });
});

describe("KiroOAuthClient social authorize URL", () => {
  test("names the identity provider the operator chose", () => {
    const client = new KiroOAuthClient();
    const google = client.buildAuthorizeUrl({
      state: "s",
      codeChallenge: "c",
      redirectUri: "ignored",
      parameters: { idp: "google" },
    });
    expect(google).toContain("idp=Google");
    expect(google).toContain("redirect_uri=kiro%3A%2F%2Fkiro.kiroAgent%2Fauthenticate-success");
    expect(google).toContain("code_challenge_method=S256");

    const github = client.buildAuthorizeUrl({
      state: "s",
      codeChallenge: "c",
      redirectUri: "ignored",
      parameters: { idp: "github" },
    });
    expect(github).toContain("idp=Github");
  });
});
