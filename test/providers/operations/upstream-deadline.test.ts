import { describe, expect, test } from "bun:test";

import {
  createUpstreamDeadlineLifecycle,
  withUpstreamDeadline,
} from "../../../src/providers/operations/upstream-deadline";
import type { ProviderDispatchContext } from "../../../src/providers/provider-registry";

function makeContext(deadlineInMs = 60_000): {
  context: ProviderDispatchContext;
  parent: AbortController;
} {
  const parent = new AbortController();
  return {
    parent,
    context: {
      credential: {} as never,
      deadline: Date.now() + deadlineInMs,
      abort_signal: parent.signal,
    },
  };
}

describe("upstream deadline lifecycle", () => {
  test("the fixed deadline fires when the operation never releases it", async () => {
    const { context } = makeContext(30);
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lifecycle.signal.aborted).toBe(true);
    lifecycle.release();
  });

  test("release() disarms the deadline timer but keeps abort propagation", async () => {
    const { context, parent } = makeContext();
    const lifecycle = createUpstreamDeadlineLifecycle(context);

    // Upstream headers arrived: the TTFB-only deadline is released so a
    // healthy long body is not killed by the pre-stream wall clock.
    lifecycle.release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(lifecycle.signal.aborted).toBe(false);

    // Later, the request-level abort fires (stall watchdog, client
    // disconnect, deadline, operator cancel): it must still reach the
    // upstream body. Detaching here used to let stalled bodies hang forever,
    // outliving every timeout in Live Activity.
    parent.abort(new DOMException("request cancelled by operator", "AbortError"));
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.signal.reason).toBe(parent.signal.reason);
  });

  test("withUpstreamDeadline maps an abort to transport_closed 499", async () => {
    const { context, parent } = makeContext();
    // A real adapter's fetch rejects with AbortError when the signal fires.
    const pending = withUpstreamDeadline(context, () => {
      parent.abort(new DOMException("gone", "AbortError"));
      return Promise.reject<string>(new DOMException("fetch aborted", "AbortError"));
    });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("transport_closed");
    expect((error as { status?: number }).status).toBe(499);
  });
});
