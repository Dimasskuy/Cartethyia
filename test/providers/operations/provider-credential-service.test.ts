import { describe, expect, test } from "bun:test";

import type { CartethyiaDatabase } from "../../../src/persistence/postgres";
import { resolveAccountCredentialsForExport } from "../../../src/providers/operations/provider-credential-service";
import { encryptCredential } from "../../../src/security/crypto";

describe("resolveAccountCredentialsForExport", () => {
  test("decrypts access and refresh tokens into the export fields", async () => {
    const row = {
      id: "account-1",
      providerId: "codex",
      credentialKind: "oauth" as const,
      credentialCiphertext: encryptCredential("access-token"),
      refreshCiphertext: encryptCredential("refresh-token"),
      authState: null,
      clientSecretCiphertext: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const query = {
      from: () => query,
      leftJoin: () => query,
      where: () => query,
      limit: async () => [row],
    };
    const db = { select: () => query } as unknown as CartethyiaDatabase;

    const credentials = await resolveAccountCredentialsForExport(db, "codex", "account-1");
    expect(credentials).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
  });
});
