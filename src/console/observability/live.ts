// Live domain: process-local in-flight proxy request count, read from the
// request state store's admission funnel (`transport/request/inflight`), plus
// per-pool inflight usage from `NetworkPoolSelector` and tenant-filtered pool
// health notifications. The streams push changes with a heartbeat; health data
// is joined to the owning tenant before it leaves the process.
//
// Every endpoint requires `dashboard:read`. In-flight snapshots and streams
// are filtered to the caller's tenant — a tenant never sees another
// tenant's live requests. Platform admins (tenant null) see everything;
// pool usage and health are likewise filtered to the caller's tenant.

import { Elysia } from "elysia";
import { errorResponse, requireScope } from "../shared/errors";
import type { ConsoleAccessResolver } from "../auth/access";
import { getInFlightSnapshot, subscribeInFlight } from "../../transport/request/inflight";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { networkPools } from "../../persistence/schema";
import { subscribePoolHealth } from "../../network/pool-health-machine";
import { consoleSseResponse, createConsoleSseStream } from "./sse";

export interface LiveConfig {
  readonly accessResolver: ConsoleAccessResolver;
  readonly poolSelector?: NetworkPoolSelector;
  readonly db?: CartethyiaDatabase;
}

async function tenantPoolIds(
  db: CartethyiaDatabase | undefined,
  tenantId: string | null,
): Promise<ReadonlySet<string> | undefined> {
  if (!db) return undefined;
  if (!tenantId) return new Set();
  const rows = await db.select({ id: networkPools.id }).from(networkPools).where(eq(networkPools.tenantId, tenantId));
  return new Set(rows.map((row) => row.id));
}
export function createLiveRoutes(config: LiveConfig): Elysia {
  return new Elysia()
    .get("/live/in-flight", ({ request, set }) => {
      try {
        const access = requireScope(config.accessResolver(request), "dashboard:read");
        return getInFlightSnapshot(access.tenantId);
      } catch (e) {
        return errorResponse(e, set, "Live operation failed");
      }
    })
    .get("/live/in-flight/stream", ({ request, set }) => {
      let tenantId: string | null;
      try {
        tenantId = requireScope(config.accessResolver(request), "dashboard:read").tenantId;
      } catch (e) {
        return errorResponse(e, set, "Live operation failed");
      }
      return consoleSseResponse(
        createConsoleSseStream(request.signal, ({ send }) => {
          const unsubscribe = subscribeInFlight((snapshot) => send("count", snapshot), tenantId);
          send("count", getInFlightSnapshot(tenantId));
          return unsubscribe;
        }),
      );
    })
    .get("/live/pools", async ({ request, set }) => {
      try {
        const access = requireScope(config.accessResolver(request), "dashboard:read");
        const allowed = await tenantPoolIds(config.db, access.tenantId);
        const pools = config.poolSelector?.snapshotPoolUsage() ?? [];
        return { pools: allowed ? pools.filter((pool) => allowed.has(pool.poolId)) : pools };
      } catch (e) {
        return errorResponse(e, set, "Live operation failed");
      }
    })
    .get("/live/pools/stream", async ({ request, set }) => {
      let tenantId: string | null;
      let allowed: ReadonlySet<string> | undefined;
      try {
        const access = requireScope(config.accessResolver(request), "dashboard:read");
        tenantId = access.tenantId;
        allowed = await tenantPoolIds(config.db, tenantId);
      } catch (e) {
        return errorResponse(e, set, "Live operation failed");
      }
      const selector = config.poolSelector;
      return consoleSseResponse(
        createConsoleSseStream(request.signal, ({ send }) => {
          const sendUsage = (pools: readonly { poolId: string; currentInflight: number }[]) =>
            send("pools", {
              pools: allowed ? pools.filter((pool) => allowed.has(pool.poolId)) : pools,
            });
          sendUsage(selector?.snapshotPoolUsage() ?? []);
          const unsubscribeUsage = selector?.subscribePoolUsage(sendUsage);
          const unsubscribeHealth = subscribePoolHealth((pool) => {
            if (pool.tenantId === tenantId) send("health", pool);
          });
          return () => {
            unsubscribeUsage?.();
            unsubscribeHealth();
          };
        }),
      );
    }) as unknown as Elysia;
}
