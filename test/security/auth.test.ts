import { describe, expect, test } from "bun:test";
import {
  createAuthorizationSnapshot,
  freezeSnapshot,
  isModelAllowed,
  requestToken,
} from "../../src/security/api-key-auth";

describe("requestToken credential sources", () => {
  test("accepts the same key in x-api-key and Authorization together", () => {
    // Anthropic-compatible clients send both so a gateway reading either one
    // works; rejecting the pair rejected the whole client. Measured against an
    // Antigravity IDE install pointed at this gateway through a DNS override,
    // which answered 400 `conflicting credential headers` for every request.
    const headers = new Headers({
      "x-api-key": "rk_shared",
      authorization: "Bearer rk_shared",
    });
    expect(requestToken(headers)).toBe("rk_shared");
  });

  test("accepts either header alone", () => {
    expect(requestToken(new Headers({ "x-api-key": "rk_a" }))).toBe("rk_a");
    expect(requestToken(new Headers({ authorization: "Bearer rk_b" }))).toBe("rk_b");
  });

  test("still rejects two different credentials", () => {
    // Tolerating the pair must not mean tolerating a mismatch: picking one
    // would silently decide which identity the request runs as.
    const headers = new Headers({
      "x-api-key": "rk_one",
      authorization: "Bearer rk_two",
    });
    expect(() => requestToken(headers)).toThrow("conflicting credential headers");
  });

  test("rejects a non-Bearer Authorization alongside x-api-key", () => {
    const headers = new Headers({
      "x-api-key": "rk_one",
      authorization: "Basic abc",
    });
    expect(() => requestToken(headers)).toThrow("conflicting credential headers");
  });

  test("rejects when neither header carries a credential", () => {
    expect(() => requestToken(new Headers())).toThrow("missing or malformed Authorization header");
  });
});

describe("key-lookup.test.ts", () => {
describe("ApiKeyAuthorizationSnapshot", () => {
  test("freeze copies arrays and snapshot is deeply frozen", () => {
    const model_allowlist = ["gpt-4", "claude-3"];
    const model_denylist = ["gpt-3.5"];
    const snap = freezeSnapshot({
      api_key_id: "k1",
      tenant_id: "t1",
      model_allowlist,
      model_denylist,
      rpm: 60,
      daily_tokens: 10_000,
      monthly_tokens: 100_000,
      max_concurrent: 5,
    });

    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.model_allowlist as unknown as object)).toBe(true);
    expect(Object.isFrozen(snap.model_denylist as unknown as object)).toBe(true);

    // Mutating original arrays does not affect snapshot
    model_allowlist.push("extra");
    expect(snap.model_allowlist).toEqual(["gpt-4", "claude-3"]);

    // Attempt to mutate frozen snapshot throws or is ignored
    expect(() => {
      (snap as unknown as Record<string, unknown>)["rpm"] = 999;
    }).toThrow();
    expect(snap.rpm).toBe(60);
  });

  test("createAuthorizationSnapshot preserves all fields and sets admission_identity default", () => {
    const snap = createAuthorizationSnapshot({
      api_key_id: "key-123",
      tenant_id: "tenant-abc",
      model_allowlist: ["gpt-4"],
      model_denylist: ["bad-model"],
      rpm: 100,
      daily_tokens: 5000,
      monthly_tokens: 50000,
      lifetime_token_budget: 1_000_000,
      lifetime_tokens_consumed: 12345,
      max_concurrent: 10,
    });
    expect(snap.api_key_id).toBe("key-123");
    expect(snap.tenant_id).toBe("tenant-abc");
    expect(snap.admission_identity).toBe("key-123");
    expect(snap.model_allowlist).toEqual(["gpt-4"]);
    expect(snap.model_denylist).toEqual(["bad-model"]);
    expect(snap.rpm).toBe(100);
    expect(snap.daily_tokens).toBe(5000);
    expect(snap.monthly_tokens).toBe(50000);
    expect(snap.lifetime_token_budget).toBe(1_000_000);
    expect(snap.lifetime_tokens_consumed).toBe(12345);
    expect(snap.max_concurrent).toBe(10);
  });

  test("immutability: model restrictions stay on the authorization snapshot", () => {
    const snap = createAuthorizationSnapshot({
      api_key_id: "k2",
      tenant_id: "t2",
      model_allowlist: ["anthropic/claude-3"],
      model_denylist: [],
      rpm: 10,
      max_concurrent: 2,
    });
    const narrowed = { api_key_id: snap.api_key_id } as unknown as typeof snap;
    expect(narrowed.model_allowlist).toBeUndefined();
    expect(snap.model_allowlist).toEqual(["anthropic/claude-3"]);
    expect(isModelAllowed(snap, "gpt-4")).toBe(false);
    expect(isModelAllowed(snap, "claude-3", "anthropic", "anthropic/claude-3")).toBe(true);
  });

  test("model allowlist/denylist precedence is deterministic", () => {
    const snap = createAuthorizationSnapshot({
      api_key_id: "k3",
      tenant_id: "t3",
      model_allowlist: ["gpt-4", "gpt-4o", "claude-3"],
      model_denylist: ["gpt-4o"],
    });
    expect(isModelAllowed(snap, "gpt-4o")).toBe(false);
    expect(isModelAllowed(snap, "gpt-4")).toBe(true);
    expect(isModelAllowed(snap, "unknown-model")).toBe(false);
    const unrestricted = createAuthorizationSnapshot({ api_key_id: "k5", tenant_id: "t5" });
    expect(isModelAllowed(unrestricted, "any-model")).toBe(true);
  });

  test("model lists match bare and provider-qualified forms", () => {
    const snap = createAuthorizationSnapshot({
      api_key_id: "k-dual",
      tenant_id: "t-dual",
      model_allowlist: ["gpt-4"],
      model_denylist: ["bad-model"],
    });
    // Bare allow entry admits the qualified use.
    expect(isModelAllowed(snap, "gpt-4")).toBe(true);
    expect(isModelAllowed(snap, "openai/gpt-4")).toBe(true);
    // Bare deny entry blocks the qualified use (no silent under-enforcement).
    expect(isModelAllowed(snap, "bad-model")).toBe(false);
    expect(isModelAllowed(snap, "openai/bad-model")).toBe(false);
    // Unlisted stays denied under a non-empty allowlist, either form.
    expect(isModelAllowed(snap, "other")).toBe(false);
    expect(isModelAllowed(snap, "openai/other")).toBe(false);
  });

  test("model rules gate dispatch without pinning a provider", async () => {
    const snapshot = createAuthorizationSnapshot({
      api_key_id: "k6",
      tenant_id: "t6",
      model_allowlist: ["gpt-4"],
      model_denylist: ["gpt-4o"],
    });

    let dispatchCalls = 0;
    const mockDispatch = async (input: {
      readonly authorization: typeof snapshot;
      readonly targetProvider: string;
      readonly targetModel: string;
    }) => {
      // downstream must receive whole snapshot without re-querying
      expect(input.authorization).toBe(snapshot);
      expect(input.authorization.api_key_id).toBe("k6");
      dispatchCalls++;
    };

    const attemptDispatch = async (provider: string, model: string) => {
      if (!isModelAllowed(snapshot, model)) {
        throw Object.assign(new Error("model_not_found"), { code: "model_not_found" });
      }
      await mockDispatch({ authorization: snapshot, targetProvider: provider, targetModel: model });
    };

    await expect(attemptDispatch("openai", "gpt-4")).resolves.toBeUndefined();
    expect(dispatchCalls).toBe(1);

    await expect(attemptDispatch("openai", "gpt-4o")).rejects.toThrow();
    await expect(attemptDispatch("anthropic", "gpt-4")).resolves.toBeUndefined();
    // denied requests never reached dispatch
    expect(dispatchCalls).toBe(2);
  });

  test("snapshot with Set input is normalized and frozen", () => {
    const snap = freezeSnapshot({
      api_key_id: "k7",
      tenant_id: "t7",
      model_allowlist: new Set(["a", "b"]) as unknown as readonly string[],
      model_denylist: new Set(["c"]) as unknown as readonly string[],
    });
    expect(snap.model_allowlist).toEqual(["a", "b"]);
    expect(snap.model_denylist).toEqual(["c"]);
    expect(Object.isFrozen(snap)).toBe(true);
  });
});
});
