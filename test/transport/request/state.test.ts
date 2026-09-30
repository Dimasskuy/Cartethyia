import { describe, expect, test } from "bun:test";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import { getInFlightCount } from "../../../src/transport/request/inflight";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true when `signal` aborts before `timeoutMs`, false otherwise. */
function waitForAbort(signal: AbortSignal, timeoutMs = 2_000): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

function newState(deadlineMs: number) {
  const store = new ProxyRequestStateStore();
  const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
  return { store, request, state: store.initialize(request, Date.now(), deadlineMs) };
}

describe("ProxyRequestStateStore request identity", () => {
  test("captures method and path at initialization so lifecycle gating never depends on middleware order", () => {
    const store = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions?stream=true", {
      method: "POST",
    });
    const state = store.initialize(request, Date.now(), 30_000);
    expect(state.ingressMethod).toBe("POST");
    // Query string is excluded: the path is the route identity.
    expect(state.ingressPath).toBe("/v1/chat/completions");
    state.cleanup();
  });
});

describe("ProxyRequestStateStore deadline", () => {
  test("aborts the controller when the deadline elapses", async () => {
    const { state } = newState(20);
    expect(await waitForAbort(state.abortController.signal)).toBe(true);
    state.cleanup();
  });

  test("extendDeadline re-arms the timer past the original deadline", async () => {
    const { state } = newState(20);
    state.extendDeadline(500);
    // Well past the original 20ms deadline, the extension keeps it alive.
    await sleep(80);
    expect(state.abortController.signal.aborted).toBe(false);
    expect(await waitForAbort(state.abortController.signal)).toBe(true);
    state.cleanup();
  });

  test("extendDeadline is a no-op after cleanup", async () => {
    const { state } = newState(20);
    state.cleanup();
    // Cleanup already aborted with "request complete"; extending must neither
    // throw nor resurrect the request.
    state.extendDeadline(10_000);
    expect(state.abortController.signal.aborted).toBe(true);
    await sleep(30);
    expect(state.abortController.signal.aborted).toBe(true);
  });
});

describe("ProxyRequestStateStore orphan safety net", () => {
  function newAbortableState() {
    const store = new ProxyRequestStateStore();
    const inbound = new AbortController();
    const request = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      signal: inbound.signal,
    });
    const state = store.initialize(request, Date.now(), 30_000);
    return { store, request, state, inbound };
  }

  test("inbound abort after a completed non-streaming request untracks the flight row", () => {
    const { state, inbound } = newAbortableState();
    state.startProviderFlight(null);
    expect(getInFlightCount()).toBe(1);
    // Simulate completeAttempt having run before the response was returned.
    state.completed = true;
    // Client vanishes before the response could be flushed: afterResponse
    // would never fire, so without the safety net the row leaks forever.
    inbound.abort(new DOMException("client gone", "AbortError"));
    expect(getInFlightCount()).toBe(0);
  });

  test("inbound abort never cleans up a streaming request", () => {
    const { state, inbound } = newAbortableState();
    state.startProviderFlight(null);
    state.streaming = true;
    state.completed = true;
    inbound.abort(new DOMException("client gone", "AbortError"));
    // The streaming path owns its own release (releaseStreamResources);
    // the safety net must not steal it.
    expect(getInFlightCount()).toBe(1);
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
  });

  test("inbound abort of an in-flight non-streaming request cleans up without throwing", () => {
    const { state, inbound } = newAbortableState();
    state.startProviderFlight(null);
    expect(getInFlightCount()).toBe(1);
    inbound.abort(new DOMException("client gone", "AbortError"));
    expect(getInFlightCount()).toBe(0);
    expect(state.abortController.signal.aborted).toBe(true);
  });
});

describe("ProxyRequestStateStore.cancelLiveRequest", () => {
  test("aborts a live request and reports it", () => {
    const { store, state } = newState(30_000);
    expect(store.cancelLiveRequest(state.requestId)).toBe(true);
    expect(state.abortController.signal.aborted).toBe(true);
    state.cleanup();
  });

  test("sweeps an orphaned row when the controller is already gone", () => {
    const { store, state } = newState(30_000);
    state.startProviderFlight(null);
    expect(getInFlightCount()).toBe(1);
    // Simulate the orphan: the controller died (client went away) but the
    // flight row was never untracked.
    state.abortController.abort(new DOMException("gone", "AbortError"));
    expect(store.cancelLiveRequest(state.requestId)).toBe(true);
    expect(getInFlightCount()).toBe(0);
    state.cleanup();
  });

  test("returns false when there is nothing to cancel or sweep", () => {
    const { store } = newState(30_000);
    expect(store.cancelLiveRequest(crypto.randomUUID())).toBe(false);
  });
});
