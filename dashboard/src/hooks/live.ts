import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { consoleRequest, isRecord } from "../data/api";
import { queryKeys } from "../data/query-keys";

export interface InFlightState {
  /** Latest live count, or null before the first snapshot arrives. */
  readonly count: number | null;
  /** Unique client IPs behind the live count, or null before arrival. */
  readonly uniqueIps: number | null;
  /** Per-request live detail (serving model + failover trail), or null before arrival. */
  readonly flights: readonly LiveFlight[] | null;
  /** True while the SSE stream is open and pushing. */
  readonly live: boolean;
}

export interface LiveFailover {
  readonly providerId: string;
  readonly modelId: string;
  readonly at: number;
}

export interface LiveFlight {
  readonly id: string;
  readonly startedAt: number;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly attempt: number;
  readonly failovers: readonly LiveFailover[];
}

function readFlights(payload: unknown): readonly LiveFlight[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.flights)) return null;
  const flights: LiveFlight[] = [];
  for (const raw of payload.flights) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.startedAt !== "number") continue;
    const failovers: LiveFailover[] = [];
    if (Array.isArray(raw.failovers)) {
      for (const f of raw.failovers) {
        if (!isRecord(f) || typeof f.providerId !== "string" || typeof f.modelId !== "string") continue;
        failovers.push({
          providerId: f.providerId,
          modelId: f.modelId,
          at: typeof f.at === "number" ? f.at : 0,
        });
      }
    }
    flights.push({
      id: raw.id,
      startedAt: raw.startedAt,
      providerId: typeof raw.providerId === "string" ? raw.providerId : null,
      modelId: typeof raw.modelId === "string" ? raw.modelId : null,
      attempt: typeof raw.attempt === "number" && Number.isFinite(raw.attempt) ? Math.max(0, Math.floor(raw.attempt)) : 0,
      failovers,
    });
  }
  return flights;
}

function readSnapshot(payload: unknown): { count: number; uniqueIps: number; flights: readonly LiveFlight[] | null } | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.inFlight !== "number" || !Number.isFinite(payload.inFlight)) return null;
  const count = Math.max(0, Math.floor(payload.inFlight));
  // Older gateways send no `uniqueIps`: fall back to the count so the pill
  // still renders instead of sticking at its loading state.
  const uniqueIps =
    typeof payload.uniqueIps === "number" && Number.isFinite(payload.uniqueIps)
      ? Math.max(0, Math.min(count, Math.floor(payload.uniqueIps)))
      : count;
  // Older gateways send no `flights`: the count pill works, the activity
  // view stays empty.
  return { count, uniqueIps, flights: readFlights(payload) };
}

const STREAM_RETRY_MS = 5_000;

/**
 * Live in-flight proxy request count over the console SSE stream
 * (`GET /live/in-flight/stream`, `count` events). Opens with an
 * authenticated snapshot fetch — so a dead session bounces to login through
 * the shell's normal 401 handling instead of spinning a retry loop — then
 * keeps the stream open; on transport failure it re-snapshots and re-opens
 * after a short delay.
 */
export function useInFlight(): InFlightState {
  const [count, setCount] = useState<number | null>(null);
  const [uniqueIps, setUniqueIps] = useState<number | null>(null);
  const [flights, setFlights] = useState<readonly LiveFlight[] | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;

    const connect = async () => {
      const currentGeneration = ++generation;
      try {
        const snapshot = await consoleRequest<unknown>("/live/in-flight");
        if (stopped || currentGeneration !== generation) return;
        const next = readSnapshot(snapshot);
        if (next !== null) {
          setCount(next.count);
          setUniqueIps(next.uniqueIps);
          setFlights(next.flights);
        }

        const nextSource = new EventSource("/console/api/live/in-flight/stream");
        source = nextSource;
        nextSource.addEventListener("count", (event) => {
          if (stopped || currentGeneration !== generation) return;
          try {
            const seen = readSnapshot(JSON.parse((event as MessageEvent).data as string));
            if (seen !== null) {
              setCount(seen.count);
              setUniqueIps(seen.uniqueIps);
              setFlights(seen.flights);
              setLive(true);
            }
          } catch {
            // Malformed frame: keep the last good value.
          }
        });
        nextSource.onerror = () => {
          if (stopped || currentGeneration !== generation) return;
          nextSource.close();
          if (source === nextSource) source = undefined;
          setLive(false);
          retryTimer = setTimeout(() => {
            if (!stopped) void connect();
          }, STREAM_RETRY_MS);
        };
      } catch {
        // Unauthenticated (shell handles the transition) or offline: retry after a delay.
        if (!stopped && currentGeneration === generation) {
          setLive(false);
          retryTimer = setTimeout(() => {
            if (!stopped) void connect();
          }, STREAM_RETRY_MS);
        }
      }
    };

    void connect();
    return () => {
      stopped = true;
      generation += 1;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  return { count, uniqueIps, flights, live };
}

export interface PoolUsageRow {
  readonly poolId: string;
  readonly currentInflight: number;
}

export interface PoolUsageState {
  /** Latest per-pool usage rows, or null before the first snapshot arrives. */
  readonly pools: readonly PoolUsageRow[] | null;
  /** True while the SSE stream is open and pushing. */
  readonly live: boolean;
}

function readPools(payload: unknown): readonly PoolUsageRow[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.pools)) return null;
  const rows: PoolUsageRow[] = [];
  for (const raw of payload.pools) {
    if (!isRecord(raw) || typeof raw.poolId !== "string") continue;
    const currentInflight = typeof raw.currentInflight === "number" && Number.isFinite(raw.currentInflight)
      ? Math.max(0, Math.floor(raw.currentInflight))
      : 0;
    rows.push({ poolId: raw.poolId, currentInflight });
  }
  return rows;
}

const POOL_STREAM_RETRY_MS = 5_000;

/**
 * Live per-pool proxy usage over the console SSE stream
 * (`GET /live/pools/stream`, `pools` events). Same open pattern as
 * `useInFlight`: authenticated snapshot first, then the stream, with
 * re-snapshot + re-open on transport failure. Rows cover only pools with an
 * active slot — an idle pool reads as absent (zero), keyed by pool id so the
 * Proxy page can join against its pool list.
 */
export function usePoolUsage(): PoolUsageState {
  const queryClient = useQueryClient();
  const [pools, setPools] = useState<readonly PoolUsageRow[] | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const openStream = () => {
      source = new EventSource("/console/api/live/pools/stream");
      source.addEventListener("pools", (event) => {
        if (stopped) return;
        try {
          const next = readPools(JSON.parse((event as MessageEvent).data as string));
          if (next !== null) {
            setPools(next);
            setLive(true);
          }
        } catch {
          // Malformed frame: keep the last good value.
        }
      });
      source.addEventListener("health", () => {
        if (!stopped) void queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
      });
      source.onerror = () => {
        source?.close();
        if (stopped) return;
        setLive(false);
        retryTimer = setTimeout(() => {
          if (!stopped) void snapshotThenStream();
        }, POOL_STREAM_RETRY_MS);
      };
    };

    const snapshotThenStream = async () => {
      try {
        const snapshot = await consoleRequest<unknown>("/live/pools");
        if (stopped) return;
        const next = readPools(snapshot);
        if (next !== null) setPools(next);
        openStream();
      } catch {
        // Unauthenticated (shell handles the transition) or offline: stay stale.
      }
    };

    void snapshotThenStream();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient]);

  return { pools, live };
}
