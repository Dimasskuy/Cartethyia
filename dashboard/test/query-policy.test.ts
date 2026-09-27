import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { DASHBOARD_MUTATION_OPTIONS, DASHBOARD_QUERY_OPTIONS } from "../src/data/query-policy";
import { prefetchRouteIntent } from "../src/data/route-prefetch";
import { queryClient as dashboardQueryClient } from "../src/data/query-client";
import { queryKeys } from "../src/data/query-keys";

const healthPayload = {
  status: "healthy",
  uptime_seconds: 1,
  memory_bytes: 1,
  memory_percent: 1,
  heap_used_bytes: 1,
  external_bytes: 1,
  cpu_percent: 1,
  request_count: 1,
  error_count: 0,
  latency_avg_ms: 1,
  latency_p95_ms: 1,
  latency_p99_ms: 1,
  database_healthy: true,
  redis_healthy: true,
};

describe("dashboard query policy", () => {
  test("owns the shared query and mutation defaults", () => {
    expect(dashboardQueryClient.getDefaultOptions().queries).toMatchObject(DASHBOARD_QUERY_OPTIONS);
    expect(dashboardQueryClient.getDefaultOptions().mutations).toMatchObject(DASHBOARD_MUTATION_OPTIONS);
  });

  test("prefetches only the allowlisted cheap health read", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async (input) => {
      requestCount += 1;
      expect(String(input)).toContain("/console/api/system/health");
      return new Response(JSON.stringify(healthPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await prefetchRouteIntent(queryClient, "/providers");
      expect(queryClient.getQueryData<unknown>(queryKeys.system.health)).toEqual(healthPayload);
      expect(requestCount).toBe(1);

      await prefetchRouteIntent(queryClient, "/api-keys");
      await prefetchRouteIntent(queryClient, "/model-lab");
      await prefetchRouteIntent(queryClient, "/quota");
      expect(requestCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      queryClient.clear();
    }
  });

  test("suppresses repeated failed intents during the session cooldown", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = 1_000;
    let requestCount = 0;
    Date.now = () => now;
    globalThis.fetch = (async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ message: "temporarily unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      await prefetchRouteIntent(queryClient, "/providers");
      await prefetchRouteIntent(queryClient, "/proxy");
      expect(requestCount).toBe(1);

      now += 5_001;
      await prefetchRouteIntent(queryClient, "/providers");
      expect(requestCount).toBe(2);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      queryClient.clear();
    }
  });

  test("does not suppress a new intent after query cancellation", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    let releaseFirstRequest: (() => void) | undefined;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestCount += 1;
      expect(String(input)).toContain("/console/api/system/health");
      if (requestCount > 1) {
        return Promise.resolve(
          new Response(JSON.stringify(healthPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseFirstRequest = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(
            new Response(JSON.stringify(healthPayload), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        };
      });
    }) as unknown as typeof fetch;
    try {
      const firstIntent = prefetchRouteIntent(queryClient, "/providers");
      await Promise.resolve();
      expect(requestCount).toBe(1);
      await queryClient.cancelQueries({ queryKey: queryKeys.system.health });
      await firstIntent;

      await prefetchRouteIntent(queryClient, "/providers");
      expect(requestCount).toBe(2);
      releaseFirstRequest = undefined;
    } finally {
      releaseFirstRequest?.();
      globalThis.fetch = originalFetch;
      queryClient.clear();
    }
  });
});
