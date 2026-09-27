import { describe, expect, test } from "bun:test";
import { completeAttempt } from "../../../src/transport/dispatch/attempt-finalize";
import { GatewayError } from "../../../src/transport/gateway-error";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";

describe("attempt finalization error origin", () => {
  test("does not disable a proxy pool for an upstream 402", async () => {
    const request = new Request("http://gateway.test/v1/chat/completions");
    const stateStore = new ProxyRequestStateStore();
    const state = stateStore.initialize(request, Date.now(), 60_000);
    let databaseReads = 0;
    const db = {
      select: () => {
        databaseReads += 1;
        throw new Error("upstream errors must not enter proxy-disable persistence");
      },
    } as never;

    try {
      await completeAttempt(state, {
        status: "failed",
        error: new GatewayError(
          "quota_exceeded",
          402,
          "provider payment required",
          {},
          "upstream",
        ),
        errorOrigin: "upstream",
        networkPoolId: "pool-1",
        terminal: false,
        tenantId: null,
        ingressBody: null,
        responseBody: null,
        db,
      });
      expect(databaseReads).toBe(0);
    } finally {
      state.cleanup();
    }
  });
});
