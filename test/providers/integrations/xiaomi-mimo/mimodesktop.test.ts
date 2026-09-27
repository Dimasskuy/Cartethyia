import { describe, expect, test } from "bun:test";
import {
  parseMimoCredential,
  MimoDesktopOAuthClient,
} from "../../../../src/providers/integrations/xiaomi-mimo/mimodesktop-oauth";
import {
  MIMODESKTOP_MODELS,
  MIMODESKTOP_SPEC,
  resolveMimoDesktopModelId,
} from "../../../../src/providers/integrations/xiaomi-mimo/mimodesktop";
import { createDefaultProviderRegistry } from "../../../../src/providers/default-registry";
import { providerDisplayName } from "../../../../dashboard/src/shared/provider-names";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchTarget } from "../../../../src/providers/provider-registry";

describe("MiMo Desktop provider integration", () => {
  test("model alias resolution maps friendly names to 2.6 flash and pro models without 2.5", () => {
    expect(resolveMimoDesktopModelId("mimo-v2.6-flash")).toBe("mimo-v2.6-flash");
    expect(resolveMimoDesktopModelId("mimo-v2.6-pro")).toBe("mimo-v2.6-pro");
    expect(resolveMimoDesktopModelId("mimo-x-flash")).toBe("mimo-v2.6-flash");
    expect(resolveMimoDesktopModelId("mimo-x-pro")).toBe("mimo-v2.6-pro");
    expect(resolveMimoDesktopModelId("MiMo-X-Flash-Preview")).toBe("mimo-v2.6-flash");
    expect(resolveMimoDesktopModelId("MiMo-X-Pro-Preview")).toBe("mimo-v2.6-pro");
    expect(resolveMimoDesktopModelId("unknown-model")).toBe("unknown-model");
  });

  test("prePayload mutates requested model alias to upstream 2.6 model", () => {
    const payload: Record<string, unknown> = { model: "mimo-x-pro", messages: [] };
    const request = { model: "mimo-x-pro" } as unknown as CanonicalRequest;
    const candidate = { model_id: "mimo-x-pro" } as unknown as ProviderDispatchTarget;
    MIMODESKTOP_SPEC.prePayload?.(payload, request, candidate);
    expect(payload["model"]).toBe("mimo-v2.6-pro");
  });

  test("advertised model catalog contains 2.6 flash and pro and excludes 2.5", () => {
    const ids = MIMODESKTOP_MODELS.map((m) => m.modelId);
    expect(ids).toContain("mimo-v2.6-flash");
    expect(ids).toContain("mimo-v2.6-pro");
    expect(ids).toContain("mimo-x-flash");
    expect(ids).toContain("mimo-x-pro");
    expect(ids).toContain("MiMo-X-Flash-Preview");
    expect(ids).toContain("MiMo-X-Pro-Preview");
    expect(ids.some((id) => id.includes("2.5"))).toBe(false);
  });

  test("parseMimoCredential parses plain passToken and JSON structures", () => {
    expect(parseMimoCredential("  my-pass-token  ")).toEqual({
      passToken: "my-pass-token",
    });

    const authJson = JSON.stringify({
      xiaomi: {
        type: "oauth",
        passToken: "pass-token-123",
        userId: "6691605628",
      },
    });
    expect(parseMimoCredential(authJson)).toEqual({
      passToken: "pass-token-123",
      userId: "6691605628",
    });

    const flatAuth = JSON.stringify({
      passToken: "pass-token-abc",
      userId: "12345",
    });
    const parsedFlat = parseMimoCredential(flatAuth);
    expect(parsedFlat.passToken).toBe("pass-token-abc");
    expect(parsedFlat.userId).toBe("12345");
  });

  test("MimoDesktopOAuthClient supports browser OAuth login targeting console callback", () => {
    const client = new MimoDesktopOAuthClient();
    expect(client.supportsBrowserCode).toBe(true);
    expect(client.supportsDeviceCode).toBe(false);

    process.env["CARTETHYIA_PUBLIC_ORIGIN"] = "http://127.0.0.1:4000";
    const authUrl = client.buildAuthorizeUrl({
      state: "flow-state-xyz",
      codeChallenge: "challenge-123",
      redirectUri: "http://127.0.0.1:4000/callback",
    });

    expect(authUrl).toContain("/console/api/providers/mimodesktop/oauth/callback");
    expect(authUrl).toContain("state=flow-state-xyz");
    expect(authUrl).toContain("code=local-desktop-import");
  });

  test("registry resolves mimodesktop login client and sets oauthFlows.browser", async () => {
    const registry = createDefaultProviderRegistry();
    const loginClient = await registry.resolveLoginClient("mimodesktop");
    expect(loginClient).toBeDefined();
    expect(loginClient?.supportsBrowserCode).toBe(true);

    const refresher = await registry.resolveRefresher("mimodesktop");
    expect(refresher).toBeDefined();

    expect(providerDisplayName("mimodesktop")).toBe("MiMo Desktop");
  });
});
