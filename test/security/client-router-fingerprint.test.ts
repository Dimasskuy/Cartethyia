import { describe, expect, test } from "bun:test";
import {
  CLIENT_ROUTERS,
  CLIENT_ROUTER_IDS,
  deniedClientRouter,
  detectClientRouter,
  normalizeClientRouterId,
} from "../../src/security/client-router-fingerprint";

/**
 * A genuine Claude Code client's header set, transcribed from captured traffic.
 * It is the baseline the detector must never label: these are the exact values
 * the routers imitate, so a false positive here would refuse a real customer.
 */
const GENUINE_CLAUDE_CODE = {
  "user-agent": "claude-cli/2.1.0 (external, cli)",
  "x-anthropic-billing-header": "cc_version=2.1.0; cc_entrypoint=cli; cch=00000;",
  "x-claude-code-session-id": "3f9a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
  "anthropic-beta": "claude-code-20250219",
  "x-app": "cli",
};

/** A genuine Cline client's header set, also from captured traffic. */
const GENUINE_CLINE = {
  "user-agent": "Cline/3.0.58",
  "x-client-type": "Cline/3.0.58",
  "x-title": "Cline",
  "x-is-multiroot": "false",
};

describe("client-router fingerprint detection", () => {
  test("labels 9Router from its product headers", () => {
    expect(detectClientRouter({ headers: { "x-msh-platform": "9router" } })?.routerId).toBe("9router");
    expect(detectClientRouter({ headers: { "x-client-type": "9router" } })?.routerId).toBe("9router");
  });

  test("labels 9Router from a User-Agent naming it", () => {
    expect(detectClientRouter({ headers: { "user-agent": "9Router/0.5.81" } })?.routerId).toBe(
      "9router",
    );
    expect(detectClientRouter({ headers: { "user-agent": "9router/zed" } })?.routerId).toBe(
      "9router",
    );
  });

  test("labels OmniRoute from its product headers and rewritten User-Agent", () => {
    expect(
      detectClientRouter({ headers: { "x-omniroute-peer-trace": "instance-a" } })?.routerId,
    ).toBe("omniroute");
    expect(
      detectClientRouter({ headers: { "x-omniroute-fallback-hint": "connection_cooldown" } })
        ?.routerId,
    ).toBe("omniroute");
    expect(
      detectClientRouter({
        headers: { "user-agent": "Mozilla/5.0 (compatible; OpenAI Compatible)" },
      })?.routerId,
    ).toBe("omniroute");
  });

  test("does not label a genuine first-party CLI", () => {
    // The routers imitate these exact values, so matching any of them would
    // refuse the real client. This is the regression that removed the
    // "corroborating" tier: an earlier revision labelled this request.
    expect(detectClientRouter({ headers: GENUINE_CLAUDE_CODE })).toBeNull();
    expect(detectClientRouter({ headers: GENUINE_CLINE })).toBeNull();
  });

  test("does not label an ordinary SDK or unknown caller", () => {
    expect(detectClientRouter({ headers: {} })).toBeNull();
    expect(detectClientRouter({ headers: { "user-agent": "Bun/1.4.2" } })).toBeNull();
    expect(detectClientRouter({ headers: { "user-agent": "node" } })).toBeNull();
    expect(
      detectClientRouter({ headers: { "user-agent": "python-requests/2.31.0" } }),
    ).toBeNull();
    // A Cline `x-client-type` exists but names Cline, not a router.
    expect(detectClientRouter({ headers: { "x-client-type": "Cline/3.0.58" } })).toBeNull();
  });

  test("matches header names case-insensitively and reads a Headers instance", () => {
    expect(detectClientRouter({ headers: { "X-Msh-Platform": "9Router" } })?.routerId).toBe(
      "9router",
    );
    const headers = new Headers({ "x-omniroute-peer-trace": "abc" });
    expect(detectClientRouter({ headers })?.routerId).toBe("omniroute");
  });

  test("reports the signals that matched, for the operator's audit", () => {
    const match = detectClientRouter({
      headers: { "x-msh-platform": "9router", "user-agent": "9Router/0.5.81" },
    });
    expect(match?.label).toBe("9Router");
    expect(match?.signals.map((signal) => signal.field).sort()).toEqual([
      "user-agent",
      "x-msh-platform",
    ]);
  });

  test("ignores an empty header value rather than treating presence as a match", () => {
    expect(detectClientRouter({ headers: { "x-omniroute-peer-trace": "" } })).toBeNull();
  });
});

describe("client-router denylist", () => {
  test("denies the labelled router when the id is listed", () => {
    const match = detectClientRouter({ headers: { "x-msh-platform": "9router" } });
    expect(deniedClientRouter(["9router"], match)).toBe("9Router");
    expect(deniedClientRouter(new Set(["9router"]), match)).toBe("9Router");
  });

  test("allows a router that is not listed", () => {
    const match = detectClientRouter({ headers: { "x-msh-platform": "9router" } });
    expect(deniedClientRouter(["omniroute"], match)).toBeNull();
    expect(deniedClientRouter([], match)).toBeNull();
    expect(deniedClientRouter(null, match)).toBeNull();
    expect(deniedClientRouter(undefined, match)).toBeNull();
  });

  test("does not deny when nothing was labelled", () => {
    expect(deniedClientRouter(["9router", "omniroute"], null)).toBeNull();
  });
});

describe("client-router vocabulary", () => {
  test("normalizes ids and rejects unknown ones", () => {
    expect(normalizeClientRouterId("  9ROUTER ")).toBe("9router");
    expect(normalizeClientRouterId("OmniRoute")).toBe("omniroute");
    expect(normalizeClientRouterId("not-a-router")).toBeUndefined();
    expect(normalizeClientRouterId("")).toBeUndefined();
  });

  test("exposes the ids the dashboard offers", () => {
    expect(CLIENT_ROUTER_IDS).toEqual(["9router", "omniroute"]);
    expect(CLIENT_ROUTERS.every((router) => router.signals.length > 0)).toBe(true);
  });
});
