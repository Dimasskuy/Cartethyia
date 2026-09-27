import { describe, expect, test } from "bun:test";
import { extractOAuthCode } from "../../src/routes/provider-detail/OAuthDialogs";

/**
 * The dialog accepts whatever the operator pastes: a full redirect URL, a bare
 * query string, or the raw code. The failure this pins is that a pasted URL
 * carrying no `code` used to be handed to the token endpoint *as* the code, so
 * Devin answered `Invalid or expired code` — an error that names the code while
 * really reporting a failed parse, which sent the operator back to retry the
 * same broken paste.
 */
describe("OAuth callback parsing", () => {
  test("reads the code out of a full redirect URL", () => {
    expect(extractOAuthCode("http://127.0.0.1:59653/callback?code=abc123&state=s1")).toEqual({
      code: "abc123",
    });
  });

  test("reads the code out of a bare query string", () => {
    expect(extractOAuthCode("?code=abc123&state=s1")).toEqual({ code: "abc123" });
  });

  test("treats a bare value as the code itself", () => {
    expect(extractOAuthCode("  abc123  ")).toEqual({ code: "abc123" });
  });

  test("refuses a redirect URL that carries no code instead of sending the URL", () => {
    const parsed = extractOAuthCode("http://127.0.0.1:59653/callback?state=s1");
    expect("error" in parsed).toBe(true);
  });

  test("reports the provider's own refusal", () => {
    const parsed = extractOAuthCode(
      "http://127.0.0.1:59653/callback?error=access_denied&error_description=User+denied",
    );
    expect("error" in parsed && parsed.error).toContain("User denied");
  });
});
