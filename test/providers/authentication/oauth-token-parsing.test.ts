import { describe, expect, test } from "bun:test";
import { OAuthDeviceFlow } from "../../../src/providers/authentication/oauth-device-flow";
import type { OAuthDeviceStartResult, OAuthDevicePollResult } from "../../../src/providers/authentication/oauth-flow-store";

/**
 * `parseTokenResponse` is the shared token-body reader. It used to answer
 * `access: ""` for a body with no token, which let a poll report `complete`
 * with an unusable credential — the account was persisted and the browser saw
 * success while dispatch sent an empty bearer. It now fails, which is the
 * correct verdict for a 2xx that carries an `error` field and no token.
 *
 * A concrete subclass is used so the protected parser can be exercised through
 * the real device-flow path rather than by widening its visibility.
 */
class TestDeviceFlow extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;
  protected override readonly providerLabel = "Test";
  protected override readonly clientId = "cid";
  protected override readonly tokenUrl = "https://example.test/token";
  protected override readonly scopes = "";

  override async startDeviceAuth(): Promise<OAuthDeviceStartResult> {
    return {
      verificationUri: "https://example.test/device",
      userCode: "CODE",
      deviceAuthId: "dev",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    };
  }

  override async pollDeviceAuth(): Promise<OAuthDevicePollResult> {
    return this.pollGenericDeviceAuth("dev", {
      tokenUrl: this.tokenUrl,
      deviceAuthUrl: "https://example.test/device/code",
      clientId: this.clientId,
    });
  }

  /**
   * Exercises the parser directly.
   *
   * The generic device-flow poll already refuses a body with no `access_token`
   * before reaching the parser, so it cannot show whether the parser itself
   * fails — and providers that read a token body outside that helper (the
   * direct `parseTokenResponse` callers) rely on the parser's own guard.
   */
  parseDirectly(body: unknown, fallbackRefresh?: string): unknown {
    return this.parseTokenResponse(body, fallbackRefresh);
  }
}

function flowReplying(body: unknown, status = 200): TestDeviceFlow {
  const fetcher = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return new TestDeviceFlow(fetcher);
}

describe("shared token-response parsing", () => {
  test("completes with the token the body carries", async () => {
    const result = await flowReplying({ access_token: "at", refresh_token: "rt", expires_in: 60 }).pollDeviceAuth();
    expect(result).toMatchObject({ status: "complete", result: { access: "at", refresh: "rt" } });
  });

  test("fails on a 200 that carries no access_token", async () => {
    const result = await flowReplying({ error: "invalid_grant" }).pollDeviceAuth();
    expect(result.status).toBe("failed");
  });

  test("accepts an access-only credential", async () => {
    // Several providers legitimately issue no refresh token; only the access
    // value is required.
    const result = await flowReplying({ access_token: "at", expires_in: 60 }).pollDeviceAuth();
    expect(result).toMatchObject({ status: "complete", result: { access: "at" } });
  });

  test("the parser itself refuses a body with no access_token", () => {
    const flow = new TestDeviceFlow();
    expect(() => flow.parseDirectly({ error: "invalid_grant" })).toThrow("omitted access_token");
  });

  test("the parser surfaces the provider's own error text", () => {
    const flow = new TestDeviceFlow();
    expect(() => flow.parseDirectly({ error_description: "code expired" })).toThrow("code expired");
  });
});
