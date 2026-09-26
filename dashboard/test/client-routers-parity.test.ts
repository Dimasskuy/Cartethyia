import { describe, expect, test } from "bun:test";
import { CLIENT_ROUTERS, CLIENT_ROUTER_IDS } from "../../src/security/client-router-fingerprint";
import { CLIENT_ROUTER_IDS as DASHBOARD_IDS } from "../src/lib/contracts";

/**
 * The API-key editor renders the routers it offers from `CLIENT_ROUTER_IDS`, and
 * the backend rejects any id it cannot fingerprint. They are the same binding
 * (the dashboard re-exports the backend constant), so this pins that the
 * re-export stays a live reference rather than drifting into a copy — a copy
 * would let the form offer an id the backend then refuses.
 */
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
