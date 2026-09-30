import { GatewayError } from "../../transport/gateway-error";
import type { ProviderDispatchContext } from "../provider-registry";

export interface UpstreamDeadlineLifecycle {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

export function createUpstreamDeadlineLifecycle(
  context: ProviderDispatchContext,
): UpstreamDeadlineLifecycle {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(context.abort_signal.reason);
  const timeoutId = setTimeout(
    () => controller.abort(new Error("upstream_deadline_exceeded")),
    Math.max(0, context.deadline - Date.now()),
  );
  context.abort_signal.addEventListener("abort", onAbort, { once: true });
  if (context.abort_signal.aborted) controller.abort(context.abort_signal.reason);

  let released = false;
  return {
    signal: controller.signal,
    release: () => {
      if (released) return;
      released = true;
      // Disarm the fixed upstream deadline only. Once the upstream has sent
      // headers, a healthy long body must not be killed by the pre-stream
      // wall clock — the outer request watchdog (stall detection) owns it
      // from here.
      //
      // Abort propagation is deliberately KEPT: client disconnect, the stall
      // watchdog, the request deadline, or an operator cancel must still tear
      // down the upstream fetch. Removing the listener here used to detach
      // the fetch permanently — a body that stalled after headers would then
      // hang forever, outliving every timeout and sitting in Live Activity
      // for tens of minutes with no way to stop it.
      clearTimeout(timeoutId);
    },
  };
}

export async function withUpstreamDeadline<T>(
  context: ProviderDispatchContext,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  try {
    return await fn(lifecycle.signal);
  } catch (error: unknown) {
    if (lifecycle.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    }
    throw error;
  } finally {
    lifecycle.release();
  }
}
