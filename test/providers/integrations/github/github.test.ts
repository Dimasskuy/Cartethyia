import { describe, expect, test } from "bun:test";
import {
  apiHostFromGithubToken,
  GITHUB_DEFAULT_API_HOST,
  GITHUB_CLIENT_ID,
  GITHUB_REQUEST_HEADERS,
  encodeGithubCredential,
  GithubOAuthClient,
  parseGithubCredential,
} from "../../../../src/providers/integrations/github/github-oauth";
import { createGithubAdapter } from "../../../../src/providers/integrations/github/github";
import {
  candidateFor,
  canonicalRequest,
  dispatchContext,
  dispatchJson,
} from "../../../helpers/provider-dispatch";

/**
 * Copilot is two tokens deep and its API host is per-account. Both facts are
 * invisible until dispatch — the host is read out of the Copilot token's
 * `proxy-ep` claim, so a credential that stored the token without the host
 * would post to the wrong host, and a credential that stored the *GitHub* token
 * instead of the minted Copilot token would be rejected by the inference API.
 * These tests pin each step against the shape the upstream actually returns.
 */

/** A Copilot token is a `key=value;` list; only `proxy-ep` names the host. */
const COPILOT_TOKEN =
  "tid=abc;exp=1790000000;proxy-ep=proxy.enterprise.githubcopilot.com;iat=1789990000";

function jsonServer(routes: Record<string, unknown>, calls: { url: string }[] = []) {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "not_found", url }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("GitHub Copilot — token parsing", () => {
  test("derives the API host from the token's proxy-ep claim", () => {
    expect(apiHostFromGithubToken(COPILOT_TOKEN)).toBe("api.enterprise.githubcopilot.com");
  });

  test("falls back to the Individual host when the claim is absent", () => {
    for (const token of ["", "tid=abc;exp=1", "no-equals-sign"]) {
      expect(apiHostFromGithubToken(token)).toBe(GITHUB_DEFAULT_API_HOST);
    }
  });

  test("round-trips the credential envelope", () => {
    const encoded = encodeGithubCredential("copilot-token", "api.enterprise.githubcopilot.com");
    expect(parseGithubCredential(encoded)).toEqual({
      access: "copilot-token",
      apiHost: "api.enterprise.githubcopilot.com",
    });
  });

  test("fails closed on a value that is not this provider's envelope", () => {
    for (const malformed of ["", "raw-token", '{"access":""}', '{"nope":1}', "[]"]) {
      expect(() => parseGithubCredential(malformed)).toThrow();
    }
  });
});

describe("GitHub Copilot — device flow", () => {
  test("publishes the GitHub verification URI and the device code", async () => {
    const { fetcher } = jsonServer({
      "/login/device/code": {
        device_code: "dev-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      },
    });
    const started = await new GithubOAuthClient(fetcher).startDeviceAuth();
    expect(started.userCode).toBe("ABCD-1234");
    expect(started.verificationUri).toBe("https://github.com/login/device");
    expect(started.deviceAuthId).toBe("dev-1");
  });

  test("rejects a verification URI that is not http(s)", async () => {
    const { fetcher } = jsonServer({
      "/login/device/code": {
        device_code: "dev-1",
        user_code: "ABCD",
        verification_uri: "javascript:alert(1)",
        expires_in: 900,
      },
    });
    // The URI is handed to an operator to open, so a non-web scheme must never
    // reach the dialog.
    await expect(new GithubOAuthClient(fetcher).startDeviceAuth()).rejects.toThrow(
      "untrusted verification URI",
    );
  });

  test("a pending poll stays pending rather than failing", async () => {
    const { fetcher } = jsonServer({
      "/login/oauth/access_token": { error: "authorization_pending" },
    });
    const result = await new GithubOAuthClient(fetcher).pollDeviceAuth("dev-1", {
      providerId: "github",
      tenantId: null,
      accountLabel: "x",
      providerState: "github.com",
    });
    expect(result.status).toBe("pending");
  });

  test("an expired device code fails with a reason", async () => {
    const { fetcher } = jsonServer({
      "/login/oauth/access_token": { error: "expired_token" },
    });
    const result = await new GithubOAuthClient(fetcher).pollDeviceAuth("dev-1", {
      providerId: "github",
      tenantId: null,
      accountLabel: "x",
      providerState: "github.com",
    });
    expect(result).toMatchObject({ status: "failed" });
  });

  test("an unrecognized error fails instead of polling forever", async () => {
    // Returning "pending" for an unknown verdict made a permanent upstream
    // rejection look like a login that simply never finished: the dialog spun
    // until its own expiry and the operator saw no reason.
    const { fetcher } = jsonServer({
      "/login/oauth/access_token": { error: "incorrect_device_code" },
    });
    const result = await new GithubOAuthClient(fetcher).pollDeviceAuth("dev-1", {
      providerId: "github",
      tenantId: null,
      accountLabel: "x",
      providerState: "github.com",
    });
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("incorrect_device_code");
  });

  test("a non-2xx poll response fails rather than reporting pending", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await new GithubOAuthClient(fetcher).pollDeviceAuth("dev-1", {
      providerId: "github",
      tenantId: null,
      accountLabel: "x",
      providerState: "github.com",
    });
    expect(result.status).toBe("failed");
  });

  test("stores the minted Copilot token, not the GitHub token", async () => {
    const { fetcher } = jsonServer({
      "/login/oauth/access_token": { access_token: "github-token" },
      "/copilot_internal/v2/token": { token: COPILOT_TOKEN, expires_at: 1790000000 },
      "/user": { login: "octocat" },
    });
    const result = await new GithubOAuthClient(fetcher).pollDeviceAuth("dev-1", {
      providerId: "github",
      tenantId: null,
      accountLabel: "x",
      providerState: "github.com",
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    const stored = parseGithubCredential(result.result.access);
    expect(stored.access).toBe(COPILOT_TOKEN);
    expect(stored.apiHost).toBe("api.enterprise.githubcopilot.com");
    // The GitHub token is the refresh value: it re-mints the Copilot token.
    expect(result.result.refresh).toBe("github-token");
    expect(result.result.accountLabel).toBe("octocat");
  });

  test("refresh re-mints the Copilot token and keeps the GitHub token", async () => {
    const { fetcher } = jsonServer({
      "/copilot_internal/v2/token": { token: COPILOT_TOKEN, expires_at: 1790000000 },
    });
    const refreshed = await new GithubOAuthClient(fetcher).refresh("github-token");
    expect(parseGithubCredential(refreshed.access).access).toBe(COPILOT_TOKEN);
    expect(refreshed.refresh).toBe("github-token");
  });
});

/**
 * The dispatch path is where the per-account host and the Copilot client
 * identity have to appear. A shared OpenAI-compatible spec cannot carry either:
 * its base URL is fixed at registration and the route-level User-Agent is for
 * generic hosts.
 */
describe("GitHub Copilot — dispatch", () => {
  test("posts to the host named by the credential, not the registered base", async () => {
    const captured = await dispatchJson({
      create: createGithubAdapter,
      candidate: candidateFor("github", "chat", "/chat/completions"),
      context: dispatchContext("github", {
        credential_kind: "oauth",
        secret: new TextEncoder().encode(
          encodeGithubCredential(COPILOT_TOKEN, "api.enterprise.githubcopilot.com"),
        ),
      }),
    });
    expect(captured.url).toBe("https://api.enterprise.githubcopilot.com/chat/completions");
  });

  test("sends the Copilot client identity the API requires", async () => {
    const captured = await dispatchJson({
      create: createGithubAdapter,
      candidate: candidateFor("github", "chat", "/chat/completions"),
      context: dispatchContext("github", {
        credential_kind: "oauth",
        secret: new TextEncoder().encode(encodeGithubCredential(COPILOT_TOKEN, "api.individual.githubcopilot.com")),
      }),
    });
    expect(captured.headers["copilot-integration-id"]).toBe("vscode-chat");
    expect(captured.headers["editor-version"]).toBe("vscode/1.107.0");
    expect(captured.headers["x-github-api-version"]).toBe(GITHUB_REQUEST_HEADERS["x-github-api-version"]!);
    // The Copilot identity must win over a route-level User-Agent, which a
    // generic OpenAI-compatible host would accept but this API would reject.
    expect(captured.headers["user-agent"]).toBe("GitHubCopilotChat/0.35.0");
  });

  test("bearer comes from the envelope's access field", async () => {
    const captured = await dispatchJson({
      create: createGithubAdapter,
      candidate: candidateFor("github", "chat", "/chat/completions"),
      context: dispatchContext("github", {
        credential_kind: "oauth",
        secret: new TextEncoder().encode(encodeGithubCredential(COPILOT_TOKEN, "api.individual.githubcopilot.com")),
      }),
    });
    expect(captured.headers.authorization).toBe(`Bearer ${COPILOT_TOKEN}`);
    expect(captured.headers.authorization).not.toContain("apiHost");
  });

  test("falls back to the registered host when the credential is unreadable", async () => {
    const captured = await dispatchJson({
      create: createGithubAdapter,
      candidate: candidateFor("github", "chat", "/chat/completions"),
      context: dispatchContext("github", {
        credential_kind: "api_key",
        secret: new TextEncoder().encode("not-an-envelope"),
      }),
    });
    // No host can be derived, so the registered fallback is used and the
    // request fails closed upstream on the token it cannot parse.
    expect(captured.url).toBe("https://api.individual.githubcopilot.com/chat/completions");
  });

  test("carries the model id through to the payload", async () => {
    const captured = await dispatchJson({
      create: createGithubAdapter,
      candidate: candidateFor("github", "chat", "/chat/completions", "claude-sonnet-4.6"),
      request: canonicalRequest({ model: "claude-sonnet-4.6" }),
      context: dispatchContext("github", {
        credential_kind: "oauth",
        secret: new TextEncoder().encode(encodeGithubCredential(COPILOT_TOKEN, "api.individual.githubcopilot.com")),
      }),
    });
    expect(captured.body.model).toBe("claude-sonnet-4.6");
  });
});

describe("GitHub Copilot — client id", () => {
  test("is the public Copilot OAuth app id, not a secret", () => {
    expect(GITHUB_CLIENT_ID).toBe("Iv1.b507a08c87ecfe98");
  });
});
