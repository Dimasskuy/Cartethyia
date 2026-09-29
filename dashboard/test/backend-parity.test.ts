import { describe, expect, expectTypeOf, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { healthStatus } from "../../src/persistence/schema";
import { CLIENT_ROUTERS, CLIENT_ROUTER_IDS } from "../../src/security/client-router-fingerprint";
import type { SessionStatusResponse } from "../../src/console/auth/session";
import { USAGE_PERIODS as BACKEND_USAGE_PERIODS } from "../../src/console/observability/usage-periods";
import {
  USAGE_DIMENSIONS as BACKEND_DIMENSIONS,
  type UsageDimension as BackendUsageDimension,
} from "../../src/console/observability/contracts";
import { BUNDLED_PROVIDER_IDS } from "../../src/providers/provider-registry";
import { DEFAULT_PROXY_BYPASS_PROVIDER_IDS } from "../../src/providers/provider-registry";
import { supportsAccountReset } from "../../src/providers/operations/account-reset-service";
import type { HealthStatus } from "../src/data/contracts";
import type { SessionResponse, SessionUser } from "../src/data/contracts";
import { USAGE_DIMENSIONS, type UsageDimension } from "../src/data/contracts";
import { CLIENT_ROUTER_IDS as DASHBOARD_IDS } from "../src/data/contracts";
import { providerDisplayName } from "../src/shared/provider-names";
import { PROXY_UNSUPPORTED_HINT_PROVIDERS } from "../src/hooks/use-routing-strategy";
import generatedPeriods from "../src/data/generated/usage-periods.json";

/** Resolved from this file, not the process cwd. */
const here = import.meta.dir;

function parseSetIds(source: string, marker: string): string[] {
  const from = source.indexOf(marker);
  if (from < 0) throw new Error(`marker not found: ${marker}`);
  const to = source.indexOf("]);", from);
  return [...source.slice(from, to).matchAll(/"([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]!.toLowerCase());
}

function parseIconKeys(source: string): string[] {
  const from = source.indexOf("const iconAssets");
  const to = source.indexOf("function assetFor", from);
  return [...source.slice(from, to).matchAll(/^\s*"?([a-zA-Z0-9_-]+)"?:\s*\{ file:/gm)].map((m) =>
    m[1]!.toLowerCase(),
  );
}

describe("dashboard/backend parity — client routers", () => {
  test("the dashboard offers exactly the routers the backend fingerprints", () => {
    expect(DASHBOARD_IDS).toBe(CLIENT_ROUTER_IDS);
    expect([...DASHBOARD_IDS]).toEqual(CLIENT_ROUTERS.map((router) => router.id));
  });

  test("every offered id is a non-empty stable token", () => {
    for (const id of CLIENT_ROUTER_IDS) {
      expect(id).toBe(id.trim().toLowerCase());
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

describe("dashboard/backend parity — health status", () => {
  test("HealthStatus is exactly the pgEnum union", () => {
    expectTypeOf<HealthStatus>().toEqualTypeOf<"active" | "cooldown" | "disabled">();
    expect([...healthStatus.enumValues].sort()).toEqual(["active", "cooldown", "disabled"]);
  });
});

describe("dashboard/backend parity — provider display names", () => {
  test("every built-in provider ID has a friendly dashboard display name", () => {
    for (const providerId of BUNDLED_PROVIDER_IDS) {
      const displayed = providerDisplayName(providerId);
      expect(displayed).not.toBe(providerId);
    }
  });
});

describe("dashboard/backend parity — hand-maintained provider lists", () => {
  const bundled = BUNDLED_PROVIDER_IDS.map((id) => id.toLowerCase());

  test("every bundled provider has an icon asset entry", () => {
    const keys = new Set(parseIconKeys(readFileSync(join(here, "../src/components/ProviderIcon.tsx"), "utf8")));
    const missing = bundled.filter((id) => !keys.has(id));
    expect(missing).toEqual([]);
  });

  test("no free-tier or founding set names an unknown provider", () => {
    const source = readFileSync(join(here, "../src/features/providers/ProvidersPage.tsx"), "utf8");
    const known = new Set(bundled);
    for (const marker of [
      "const FREE_LIMITED_IDS = new Set([",
      "const FREE_AVAILABLE_IDS = new Set([",
      "const FOUNDING_IDS = new Set([",
    ]) {
      const stray = parseSetIds(source, marker).filter((id) => !known.has(id));
      expect(stray).toEqual([]);
    }
  });

  test("the dashboard reset-provider set matches the backend predicate", () => {
    const source = readFileSync(join(here, "../src/hooks/quota.ts"), "utf8");
    const dashboardSet = new Set(parseSetIds(source, "const RESET_PROVIDER_IDS = new Set(["));
    const mismatched = bundled.filter((id) => dashboardSet.has(id) !== supportsAccountReset(id));
    expect(mismatched).toEqual([]);
  });
});

describe("dashboard/backend parity — session contract", () => {
  test("SessionResponse is exactly the backend status response", () => {
    expectTypeOf<SessionResponse>().toEqualTypeOf<SessionStatusResponse>();
  });

  test("SessionUser carries every authenticated field under its dashboard name", () => {
    type WireKeys = keyof Extract<SessionStatusResponse, { status: "authenticated" }>;
    type UserKeys = keyof SessionUser;
    expectTypeOf<UserKeys>().toEqualTypeOf<
      | "id"
      | "username"
      | "email"
      | "displayName"
      | "isFirstBoot"
      | "sessionExpiresAt"
      | "isPlatformAdmin"
    >();
    const wireKeys: readonly WireKeys[] = [
      "status",
      "user_id",
      "username",
      "email",
      "display_name",
      "is_first_boot",
      "session_expires_at",
      "is_platform_admin",
    ];
    expect(wireKeys).toHaveLength(8);
  });

  test("every field the wire arm guarantees is required on SessionUser", () => {
    expectTypeOf<Required<SessionUser>["username"]>().toEqualTypeOf<string>();
    expectTypeOf<SessionUser["displayName"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SessionUser["isFirstBoot"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SessionUser["isPlatformAdmin"]>().toEqualTypeOf<boolean>();
  });
});

describe("dashboard/backend parity — usage constants", () => {
  test("dashboard bypass-proxy hint set matches the backend default set", () => {
    expect([...PROXY_UNSUPPORTED_HINT_PROVIDERS].sort()).toEqual(
      [...DEFAULT_PROXY_BYPASS_PROVIDER_IDS].sort(),
    );
  });

  test("the committed usage-period file matches the backend contract", () => {
    expect(generatedPeriods).toEqual([...BACKEND_USAGE_PERIODS]);
  });
});

describe("dashboard/backend parity — usage dimensions", () => {
  test("the dashboard exports the backend tuple itself, not a copy", () => {
    expect(USAGE_DIMENSIONS).toBe(BACKEND_DIMENSIONS);
    expectTypeOf<UsageDimension>().toEqualTypeOf<BackendUsageDimension>();
  });

  test("the dimension list is exactly what the UI offers", () => {
    expect([...USAGE_DIMENSIONS]).toEqual(["model", "provider", "key", "client", "client_ip"]);
  });
});
