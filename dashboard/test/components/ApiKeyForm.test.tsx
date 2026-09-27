import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiKeyForm, keyCredentialFields, oneTimeSecretForMode } from "../../src/components/ApiKeyForm";
import { CLIENT_ROUTERS, TENANT_KEY_SCOPES, type ApiKeyResponse } from "../../src/data/contracts";

const shareRecord: ApiKeyResponse = {
  id: "parent-id", label: "Team share", keyMode: "share", scopes: [], createdAt: "2026-09-01T00:00:00.000Z", tokensConsumed: 0,
};
function render(mode: "create" | "edit", record: ApiKeyResponse | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ApiKeyForm, {
        mode,
        record,
        busy: false,
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    ),
  );
}
describe("API key mode form", () => {
  test("personal creation retains custom-key input and one-time secret affordance", () => {
    const markup = render("create", null);
    expect(markup).toContain("Personal");
    expect(markup).toContain("Share template");
    expect(markup).toContain("Custom API key value (optional)");
  });

  test("share template create/edit never renders a raw-key input", () => {
    const createMarkup = render("create", shareRecord);
    const editMarkup = render("edit", shareRecord);
    expect(createMarkup).toContain("does not authenticate requests");
    expect(editMarkup).toContain("does not authenticate requests");
    expect(createMarkup).not.toContain("Custom API key value");
    expect(editMarkup).not.toContain("Custom API key value");
  });

  test("locks the credential mode when editing but not when creating", () => {
    const createMarkup = render("create", null);
    const editMarkup = render("edit", shareRecord);
    // Both mode buttons are disabled on an existing credential: the mode is
    // fixed once the key exists, so the edit form cannot convert it.
    const disabledButtons = (markup: string): number =>
      (markup.match(/disabled=""[^>]*>Personal<\/button>/) ? 1 : 0) +
      (markup.match(/disabled=""[^>]*>Share template<\/button>/) ? 1 : 0);
    expect(disabledButtons(createMarkup)).toBe(0);
    expect(disabledButtons(editMarkup)).toBe(2);
  });
  test("share submission omits a raw bearer value while personal submission can carry one", () => {
    const shareBody = JSON.stringify(keyCredentialFields("share", "never-send-this", "rk_"));
    const personalBody = JSON.stringify(keyCredentialFields("personal", "rk_personal-once", "rk_"));
    expect(shareBody).not.toContain("never-send-this");
    expect(shareBody).toContain('"keyMode":"share"');
    expect(personalBody).toContain('"key":"rk_personal-once"');
  });
  test("only personal creation or conversion exposes an optional one-time secret", () => {
    expect(oneTimeSecretForMode("personal", "rk_once")).toBe("rk_once");
    expect(oneTimeSecretForMode("share", "must-not-show")).toBeNull();
    expect(oneTimeSecretForMode("personal", undefined)).toBeNull();
  });
  test("normalizes a legacy OmniRoute denylist entry in the edit form", () => {
    const legacyRecord = {
      ...shareRecord,
      keyMode: "personal",
      clientRouterDenylist: ["omniroute"],
    } as unknown as ApiKeyResponse;
    const markup = render("edit", legacyRecord);
    expect(markup).toContain('aria-label="Block 9Router and OmniRoute client"');
    expect(markup).toContain('aria-checked="true"');
  });

  test("renders descriptive router and scope switches without provider allowlist", () => {
    const markup = render("create", null);
    expect(markup).toContain("Blocked client routers");
    expect(markup).toContain("Matching fingerprints are rejected with 403 before routing.");
    expect(markup).toContain("clients without a fingerprint are not matched.");
    for (const router of CLIENT_ROUTERS) {
      expect(markup).toContain(`aria-label="Block ${router.label} client"`);
      expect(markup).toContain(`Block ${router.label} Client`);
    }
    expect(markup).toContain("Routing");
    expect(markup).toContain("Dashboard / Resources");
    for (const scope of TENANT_KEY_SCOPES) {
      expect(markup).toContain(`aria-label="Grant ${scope}"`);
    }
    expect(markup).toContain("Call /v1/* gateway routes within this tenant.");
    expect(markup).not.toContain("providerAllowlist");
    expect(markup).not.toContain("Provider allowlist");
  });
});
