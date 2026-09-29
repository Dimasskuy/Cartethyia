import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { detectFormat } from "../../../src/console/backup/validate";
import { convert9RouterBackup } from "../../../src/console/backup/nine-router";
import { decryptCredentialToString, hashSecret } from "../../../src/security/crypto";

/**
 * Router-export importer — smoke + refusals only. Full round-trip lives in
 * `backup-roundtrip.test.ts`; here we guard detection and the dangerous cases
 * (unknown provider ids, credential mapping).
 */
describe("router backup detection", () => {
  test("detects native vs nine-router exports", () => {
    expect(
      detectFormat({ app: "cartethyia", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", sections: {} }).kind,
    ).toBe("native");
    expect(
      detectFormat({ providerConnections: [], providerNodes: [], apiKeys: [], combos: [] }).kind,
    ).toBe("nine_router");
    expect(detectFormat({ app: "other", version: 1 }).kind).toBe("unknown");
  });
});

describe("router export conversion (smoke)", () => {
  const tenantId = randomUUID();

  function exportFixture() {
    return {
      providerConnections: [
        {
          id: "c1",
          provider: "claude",
          authType: "oauth",
          name: "Claude main",
          apiKey: "sk-ant-oat-EXAMPLE",
          isActive: true,
          createdAt: "2026-01-02T03:04:05.000Z",
        },
        {
          id: "c2",
          provider: "windsurf",
          authType: "api_key",
          name: "Skip me",
          apiKey: "",
          isActive: true,
        },
      ],
      providerNodes: [],
      apiKeys: [{ id: "k1", name: "router", key: "rk_router_key_123", isActive: true }],
      combos: [],
      modelAliases: {},
      proxyPools: [],
      customModels: [],
      pricing: {},
      mitmAlias: {},
      settings: {},
    };
  }

  test("imports a mapped account with encrypted credential", () => {
    const { payload, report } = convert9RouterBackup(exportFixture(), tenantId);
    expect(report.imported.accounts).toBe(1);
    const claude = payload.sections.config?.provider_accounts?.find((a) => a.provider_id === "claude");
    expect(claude?.tenant_id).toBe(tenantId);
    const bytes = (claude?.credential_ciphertext as { __bytes: string }).__bytes;
    expect(decryptCredentialToString(Buffer.from(bytes, "base64"))).toBe("sk-ant-oat-EXAMPLE");
  });

  test("refuses an unknown provider id instead of importing it verbatim", () => {
    const { payload, report } = convert9RouterBackup(
      {
        providerConnections: [
          { id: "c1", provider: "totally-unknown-router", name: "Mystery", apiKey: "secret" },
        ],
      },
      tenantId,
    );
    expect(report.imported.accounts).toBe(0);
    expect(report.skipped.join("\n")).toContain("totally-unknown-router");
    expect(payload.sections.config?.provider_accounts).toBeUndefined();
  });

  test("stores imported API keys as hashes only", () => {
    const { payload } = convert9RouterBackup(exportFixture(), tenantId);
    const keys = payload.sections.config?.api_keys ?? [];
    expect(keys[0]?.key_hash).toBe(hashSecret("rk_router_key_123"));
    expect(JSON.stringify(keys[0])).not.toContain("rk_router_key_123");
  });
});
