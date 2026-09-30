import { beforeEach, describe, expect, test } from "bun:test";
import {
  getInFlightCount,
  getInFlightSnapshot,
  type InFlightSnapshot,
  recordInFlightFailover,
  resetInFlightForTests,
  subscribeInFlight,
  trackInFlight,
  untrackInFlight,
  updateInFlightServing,
} from "../../../src/transport/request/inflight";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";

describe("in-flight registry", () => {
  beforeEach(() => resetInFlightForTests());

  test("starts at zero and tracks flights by request id", () => {
    expect(getInFlightCount()).toBe(0);
    expect(getInFlightSnapshot()).toEqual({ inFlight: 0, uniqueIps: 0, flights: [] });
    trackInFlight("r1", "1.1.1.1");
    trackInFlight("r2", "2.2.2.2");
    expect(getInFlightCount()).toBe(2);
    const snapshot = getInFlightSnapshot();
    expect(snapshot.inFlight).toBe(2);
    expect(snapshot.uniqueIps).toBe(2);
    expect(snapshot.flights.map((f) => f.id).sort()).toEqual(["r1", "r2"]);
    expect(snapshot.flights.every((f) => f.providerId === null && f.attempt === 0)).toBe(true);
  });

  test("one IP with concurrent flights counts once in uniqueIps", () => {
    trackInFlight("r1", "1.1.1.1");
    trackInFlight("r2", "1.1.1.1");
    trackInFlight("r3", "2.2.2.2");
    const snapshot = getInFlightSnapshot();
    expect(snapshot.inFlight).toBe(3);
    expect(snapshot.uniqueIps).toBe(2);
  });

  test("untracking an unknown id is a no-op, never negative", () => {
    untrackInFlight("nope");
    expect(getInFlightCount()).toBe(0);
    trackInFlight("r1", "1.1.1.1");
    untrackInFlight("r1");
    untrackInFlight("r1");
    expect(getInFlightSnapshot()).toEqual({ inFlight: 0, uniqueIps: 0, flights: [] });
  });

  test("notifies subscribers with the snapshot on every change and unsubscribes cleanly", () => {
    const seen: Array<{ inFlight: number; uniqueIps: number }> = [];
    const stop = subscribeInFlight((snapshot) =>
      seen.push({ inFlight: snapshot.inFlight, uniqueIps: snapshot.uniqueIps }),
    );
    trackInFlight("r1", "1.1.1.1");
    trackInFlight("r2", "1.1.1.1");
    untrackInFlight("r1");
    stop();
    trackInFlight("r3", "3.3.3.3");
    expect(seen).toEqual([
      { inFlight: 1, uniqueIps: 1 },
      { inFlight: 2, uniqueIps: 1 },
      { inFlight: 1, uniqueIps: 1 },
    ]);
  });

  test("serving updates and failover hops are tracked per flight", () => {
    trackInFlight("request-abcdef-1234", "1.1.1.1");
    updateInFlightServing("request-abcdef-1234", {
      providerId: "prov-a",
      modelId: "model-x",
      attemptIndex: 0,
    });
    recordInFlightFailover("request-abcdef-1234", { providerId: "prov-a", modelId: "model-x" });
    updateInFlightServing("request-abcdef-1234", {
      providerId: "prov-b",
      modelId: "model-y",
      attemptIndex: 1,
    });
    const snapshot = getInFlightSnapshot();
    expect(snapshot.flights).toHaveLength(1);
    const flight = snapshot.flights[0]!;
    expect(flight.id).toBe("request-");
    expect(flight.providerId).toBe("prov-b");
    expect(flight.modelId).toBe("model-y");
    expect(flight.attempt).toBe(1);
    expect(flight.failovers).toHaveLength(1);
    expect(flight.failovers[0]).toMatchObject({ providerId: "prov-a", modelId: "model-x" });
  });

  test("updates for unknown flights are ignored", () => {
    updateInFlightServing("nope", { providerId: "p", modelId: "m", attemptIndex: 0 });
    recordInFlightFailover("nope", { providerId: "p", modelId: "m" });
    expect(getInFlightSnapshot()).toEqual({ inFlight: 0, uniqueIps: 0, flights: [] });
  });

  test("snapshots and subscriptions are tenant-scoped; platform view sees all", () => {
    trackInFlight("r1", "1.1.1.1", "tenant-a");
    trackInFlight("r2", "2.2.2.2", "tenant-b");
    const scoped = getInFlightSnapshot("tenant-a");
    expect(scoped.inFlight).toBe(1);
    expect(scoped.uniqueIps).toBe(1);
    expect(scoped.flights.map((f) => f.id)).toEqual(["r1"]);
    const other = getInFlightSnapshot("tenant-b");
    expect(other.inFlight).toBe(1);
    expect(other.flights.map((f) => f.id)).toEqual(["r2"]);
    // Platform admin (null tenant) sees every tenant's flights.
    expect(getInFlightSnapshot(null).inFlight).toBe(2);

    const seen: InFlightSnapshot[] = [];
    const stop = subscribeInFlight((snapshot) => seen.push(snapshot), "tenant-b");
    // Another tenant's activity still publishes, but the subscriber's
    // snapshot stays scoped to their own tenant.
    trackInFlight("r3", "3.3.3.3", "tenant-a");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.inFlight).toBe(1);
    expect(seen[0]!.flights.map((f) => f.id)).toEqual(["r2"]);
    stop();
    trackInFlight("r4", "4.4.4.4", "tenant-b");
    expect(seen).toHaveLength(1);
  });
});

describe("request state store in-flight funnel", () => {
  beforeEach(() => resetInFlightForTests());

  test("request initialization is not counted before provider dispatch", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    expect(getInFlightCount()).toBe(0);
    state.cleanup();
  });

  test("provider dispatch is counted once and cleanup releases exactly once", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    state.startProviderFlight(null);
    state.startProviderFlight(null);
    expect(getInFlightCount()).toBe(1);
    expect(getInFlightSnapshot().uniqueIps).toBe(1);
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
  });

  test("cleanup before dispatch cannot start a flight afterward", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    state.cleanup();
    state.startProviderFlight(null);
    expect(getInFlightCount()).toBe(0);
  });

  test("double cleanup of one flight releases exactly once", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    state.startProviderFlight(null);
    expect(getInFlightCount()).toBe(1);
    state.cleanup();
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
  });

  test("two concurrent flights from one IP share one unique IP", () => {
    const store = new ProxyRequestStateStore();
    const first = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    const second = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    first.clientIdentity = { address: "9.9.9.9", source: "tcp-peer" };
    second.clientIdentity = { address: "9.9.9.9", source: "tcp-peer" };
    first.startProviderFlight(null);
    second.startProviderFlight(null);
    const snapshot = getInFlightSnapshot();
    expect(snapshot.inFlight).toBe(2);
    expect(snapshot.uniqueIps).toBe(1);
    expect(snapshot.flights).toHaveLength(2);
    first.cleanup();
    second.cleanup();
  });

  test("cleanup unregisters the request tracker exactly once", () => {
    let untracked = 0;
    const store = new ProxyRequestStateStore({
      track: () => undefined,
      untrack: () => {
        untracked += 1;
      },
    });
    const state = store.initialize(new Request("https://gateway.test/v1/chat/completions"), Date.now(), 60_000);
    state.cleanup();
    state.cleanup();
    expect(untracked).toBe(1);
  });

  test("cleanup executes a callback registered afterward immediately", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("https://gateway.test/v1/chat/completions"), Date.now(), 60_000);
    state.cleanup();
    let called = false;
    state.addCleanup(() => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
