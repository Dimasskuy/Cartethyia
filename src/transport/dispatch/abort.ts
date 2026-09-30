import { GatewayError } from "../gateway-error";

/**
 * Throw a `transport_closed` (499) when the owning request was cancelled.
 *
 * Combo orchestrators (swarm, cascade, fusion) run multi-stage pipelines that
 * outlive any single upstream call. They must consult the request's abort
 * signal between stages and bail out instead of starting new upstream work —
 * otherwise a disconnected client (or a hung upstream) keeps burning tokens
 * through stages nobody will ever read.
 *
 * The 499 matches what `runAttemptLoop` throws for the same condition, so the
 * outer handler finalizes it as `cancelled`, not as a provider failure.
 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new GatewayError("transport_closed", 499, "request was cancelled");
}
