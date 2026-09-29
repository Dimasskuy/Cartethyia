import { describe, expect, it } from "bun:test";
import { createProviderCatalogRoutes } from "../../../src/console/providers/catalog/routes";
import type { ModelCatalogEntry, ProviderCatalogStore } from "../../../src/console/providers/catalog/contracts";
import type { AccessDecision } from "../../../src/security/access-control";
import type { ProviderRegistry } from "../../../src/providers/provider-registry";

const testRegistry = {
  async resolveLoginClient() { return undefined; },
  async resolveModelDiscovery() { return undefined; },
  hasQuotaCollector() { return false; },
} as unknown as ProviderRegistry;

function makeModelStore(): { store: ProviderCatalogStore } {
  const store = {
    async list() { return []; },
    async get() { return undefined; },
    async create() {},
    async update() { return undefined; },
    async delete() { return false; },
    async updateGlobal() { return undefined; },
    async deleteGlobal() { return false; },
    async listModels(): Promise<readonly ModelCatalogEntry[]> { return []; },
    async listModelsForTenant() { return new Map(); },
    async registerModels() {},
    async syncModels() { return { synced: 0 }; },
    async listAccounts() { return []; },
    async listAllAccounts() { return []; },
    async createAccount() { throw new Error("ni"); },
    async updateAccount() { throw new Error("ni"); },
    async listAccountHealthEvents() { return []; },
    async recoverAccount() { return true; },
    async probeModel() { return { ok: true, latencyMs: 1 }; },
    async testByokConnection() { return { ok: true, latencyMs: 1 }; },
    async probeAllModels(_t: string, providerId: string) { return { providerId, results: [] }; },
    async probeAllAccounts(_t: string, providerId: string) { return { providerId, modelId: "grok-4.6", results: [] }; },
    async setModelEnabled() { return true; },
    async deleteModel() { return true; },
  } satisfies ProviderCatalogStore;
  return { store };
}

describe("POST /providers/connection-test", () => {
  const access: AccessDecision = {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:read", "providers:read", "models:read"],
    admissionIdentity: "key-1",
  };

  function makeTestStore(calls: Array<Record<string, unknown>>): ProviderCatalogStore {
    const base = makeModelStore().store;
    return {
      ...base,
      async testByokConnection(tenantId, request) {
        calls.push({ tenantId, ...request });
        return { ok: true, latencyMs: 12, statusCode: 200, modelCount: 3 };
      },
    };
  }

  function request(body: unknown) {
    return new Request("http://localhost/providers/connection-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("routes to the store with the tenant and entered fields", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createProviderCatalogRoutes({
      store: makeTestStore(calls),
      accessResolver: () => access,
      providerRegistry: testRegistry,
    });
    const response = await app.handle(
      request({
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        wireFamily: "messages",
        cliIdentity: false,
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        tenantId: "tenant-1",
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        wireFamily: "messages",
        cliIdentity: false,
      },
    ]);
    expect(await response.json()).toMatchObject({ ok: true, modelCount: 3 });
  });

  it("is not shadowed by the /:providerId detail route", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createProviderCatalogRoutes({
      store: makeTestStore(calls),
      accessResolver: () => access,
      providerRegistry: testRegistry,
    });
    const response = await app.handle(
      request({ baseUrl: "https://api.example.com", apiKey: "", wireFamily: "chat" }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("rejects a body without a base URL via the schema", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createProviderCatalogRoutes({
      store: makeTestStore(calls),
      accessResolver: () => access,
      providerRegistry: testRegistry,
    });
    const response = await app.handle(request({ apiKey: "sk-test", wireFamily: "chat" }));
    expect(response.status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});
