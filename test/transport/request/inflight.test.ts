import { beforeEach, describe, expect, test } from "bun:test";
import {
  decrementInFlight,
  getInFlightCount,
  incrementInFlight,
  resetInFlightForTests,
  subscribeInFlight,
} from "../../../src/transport/request/inflight";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";

describe("in-flight counter", () => {
  beforeEach(() => resetInFlightForTests());

  test("starts at zero and tracks increments", () => {
    expect(getInFlightCount()).toBe(0);
    incrementInFlight();
    incrementInFlight();
    expect(getInFlightCount()).toBe(2);
  });

  test("decrement floors at zero instead of going negative", () => {
    decrementInFlight();
    expect(getInFlightCount()).toBe(0);
    incrementInFlight();
    decrementInFlight();
    decrementInFlight();
    expect(getInFlightCount()).toBe(0);
  });

  test("notifies subscribers on every change and unsubscribes cleanly", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeInFlight((count) => void seen.push(count));
    incrementInFlight();
    decrementInFlight();
    unsubscribe();
    incrementInFlight();
    expect(seen).toEqual([1, 0]);
    expect(getInFlightCount()).toBe(1);
  });
});

describe("request state store in-flight funnel", () => {
  beforeEach(() => resetInFlightForTests());

  test("request initialization is not counted before provider dispatch", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("https://gateway.test/v1/chat/completions"), Date.now(), 60_000);
    expect(getInFlightCount()).toBe(0);
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
  });

  test("provider dispatch is counted once and cleanup releases exactly once", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("https://gateway.test/v1/chat/completions"), Date.now(), 60_000);
    state.startProviderFlight();
    state.startProviderFlight();
    expect(getInFlightCount()).toBe(1);
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
  });

  test("cleanup before dispatch cannot start a flight afterward", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("https://gateway.test/v1/chat/completions"), Date.now(), 60_000);
    state.cleanup();
    state.startProviderFlight();
    expect(getInFlightCount()).toBe(0);
  });

  test("double cleanup of one flight releases exactly once", () => {
    const store = new ProxyRequestStateStore();
    const first = store.initialize(new Request("https://gateway.test/v1/first"), Date.now(), 60_000);
    const second = store.initialize(new Request("https://gateway.test/v1/second"), Date.now(), 60_000);
    first.startProviderFlight();
    second.startProviderFlight();
    expect(getInFlightCount()).toBe(2);
    first.cleanup();
    first.cleanup();
    expect(getInFlightCount()).toBe(1);
    second.cleanup();
    expect(getInFlightCount()).toBe(0);
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
