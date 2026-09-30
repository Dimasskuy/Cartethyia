import { beforeEach, describe, expect, test } from "bun:test";
import { createLiveRoutes } from "../../../src/console/observability/live";
import { resetInFlightForTests, trackInFlight } from "../../../src/transport/request/inflight";
import { NetworkPoolSelector } from "../../../src/network/pool/selector";
import type { AccessDecision } from "../../../src/security/access-control";

const readerAccess: AccessDecision = {
  id: "test-session",
  tenantId: "tenant-1",
  scopes: ["dashboard:read"],
  admissionIdentity: "test-session",
};

function appWith(access: AccessDecision | undefined, selector?: NetworkPoolSelector) {
  return createLiveRoutes({ accessResolver: () => access, ...(selector ? { poolSelector: selector } : {}) });
}

describe("live in-flight routes", () => {
  beforeEach(() => resetInFlightForTests());

  test("snapshot returns the current count and unique IPs", async () => {
    trackInFlight("r1", "1.1.1.1", "tenant-1");
    trackInFlight("r2", "1.1.1.1", "tenant-1");
    const response = await appWith(readerAccess).handle(
      new Request("http://localhost/live/in-flight"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { inFlight: number; uniqueIps: number; flights: unknown[] };
    expect(body.inFlight).toBe(2);
    expect(body.uniqueIps).toBe(1);
    expect(body.flights).toHaveLength(2);
  });

  test("snapshot only exposes the caller's own tenant flights", async () => {
    trackInFlight("r1", "1.1.1.1", "tenant-1");
    trackInFlight("r2", "2.2.2.2", "tenant-2");
    const response = await appWith(readerAccess).handle(
      new Request("http://localhost/live/in-flight"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { inFlight: number; uniqueIps: number; flights: unknown[] };
    expect(body.inFlight).toBe(1);
    expect(body.uniqueIps).toBe(1);
    expect(body.flights).toHaveLength(1);
  });

  test("snapshot rejects unauthenticated callers", async () => {
    const response = await appWith(undefined).handle(
      new Request("http://localhost/live/in-flight"),
    );
    expect(response.status).toBe(401);
  });

  test("stream emits a count snapshot frame first", async () => {
    trackInFlight("r1", "9.9.9.9", "tenant-1");
    const response = await appWith(readerAccess).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(first.value)).toContain(`event: count\ndata: {"inFlight":1,"uniqueIps":1`);
  });

  test("stream subscribes before its snapshot so count changes are not lost", async () => {
    const response = await appWith(readerAccess).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const snapshot = await reader.read();
    trackInFlight("r1", "7.7.7.7", "tenant-1");
    const update = await reader.read();
    await reader.cancel();
    expect(decoder.decode(snapshot.value)).toContain(`event: count\ndata: {"inFlight":0,"uniqueIps":0`);
    expect(decoder.decode(update.value)).toContain(`event: count\ndata: {"inFlight":1,"uniqueIps":1`);
  });

  test("stream frames stay scoped to the caller's tenant", async () => {
    trackInFlight("r1", "9.9.9.9", "tenant-1");
    trackInFlight("r2", "8.8.8.8", "tenant-2");
    const response = await appWith(readerAccess).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    const frame = new TextDecoder().decode(first.value);
    expect(frame).toContain(`event: count\ndata: {"inFlight":1,"uniqueIps":1`);
    expect(frame).toContain(`"id":"r1"`);
    expect(frame).not.toContain(`"id":"r2"`);
  });

  test("stream rejects unauthenticated callers without opening a stream", async () => {
    const response = await appWith(undefined).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });
});

describe("live pool usage routes", () => {
  test("snapshot returns per-pool inflight rows", async () => {
    const selector = new NetworkPoolSelector();
    const slot = selector.acquire("pool-a", 10);
    expect(slot.acquired).toBe(true);
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pools: [{ poolId: "pool-a", currentInflight: 1 }] });
    slot.release();
  });

  test("snapshot is empty when no pool is in use", async () => {
    const selector = new NetworkPoolSelector();
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pools: [] });
  });

  test("snapshot rejects unauthenticated callers", async () => {
    const response = await appWith(undefined, new NetworkPoolSelector()).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(401);
  });

  test("stream emits a pools snapshot frame first", async () => {
    const selector = new NetworkPoolSelector();
    const slot = selector.acquire("pool-s", 10);
    expect(slot.acquired).toBe(true);
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools/stream"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    slot.release();
    expect(new TextDecoder().decode(first.value)).toContain(
      `event: pools\ndata: {"pools":[{"poolId":"pool-s","currentInflight":1}]}`,
    );
  });

  test("stream rejects unauthenticated callers without opening a stream", async () => {
    const response = await appWith(undefined, new NetworkPoolSelector()).handle(
      new Request("http://localhost/live/pools/stream"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });

  test("selector subscription fires on acquire and release", async () => {
    const selector = new NetworkPoolSelector();
    const seen: Array<readonly { poolId: string; currentInflight: number }[]> = [];
    const stop = selector.subscribePoolUsage((usage) => seen.push(usage));
    const slot = selector.acquire("pool-sub", 10);
    slot.release();
    stop();
    // Release after unsubscribe emits nothing further.
    const extra = selector.acquire("pool-sub", 10);
    extra.release();
    expect(seen).toEqual([
      [{ poolId: "pool-sub", currentInflight: 1 }],
      [],
    ]);
  });
});
