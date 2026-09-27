import { afterEach, describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  AntigravityOAuthClient,
} from "../../../../src/providers/integrations/antigravity/antigravity-oauth";

const ORIGINAL_PUBLIC_ORIGIN = process.env.CARTETHYIA_PUBLIC_ORIGIN;

afterEach(() => {
  if (ORIGINAL_PUBLIC_ORIGIN === undefined) {
    delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
  } else {
    process.env.CARTETHYIA_PUBLIC_ORIGIN = ORIGINAL_PUBLIC_ORIGIN;
  }
});

describe("Antigravity OAuth client", () => {
  test("uses the reference Google OAuth client identity", () => {
    process.env.CARTETHYIA_PUBLIC_ORIGIN = "http://localhost:12800";
    const client = new AntigravityOAuthClient();
    const authorizeUrl = new URL(
      client.buildAuthorizeUrl({ state: "state", codeChallenge: "challenge", redirectUri: "http://127.0.0.1:59653/callback" }),
    );

    expect(ANTIGRAVITY_CLIENT_ID).toBe(
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:59653/callback",
    );
    expect(authorizeUrl.searchParams.get("scope")).toBe(ANTIGRAVITY_SCOPES);
  });

  test("advertises the loopback callback Google has registered", () => {
    // Google checks `redirect_uri` against the OAuth client's allowlist at both
    // authorize and token time. The gateway's own console callback is not on
    // that list, and sending it answered `redirect_uri_mismatch` (400).
    expect(new AntigravityOAuthClient().browserRedirectUri).toBe(
      "http://127.0.0.1:51121/oauth-callback",
    );
    expect(ANTIGRAVITY_REDIRECT_URI).toBe("http://127.0.0.1:51121/oauth-callback");
  });

  test("sends the caller's redirect URI on the token exchange, not the console URL", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      calls.push(Object.fromEntries(body.entries()));
      return new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    await new AntigravityOAuthClient(fetcher).exchangeCode(
      "code",
      "verifier",
      ANTIGRAVITY_REDIRECT_URI,
    );
    expect(calls[0]!.redirect_uri).toBe(ANTIGRAVITY_REDIRECT_URI);
    expect(calls[0]!.redirect_uri).not.toContain("/console/api/providers/");
  });
});
