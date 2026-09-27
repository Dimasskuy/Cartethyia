import { describe, expect, test } from "bun:test";
import {
  ZcodeOAuthClient,
  ZCODE_AUTHORIZE_URL,
  ZCODE_CLIENT_ID,
  ZCODE_REDIRECT_URI,
  ZCODE_TOKEN_URL,
} from "../../../src/providers/integrations/zcode-oauth";

/**
 * The Coding Plan sign-in is two-stage: an OAuth code exchange mints a
 * short-lived access token, which is then traded through Z.AI's business APIs
 * for the durable `<apiKey>.<secretKey>` the coding endpoint actually accepts.
 *
 * The stage that matters most is the second one, because storing the OAuth
 * token instead of the minted key produces a credential that authenticates
 * nowhere — the failure would only appear at first dispatch, far from login.
 * These tests pin the whole chain and each place it can silently degrade: a
 * masked secret from the list endpoint, a missing organization, a re-login
 * reusing the existing key rather than creating a second one.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
  readonly authorization: string | undefined;
}

/** Routes each stage of the flow to a canned response, recording every call. */
function zaiServer(options: {
  readonly token?: unknown;
  readonly tokenStatus?: number;
  readonly bizToken?: unknown;
  readonly customer?: unknown;
  readonly keys?: unknown;
  readonly created?: unknown;
  readonly copied?: unknown;
}): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      authorization: headers.authorization,
    });
    const reply = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === ZCODE_TOKEN_URL) {
      return reply(options.token ?? { data: { zai: { access_token: "oauth-token" } } }, options.tokenStatus ?? 200);
    }
    if (url.includes("/api/auth/z/login")) {
      return reply(options.bizToken ?? { code: 200, data: { access_token: "biz-token" } });
    }
    if (url.includes("getCustomerInfo")) {
      return reply(
        options.customer ?? {
          code: 200,
          data: {
            organizations: [
              { organizationId: "org-1", isDefault: true, projects: [{ projectId: "proj-1", isDefault: true }] },
            ],
          },
        },
      );
    }
    if (url.endsWith("/api_keys")) {
      if (init?.method === "POST") return reply(options.created ?? { code: 200, data: { apiKey: "key-created" } });
      return reply(options.keys ?? { code: 200, data: [] });
    }
    if (url.includes("/api_keys/copy/")) {
      return reply(options.copied ?? { code: 200, data: { secretKey: "secret-1" } });
    }
    return reply({}, 404);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const AUTHORIZE = {
  state: "state-1",
  codeChallenge: "challenge-1",
  redirectUri: ZCODE_REDIRECT_URI,
};

describe("Z.AI Coding Plan — authorize URL", () => {
  test("uses the zcode:// scheme Z.AI allowlists and sends no PKCE challenge", () => {
    const url = new URL(new ZcodeOAuthClient().buildAuthorizeUrl(AUTHORIZE));
    expect(url.origin + url.pathname).toBe(ZCODE_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe(ZCODE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(ZCODE_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    // Not a registered PKCE client: sending a challenge would be a request
    // shape Z.AI does not expect.
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });

  test("states the native redirect URI it exchanges against", () => {
    expect(new ZcodeOAuthClient().browserRedirectUri).toBe(ZCODE_REDIRECT_URI);
  });
});

describe("Z.AI Coding Plan — two-stage exchange", () => {
  test("forwards the authorize state into the token body", async () => {
    const { fetcher, calls } = zaiServer({});
    await new ZcodeOAuthClient(fetcher).exchangeCode(
      "code-1",
      "",
      ZCODE_REDIRECT_URI,
      "state-1",
    );
    const first = calls[0]?.body ?? {};
    expect(first["state"]).toBe("state-1");
  });

  test("stores the minted durable key, never the OAuth access token", async () => {
    const { fetcher } = zaiServer({});
    const result = await new ZcodeOAuthClient(fetcher).exchangeCode("code-1", "", ZCODE_REDIRECT_URI);
    expect(result.access).toBe("key-created.secret-1");
    expect(result.access).not.toContain("oauth-token");
  });

  test("walks the documented chain in order with the right auth at each hop", async () => {
    const { fetcher, calls } = zaiServer({});
    await new ZcodeOAuthClient(fetcher).exchangeCode("code-1", "", ZCODE_REDIRECT_URI);
    const urls = calls.map((call) => call.url);
    expect(urls[0]).toBe(ZCODE_TOKEN_URL);
    expect(urls[1]).toContain("/api/auth/z/login");
    expect(urls[2]).toContain("getCustomerInfo");
    expect(urls[3]).toContain("/api_keys"); // list
    expect(urls[4]).toContain("/api_keys"); // create, since the list was empty
    expect(calls[4]?.method).toBe("POST");
    expect(urls[5]).toContain("/api_keys/copy/key-created");
    // The OAuth token authorizes only the business login; every business call
    // carries the token that login returned.
    expect(calls[1]?.authorization).toBeUndefined();
    expect(calls[2]?.authorization).toBe("Bearer biz-token");
    expect(calls[5]?.authorization).toBe("Bearer biz-token");
  });

  test("reuses an existing key instead of creating a second one", async () => {
    const { fetcher, calls } = zaiServer({
      keys: { code: 200, data: [{ name: "cartethyia", apiKey: "key-existing" }] },
      copied: { code: 200, data: { secretKey: "secret-existing" } },
    });
    const result = await new ZcodeOAuthClient(fetcher).exchangeCode("c", "", ZCODE_REDIRECT_URI);
    expect(result.access).toBe("key-existing.secret-existing");
    // No POST to the keys collection: the listed key was reused.
    expect(calls.filter((call) => call.url.endsWith("/api_keys") && call.method === "POST")).toHaveLength(0);
  });

  test("reads the secret from the copy endpoint, not the masked list row", async () => {
    const { fetcher } = zaiServer({
      keys: { code: 200, data: [{ name: "cartethyia", apiKey: "key-1", secretKey: "*****abcd" }] },
      copied: { code: 200, data: { secretKey: "real-secret" } },
    });
    const result = await new ZcodeOAuthClient(fetcher).exchangeCode("c", "", ZCODE_REDIRECT_URI);
    expect(result.access).toBe("key-1.real-secret");
    expect(result.access).not.toContain("*****");
  });

  test("carries the account email as the label when the exchange reports one", async () => {
    const { fetcher } = zaiServer({
      token: { data: { zai: { access_token: "oauth-token" }, user: { email: "user@example.test" } } },
    });
    const result = await new ZcodeOAuthClient(fetcher).exchangeCode("c", "", ZCODE_REDIRECT_URI);
    expect(result.accountLabel).toBe("user@example.test");
  });

  test("fails closed when any stage is missing its required value", async () => {
    const cases: Parameters<typeof zaiServer>[0][] = [
      { token: { data: { zai: {} } } },                       // no access token
      { bizToken: { code: 200, data: {} } },                  // no business token
      { customer: { code: 200, data: { organizations: [] } } }, // no org/project
      { created: { code: 200, data: {} } },                   // no apiKey
      { copied: { code: 200, data: {} } },                    // no secretKey
      { copied: { code: 500, msg: "copy failed" } },          // envelope failure
    ];
    for (const options of cases) {
      const { fetcher } = zaiServer(options);
      await expect(
        new ZcodeOAuthClient(fetcher).exchangeCode("c", "", ZCODE_REDIRECT_URI),
      ).rejects.toThrow();
    }
  });

  test("an OAuth error status fails closed before any business call", async () => {
    const { fetcher, calls } = zaiServer({ tokenStatus: 400 });
    await expect(
      new ZcodeOAuthClient(fetcher).exchangeCode("c", "", ZCODE_REDIRECT_URI),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("registers no refresher, because the minted key does not expire", () => {
    expect(() => new ZcodeOAuthClient().refresh("key")).toThrow("does not support token refresh");
  });
});
