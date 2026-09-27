import { describe, expect, test } from "bun:test";
import {
  OpenrouterOAuthClient,
  OPENROUTER_AUTHORIZE_URL,
  OPENROUTER_KEY_EXCHANGE_URL,
  OPENROUTER_REDIRECT_URI,
} from "../../../src/providers/integrations/openrouter-oauth";

/**
 * OpenRouter's flow is deliberately non-standard, and every deviation is one
 * that a "make it look like the others" refactor would undo:
 *
 *  - the authorize request names its callback `callback_url`, not `redirect_uri`,
 *    and carries no `client_id`, `response_type`, or `scope`;
 *  - the exchange returns a durable API key, not an access token, so there is no
 *    refresh grant;
 *  - the server never echoes `state`, which the console callback handles.
 *
 * These tests pin the first two; the third is pinned by the flow-store suite.
 */
function jsonServer(
  body: unknown,
  options: { readonly status?: number } = {},
): { fetcher: typeof fetch; calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("OpenRouter OAuth — authorize URL", () => {
  test("sends callback_url instead of the standard redirect_uri", () => {
    const url = new URL(
      new OpenrouterOAuthClient().buildAuthorizeUrl({
        state: "ignored",
        codeChallenge: "challenge-1",
        redirectUri: OPENROUTER_REDIRECT_URI,
      }),
    );
    expect(url.origin + url.pathname).toBe(OPENROUTER_AUTHORIZE_URL);
    expect(url.searchParams.get("callback_url")).toBe(OPENROUTER_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // None of the standard names this server does not expect.
    expect(url.searchParams.get("redirect_uri")).toBeNull();
    expect(url.searchParams.get("client_id")).toBeNull();
    expect(url.searchParams.get("response_type")).toBeNull();
    expect(url.searchParams.get("scope")).toBeNull();
  });

  test("states the loopback redirect URI it exchanges against", () => {
    expect(new OpenrouterOAuthClient().browserRedirectUri).toBe(OPENROUTER_REDIRECT_URI);
  });
});

describe("OpenRouter OAuth — key exchange", () => {
  test("stores the returned key as the credential", async () => {
    const { fetcher, calls } = jsonServer({ key: "sk-or-v1-abc" });
    const result = await new OpenrouterOAuthClient(fetcher).exchangeCode(
      "code-1",
      "verifier-1",
      OPENROUTER_REDIRECT_URI,
    );
    expect(result.access).toBe("sk-or-v1-abc");
    expect(calls[0]?.url).toBe(OPENROUTER_KEY_EXCHANGE_URL);
    expect(calls[0]?.body).toMatchObject({
      code: "code-1",
      code_verifier: "verifier-1",
      code_challenge_method: "S256",
    });
  });

  test("a response with no key fails closed rather than storing an empty credential", async () => {
    for (const body of [{}, { key: "" }, { key: "   " }, { key: 42 }]) {
      const { fetcher } = jsonServer(body);
      await expect(
        new OpenrouterOAuthClient(fetcher).exchangeCode("c", "v", OPENROUTER_REDIRECT_URI),
      ).rejects.toThrow();
    }
  });

  test("an error status fails closed", async () => {
    const { fetcher } = jsonServer({ error: "invalid code" }, { status: 401 });
    await expect(
      new OpenrouterOAuthClient(fetcher).exchangeCode("c", "v", OPENROUTER_REDIRECT_URI),
    ).rejects.toThrow();
  });

  test("registers no refresher, because the key does not expire", () => {
    // The base class throws for an unsupported grant; that is what makes
    // `resolveRefresher` undefined and keeps the 401 retry from calling it.
    // Thrown synchronously, so the assertion is a plain call.
    const client = new OpenrouterOAuthClient();
    expect(() => client.refresh("key")).toThrow("does not support token refresh");
  });
});
