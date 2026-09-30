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
 * Each entry also tracks which provider/model is currently serving the
 * request and the failover hops it took to get there, so the Usage page can
 * render a live activity view: "request X is on attempt 2, now serving
 * provider-b/model-y after provider-a/model-x failed". Client IPs never leave
 * the process in the detail view — only aggregate counts.
 *
 * Entries carry the owning tenant id, and snapshots/subscriptions are
 * filtered by it: a console caller only ever sees their own tenant's
 * flights. Platform admins (tenant null) see everything.
 *
 * Process-local: each gateway instance reports its own flights.
 */
import { metrics } from "../../observability/metrics";

/** One failed attempt that triggered a failover to the next candidate. */
export interface InFlightFailover {
  readonly providerId: string;
  readonly modelId: string;
  /** Epoch ms when the attempt failed. */
  readonly at: number;
}

/** Live detail for one in-flight request. */
export interface InFlightFlight {
  /** First 8 chars of the request id — enough to correlate, nothing sensitive. */
  readonly id: string;
  /** Epoch ms when the flight was registered. */
  readonly startedAt: number;
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** Zero-based index of the candidate currently serving (also failover count). */
  readonly attempt: number;
  readonly failovers: readonly InFlightFailover[];
}

export interface InFlightSnapshot {
  readonly inFlight: number;
  readonly uniqueIps: number;
  readonly flights: readonly InFlightFlight[];
}

interface FlightEntry {
  clientIp: string;
  tenantId: string | null;
  startedAt: number;
  providerId: string | null;
  modelId: string | null;
  attempt: number;
  failovers: InFlightFailover[];
}

interface FlightListener {
  readonly listener: (snapshot: InFlightSnapshot) => void;
  /** Null = platform admin view, sees every tenant's flights. */
  readonly tenantId: string | null;
}

/** Cap on detail rows per snapshot so one SSE push stays small. */
const MAX_FLIGHT_ROWS = 100;

const flights = new Map<string, FlightEntry>();
const listeners = new Set<FlightListener>();

/**
 * A console caller with a tenant only ever sees that tenant's flights.
 * Platform admins (tenantId null) see everything.
 */
function snapshot(tenantId: string | null = null): InFlightSnapshot {
  const rows: InFlightFlight[] = [];
  const ips = new Set<string>();
  let total = 0;
  for (const [requestId, entry] of flights) {
    if (tenantId !== null && entry.tenantId !== tenantId) continue;
    total += 1;
    ips.add(entry.clientIp);
    if (rows.length >= MAX_FLIGHT_ROWS) continue;
    rows.push({
      id: requestId.slice(0, 8),
      startedAt: entry.startedAt,
      providerId: entry.providerId,
      modelId: entry.modelId,
      attempt: entry.attempt,
      failovers: entry.failovers,
    });
  }
  // Newest first — the operator cares about what just started.
  rows.sort((a, b) => b.startedAt - a.startedAt);
  return { inFlight: total, uniqueIps: ips.size, flights: rows };
}

function publish(): void {
  metrics.proxy_in_flight.set(flights.size);
  for (const { listener, tenantId } of listeners) listener(snapshot(tenantId));
}

export function trackInFlight(requestId: string, clientIp: string, tenantId: string | null = null): void {
  flights.set(requestId, {
    clientIp: clientIp.length > 0 ? clientIp : "unknown",
    tenantId,
    startedAt: Date.now(),
    providerId: null,
    modelId: null,
    attempt: 0,
    failovers: [],
  });
  publish();
}

/** Records which candidate is currently serving a live request. */
export function updateInFlightServing(
  requestId: string,
  serving: { providerId: string; modelId: string; attemptIndex: number },
): void {
  const entry = flights.get(requestId);
  if (!entry) return;
  entry.providerId = serving.providerId;
  entry.modelId = serving.modelId;
  entry.attempt = serving.attemptIndex;
  publish();
}

/** Appends a failed attempt to the request's failover trail. */
export function recordInFlightFailover(
  requestId: string,
  failed: { providerId: string; modelId: string },
): void {
  const entry = flights.get(requestId);
  if (!entry) return;
  entry.failovers.push({ providerId: failed.providerId, modelId: failed.modelId, at: Date.now() });
  publish();
}

export function untrackInFlight(requestId: string): void {
  flights.delete(requestId);
  publish();
}

export function getInFlightCount(): number {
  return flights.size;
}

export function getInFlightSnapshot(tenantId: string | null = null): InFlightSnapshot {
  return snapshot(tenantId);
}

export function subscribeInFlight(
  listener: (snapshot: InFlightSnapshot) => void,
  tenantId: string | null = null,
): () => void {
  const entry: FlightListener = { listener, tenantId };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}

/** Test-only: reset the shared registry and drop all subscribers between tests. */
export function resetInFlightForTests(): void {
  flights.clear();
  listeners.clear();
}
