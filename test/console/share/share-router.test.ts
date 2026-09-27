import { describe, expect, test } from "bun:test";
import { createShareRouter } from "../../../src/console/share/share-router";
import {
  hashShareToken,
  type ShareApiKeyRow,
  type ShareHandoffRow,
  type ShareLinkStore,
} from "../../../src/persistence/share-store";
import type { CartethyiaDatabase } from "../../../src/persistence/postgres";
import { encryptCredential } from "../../../src/security/crypto";

function fakeStore(
  enrollFixtures: readonly { readonly token: string; readonly row: ShareApiKeyRow }[] = [],
  handoffFixtures: readonly { readonly token: string; readonly row: ShareHandoffRow }[] = [],
) {
  const enrollByHash = new Map(enrollFixtures.map((f) => [hashShareToken(f.token), f.row]));
  const handoffByHash = new Map(handoffFixtures.map((f) => [hashShareToken(f.token), f.row]));
  const activeIps = new Set<string>();
  const store: ShareLinkStore & {
    readonly touched: string[];
    readonly issued: { readonly tokenHash: string; readonly clientIp: string; readonly clientIpKey: string }[];
  } = {
    touched: [],
    issued: [],
    async create() {
      throw new Error("not used");
    },
    async resolveShareLink(tokenHash) {
      const enroll = enrollByHash.get(tokenHash);
      if (enroll) return { kind: "enroll", key: enroll };
      const handoff = handoffByHash.get(tokenHash);
      return handoff ? { kind: "handoff", key: handoff } : null;
    },
    async findTokenForApiKey() {
      return null;
    },
    async hasActiveSharedKeyForIp(clientIpKey) {
      return activeIps.has(clientIpKey);
    },
    async issueSharedApiKey(tokenHash, material) {
      const row = enrollByHash.get(tokenHash);
      if (!row) return { kind: "link_unavailable" };
      if (activeIps.has(material.clientIpKey)) return { kind: "ip_limit" };
      activeIps.add(material.clientIpKey);
      store.issued.push({
        tokenHash,
        clientIp: material.clientIp,
        clientIpKey: material.clientIpKey,
      });
      return {
        kind: "issued",
        apiKeyId: "child-1",
        parentKeyId: row.id,
        tenantId: row.tenantId,
        label: row.name,
        keyPrefix: material.keyPrefix,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      };
    },
    async touchView(tokenHash) {
      store.touched.push(tokenHash);
    },
    async listForApiKey() {
      return [];
    },
    async revoke() {
      return false;
    },
  };
  return store;
}

function shareRow(overrides: Partial<ShareApiKeyRow> = {}): ShareApiKeyRow {
  return {
    id: "key-1",
    tenantId: "tenant-1",
    name: "shared-key",
    keyPrefix: "rk_",
    active: true,
    requestsPerMinute: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    lifetimeTokenBudget: null,
    maxConcurrentRequests: null,
    modelAllowlist: null,
    modelDenylist: null,
    modelPrefix: null,
    notesTitle: null,
    notesSubtitle: null,
    notesBody: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

function handoffRow(overrides: Partial<ShareHandoffRow> = {}): ShareHandoffRow {
  return {
    id: "key-1",
    tenantId: "tenant-1",
    name: "personal-key",
    keyPrefix: "rk_",
    keyEncrypted: null,
    requestsPerMinute: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    lifetimeTokenBudget: null,
    maxConcurrentRequests: null,
    modelAllowlist: null,
    modelDenylist: null,
    modelPrefix: null,
    notesTitle: null,
    notesSubtitle: null,
    notesBody: null,
    expiresAt: null,
    ...overrides,
  };
}

const noopDb = {} as unknown as CartethyiaDatabase;
const VALID_TOKEN = "a".repeat(43);

describe("public share router", () => {
  test("serves a personal key through its handoff link, decrypting the stored secret", async () => {
    const secret = "rk_live_personal_secret";
    const store = fakeStore([], [
      {
        token: VALID_TOKEN,
        row: handoffRow({
          keyEncrypted: encryptCredential(secret),
          requestsPerMinute: 30,
          dailyTokenLimit: 1000,
          maxConcurrentRequests: 2,
          modelAllowlist: ["openai/gpt-5"],
        }),
      },
    ]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => "198.51.100.1",
    });

    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/data`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    // The handoff reveals the key itself — that is its whole purpose — and the
    // plaintext comes from decrypting the stored ciphertext. It is served from
    // the same endpoint as an enrollment link, because the page cannot know
    // which kind a token is before asking.
    expect(body).toMatchObject({
      kind: "handoff",
      name: "personal-key",
      keyPrefix: "rk_",
      key: secret,
      requestsPerMinute: 30,
      maxConcurrentRequests: 2,
      dailyLimit: 1000,
    });
    // Issuing is an enrollment capability; a handoff link has none.
    expect(body).not.toHaveProperty("canIssue");
    expect(body).not.toHaveProperty("alreadyIssued");
    expect(store.touched).toEqual([hashShareToken(VALID_TOKEN)]);
  });

  test("a handoff link whose ciphertext cannot be read serves no key", async () => {
    const store = fakeStore([], [{ token: VALID_TOKEN, row: handoffRow({ keyEncrypted: null }) }]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => "198.51.100.1",
    });
    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/data`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "handoff", key: null });
  });

  test("refuses to issue a child key from a handoff link", async () => {
    const store = fakeStore([], [
      { token: VALID_TOKEN, row: handoffRow({ keyEncrypted: encryptCredential("rk_personal") }) },
    ]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => "198.51.100.9",
    });
    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, { method: "POST" }),
    );
    expect(response.status).toBe(404);
    expect(store.issued).toEqual([]);
  });

  test("a dead handoff link resolves to 404 without touching the key", async () => {
    const store = fakeStore();
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => "198.51.100.1",
    });
    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/data`),
    );
    expect(response.status).toBe(404);
    expect(store.touched).toEqual([]);
  });

  test("serves enrollment metadata without disclosing any bearer key", async () => {
    const store = fakeStore([
      {
        token: VALID_TOKEN,
        row: shareRow({
          modelAllowlist: ["anthropic/", "openai/gpt-5", "openai/gpt-4"],
          modelDenylist: ["openai/gpt-5"],
          modelPrefix: "openai/",
          notesTitle: "Bansos Token",
        }),
      },
    ]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => "198.51.100.1",
    });

    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/data`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: "enroll",
      name: "shared-key",
      keyPrefix: "rk_",
      canIssue: true,
      alreadyIssued: false,
      modelAllowlist: ["openai/gpt-4"],
      modelPrefix: "openai/",
      notes: { title: "Bansos Token", subtitle: null, body: null },
    });
    expect(body).not.toHaveProperty("key");
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("clientIp");
    expect(store.touched).toEqual([hashShareToken(VALID_TOKEN)]);
  });

  test("issues the child bearer once and binds it to the resolved client IP", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => "198.51.100.9",
    });

    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, { method: "POST" }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      keyId: "child-1",
      keyPrefix: "rk_",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    expect(typeof body["key"]).toBe("string");
    expect(store.issued).toEqual([
      {
        tokenHash: hashShareToken(VALID_TOKEN),
        clientIp: "198.51.100.9",
        clientIpKey: "v4:3325256713",
      },
    ]);
  });

  test("rejects a second child key for an already active client IP", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => "198.51.100.9",
    });
    const request = () =>
      router.handle(new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, { method: "POST" }));

    expect((await request()).status).toBe(201);
    const second = await request();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { code: "shared_key_ip_limit" },
    });
  });

  test("fails closed when a trusted client IP is missing or invalid", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const missing = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => null,
    });
    const missingResponse = await missing.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, { method: "POST" }),
    );
    expect(missingResponse.status).toBe(503);

    const invalid = createShareRouter({
      db: noopDb,
      shareStore: store,
      resolveClientIp: () => "not-an-ip",
    });
    const invalidResponse = await invalid.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, { method: "POST" }),
    );
    expect(invalidResponse.status).toBe(400);
  });

  test("rejects unknown and short tokens with a JSON 404", async () => {
    const router = createShareRouter({
      db: noopDb,
      shareStore: fakeStore([]),
      resolveClientIp: () => "198.51.100.1",
    });
    for (const token of ["short", "b".repeat(43)]) {
      const response = await router.handle(
        new Request(`http://internal.test/share/${token}/data`),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).not.toContain("<html");
    }
  });
});
