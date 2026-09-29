import { describe, expect, test } from "bun:test";
import { checkinEgressForPass } from "../../src/workers/checkin-egress";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import type { ValidatedNetworkBindingFactory } from "../../src/network/pool/resolver";

const directFetch = globalThis.fetch;

/** Fake DB whose `network_pools` table holds the given rows. */
function fakeDb(
  rows: ReadonlyArray<{ id: string; tenantId: string | null }>,
): CartethyiaDatabase {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows.map((row) => ({ ...row })),
      }),
    }),
  } as unknown as CartethyiaDatabase;
}

function fakeFactory(calls: string[]): ValidatedNetworkBindingFactory {
  return {
    fetch: ((poolId?: string) => {
      calls.push(poolId ?? "direct");
      return directFetch;
    }) as ValidatedNetworkBindingFactory["fetch"],
  } as ValidatedNetworkBindingFactory;
}

describe("check-in egress rotation", () => {
  test("rotates accounts across pools so check-ins spread IPs", async () => {
    const calls: string[] = [];
    const egress = checkinEgressForPass({
      db: fakeDb([
        { id: "pool-a", tenantId: null },
        { id: "pool-b", tenantId: null },
      ]),
      networkBindingFactory: fakeFactory(calls),
    });

    await egress("acct-1", "t1");
    await egress("acct-2", "t1");
    await egress("acct-3", "t1");
    expect(calls).toEqual(["pool-a", "pool-b", "pool-a"]);
  });

  test("a tenant never borrows another tenant's pool", async () => {
    const calls: string[] = [];
    const egress = checkinEgressForPass({
      db: fakeDb([
        { id: "pool-a", tenantId: "t1" },
        { id: "pool-b", tenantId: "t2" },
      ]),
      networkBindingFactory: fakeFactory(calls),
    });

    await egress("acct-1", "t1");
    await egress("acct-2", "t2");
    expect(calls).toEqual(["pool-a", "pool-b"]);
  });

  test("a tenant falls back to the global pools when it owns none", async () => {
    const calls: string[] = [];
    const egress = checkinEgressForPass({
      db: fakeDb([{ id: "pool-g", tenantId: null }]),
      networkBindingFactory: fakeFactory(calls),
    });

    await egress("acct-1", "t9");
    expect(calls).toEqual(["pool-g"]);
  });

  test("no pools means direct egress, and an unreadable table does too", async () => {
    const empty = checkinEgressForPass({
      db: fakeDb([]),
      networkBindingFactory: fakeFactory([]),
    });
    expect(await empty("acct-1", "t1")).toBe(directFetch);

    const broken = checkinEgressForPass({
      db: {
        select: () => {
          throw new Error("db down");
        },
      } as unknown as CartethyiaDatabase,
      networkBindingFactory: fakeFactory([]),
    });
    expect(await broken("acct-1", "t1")).toBe(directFetch);
  });

  test("a pool failure degrades to direct egress, never to a throw", async () => {
    const egress = checkinEgressForPass({
      db: fakeDb([{ id: "pool-a", tenantId: null }]),
      networkBindingFactory: {
        fetch: () => {
          throw new Error("pool down");
        },
      } as unknown as ValidatedNetworkBindingFactory,
    });
    expect(await egress("acct-1", "t1")).toBe(directFetch);
  });
});
