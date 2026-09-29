/**
 * Kiro machine identity.
 *
 * The upstream binds a credential to the device it is first seen from. Two
 * shapes read as account sharing rather than as one machine running one client:
 * a constant device id, which makes every account in every deployment claim to
 * be the same machine, and a per-request random one, which makes a single
 * account move between devices on every call. These pin both, plus the reason
 * the id is frozen rather than derived at dispatch time.
 */
import { describe, expect, test } from "bun:test";
import {
  deriveApiKeyMachineId,
  deriveOAuthMachineId,
  fallbackMachineId,
  normalizeMachineId,
  resolveMachineId,
} from "../../../../src/providers/integrations/kiro/kiro-machine-id";

const REFRESH = "rt-aaa";
const API_KEY = "ksk_AAA";
const ACCOUNT = "account-1";

describe("machine id derivation", () => {
  test("derives a 64-character lowercase hex id", () => {
    for (const value of [deriveOAuthMachineId(REFRESH), deriveApiKeyMachineId(API_KEY), fallbackMachineId(ACCOUNT)]) {
      expect(value).toHaveLength(64);
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("derives a different id for each credential", () => {
    expect(deriveOAuthMachineId("rt-aaa")).not.toBe(deriveOAuthMachineId("rt-bbb"));
    expect(deriveApiKeyMachineId("ksk_AAA")).not.toBe(deriveApiKeyMachineId("ksk_BBB"));
    expect(fallbackMachineId("account-1")).not.toBe(fallbackMachineId("account-2"));
  });

  test("never derives the same id from a refresh token and an API key", () => {
    // The two families are salted differently on purpose: one account's ksk and
    // its refresh token must not describe the same device.
    expect(deriveApiKeyMachineId(API_KEY)).not.toBe(deriveOAuthMachineId(API_KEY));
  });

  test("is stable across calls, so a restart does not move the account", () => {
    expect(fallbackMachineId(ACCOUNT)).toBe(fallbackMachineId(ACCOUNT));
    expect(deriveOAuthMachineId(REFRESH)).toBe(deriveOAuthMachineId(REFRESH));
  });

  test("never collapses every credential onto one constant", () => {
    // A constant is worse than sending nothing: every account in every
    // deployment would then present the same device.
    const ids = new Set([
      deriveOAuthMachineId(""),
      deriveOAuthMachineId("rt-aaa"),
      deriveApiKeyMachineId("ksk_AAA"),
      fallbackMachineId(""),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe("normalizeMachineId", () => {
  test("accepts a 64-character hex id as-is, lowercased", () => {
    const upper = "A".repeat(64);
    expect(normalizeMachineId(upper)).toBe("a".repeat(64));
  });

  test("doubles a 32-character hex id, which is the other accepted shape", () => {
    const uuid32 = "0123456789abcdef0123456789abcdef";
    expect(normalizeMachineId(uuid32)).toBe(`${uuid32}${uuid32}`);
  });

  test("rejects anything else rather than sending a malformed device id", () => {
    expect(normalizeMachineId("")).toBeUndefined();
    expect(normalizeMachineId("xyz")).toBeUndefined();
    expect(normalizeMachineId("a".repeat(40))).toBeUndefined();
    expect(normalizeMachineId(`${"z".repeat(64)}`)).toBeUndefined();
    expect(normalizeMachineId(undefined)).toBeUndefined();
    expect(normalizeMachineId(42)).toBeUndefined();
  });
});

describe("resolveMachineId", () => {
  test("a frozen id wins, so a token rotation cannot move the account", () => {
    const frozen = "c".repeat(64);
    expect(
      resolveMachineId({
        frozen,
        authMethod: "builder-id",
        refreshToken: REFRESH,
        apiKey: "",
        accountId: ACCOUNT,
      }),
    ).toBe(frozen);
  });

  test("ignores a frozen value that is not a usable device id", () => {
    expect(
      resolveMachineId({
        frozen: "not-hex",
        authMethod: "builder-id",
        refreshToken: REFRESH,
        apiKey: "",
        accountId: ACCOUNT,
      }),
    ).toBe(deriveOAuthMachineId(REFRESH));
  });

  test("an API key derives from the key, never from the empty refresh token", () => {
    // A ksk credential has no refresh token, so falling through to the OAuth
    // salt would put every API-key account on one constant.
    const a = resolveMachineId({
      frozen: undefined,
      authMethod: "api_key",
      refreshToken: "",
      apiKey: "ksk_AAA",
      accountId: ACCOUNT,
    });
    const b = resolveMachineId({
      frozen: undefined,
      authMethod: "api_key",
      refreshToken: "",
      apiKey: "ksk_BBB",
      accountId: ACCOUNT,
    });
    expect(a).toBe(deriveApiKeyMachineId("ksk_AAA"));
    expect(a).not.toBe(b);
  });

  test("an OAuth credential derives from the refresh token", () => {
    expect(
      resolveMachineId({
        frozen: undefined,
        authMethod: "builder-id",
        refreshToken: REFRESH,
        apiKey: "",
        accountId: ACCOUNT,
      }),
    ).toBe(deriveOAuthMachineId(REFRESH));
  });

  test("falls back to the account id when there is no derivable material", () => {
    expect(
      resolveMachineId({
        frozen: undefined,
        authMethod: "builder-id",
        refreshToken: "",
        apiKey: "",
        accountId: ACCOUNT,
      }),
    ).toBe(fallbackMachineId(ACCOUNT));
  });
});
