/**
 * In-flight provider dispatch registry — one entry per live request, keyed by
 * `requestId`, carrying the client IP captured at ingress. The entry is added
 * once after a request acquires its dispatch leases, and removed exactly once
 * when request state is cleaned up (success, error, or client abort all funnel
 * through the idempotent cleanup). Pub/sub lets the console push the live
 * snapshot over SSE instead of polling.
 *
 * A plain counter used to serve here, but the Usage pill needs the *shape* of
 * the load, not just its size: "50 in flight from 40 unique IPs" reads
 * instantly, while a bare "50" leaves the operator guessing whether it is one
 * client hammering or the whole fleet. The per-request entry is one Map row
 * for the life of the flight — bounded by the live concurrency itself.
 *
 * Process-local: each gateway instance reports its own flights.
 */
import { metrics } from "../../observability/metrics";

export interface InFlightSnapshot {
  readonly inFlight: number;
  readonly uniqueIps: number;
}

const flights = new Map<string, string>();
const listeners = new Set<(snapshot: InFlightSnapshot) => void>();

function snapshot(): InFlightSnapshot {
  return { inFlight: flights.size, uniqueIps: new Set(flights.values()).size };
}

function publish(): void {
  const current = snapshot();
  metrics.proxy_in_flight.set(current.inFlight);
  for (const listener of listeners) listener(current);
}

export function trackInFlight(requestId: string, clientIp: string): void {
  flights.set(requestId, clientIp.length > 0 ? clientIp : "unknown");
  publish();
}

export function untrackInFlight(requestId: string): void {
  flights.delete(requestId);
  publish();
}

export function getInFlightCount(): number {
  return flights.size;
}

export function getInFlightSnapshot(): InFlightSnapshot {
  return snapshot();
}

export function subscribeInFlight(listener: (snapshot: InFlightSnapshot) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: reset the shared registry and drop all subscribers between tests. */
export function resetInFlightForTests(): void {
  flights.clear();
  listeners.clear();
}
