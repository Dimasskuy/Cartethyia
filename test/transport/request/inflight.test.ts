import { beforeEach, describe, expect, test } from "bun:test";
import {
  getInFlightCount,
  getInFlightSnapshot,
  resetInFlightForTests,
  subscribeInFlight,
  trackInFlight,
  untrackInFlight,
} from "../../../src/transport/request/inflight";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";

describe("in-flight registry", () => {
  beforeEach(() => resetInFlightForTests());

  test("starts at zero and tracks flights by request id", () => {
    expect(getInFlightCount()).toBe(0);
    expect(getInFlightSnapshot()).toEqual({ inFlight: 0, uniqueIps: 0 });
    trackInFlight("r1", "1.1.1.1");
    trackInFlight("r2", "2.2.2.2");
    expect(getInFlightCount()).toBe(2);
    expect(getInFlightSnapshot()).toEqual({ inFlight: 2, uniqueIps: 2 });
  });

  test("one IP with concurrent flights counts once in uniqueIps", () => {
    trackInFlight("r1", "1.1.1.1");
    trackInFlight("r2", "1.1.1.1");
    trackInFlight("r3", "2.2.2.2");
    expect(getInFlightSnapshot()).toEqual({ inFlight: 3, uniqueIps: 2 });
  });

  test("untracking an unknown id is a no-op, never negative", () => {
    untrackInFlight("nope");
    expect(getInFlightCount()).toBe(0);
    trackInFlight("r1", "1.1.1.1");
    untrackInFlight("r1");
    untrackInFlight("r1");
    expect(getInFlightSnapshot()).toEqual({ inFlight: 0, uniqueIps: 0 });
  });

  test("notifies subscribers with the snapshot on every change and unsubscribes cleanly", () => {
    const seen: Array<{ inFlight: number; uniqueIps: number }> = [];
    const stop = subscribeInFlight((snapshot) => seen.push(snapshot));
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
    state.startProviderFlight();
    state.startProviderFlight();
    expect(getInFlightCount()).toBe(1);
    expect(getInFlightSnapshot().uniqueIps).toBe(1);
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
  });

  test("cleanup before dispatch cannot start a flight afterward", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    state.cleanup();
    state.startProviderFlight();
    expect(getInFlightCount()).toBe(0);
  });

  test("double cleanup of one flight releases exactly once", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 1000);
    state.startProviderFlight();
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
    first.startProviderFlight();
    second.startProviderFlight();
    expect(getInFlightSnapshot()).toEqual({ inFlight: 2, uniqueIps: 1 });
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
