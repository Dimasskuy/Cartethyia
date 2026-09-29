import { describe, expect, test } from "bun:test";

import { cliMappingSourceKeys } from "../../../src/transport/routing/route-catalog";
import { RoutingEngine } from "../../../src/transport/routing/router";
import { InMemoryRouteSnapshotService, type RouteSnapshot } from "../../../src/transport/routing/route-model";

const TENANT_ID = "tenant-a";
const KEY_ID = "key-1";

function snapshot(): RouteSnapshot {
  return {
    revision: 1,
    created_at: Date.now(),
    candidates: [
      {
        provider_id: "workbuddy",
        model_id: "hy4-preview-f",
        wire_family: "chat",
        endpoint: "/v1/chat/completions",
        capability_profile: {},
      },
    ],
    aliases: {},
    cli_aliases: {
      [`${TENANT_ID}:${KEY_ID}`]: { sonnet: "workbuddy/hy4-preview-f" },
    },
    combos: {},
  };
}

describe("CLI model mapping source keys", () => {
  test("maps Claude family slots to versioned client model names", () => {
    expect(cliMappingSourceKeys("claude", "sonnet")).toEqual([
      "sonnet",
      "claude-sonnet-5",
      "claude-sonnet-5-1",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
    ]);
    expect(cliMappingSourceKeys("claude", "claude-sonnet-4-5")).toEqual([
      "claude-sonnet-4-5",
      "sonnet",
      "claude-sonnet-5",
      "claude-sonnet-5-1",
      "claude-sonnet-4-6",
    ]);
  });

  test("does not broaden non-Claude or qualified mappings", () => {
    expect(cliMappingSourceKeys("codex", "sonnet")).toEqual(["sonnet"]);
    expect(cliMappingSourceKeys("claude", "claude/sonnet")).toEqual(["claude/sonnet"]);
  });
});

describe("API-key scoped CLI model mappings", () => {
  test("preserves CLI mappings through the in-memory snapshot cache", async () => {
    const service = new InMemoryRouteSnapshotService(async () => {
      const { revision: _revision, created_at: _createdAt, ...built } = snapshot();
      return built;
    });
    const cached = await service.getSnapshot();
    expect(cached.cli_aliases?.[`${TENANT_ID}:${KEY_ID}`]?.sonnet).toBe("workbuddy/hy4-preview-f");
  });

  test("does not apply CLI mappings without the explicit feature gate", async () => {
    await expect(
      new RoutingEngine().plan("sonnet", snapshot(), TENANT_ID, undefined, false, KEY_ID),
    ).rejects.toMatchObject({
      code: "model_not_found",
    });
  });

  test("applies CLI mappings when the request has the feature gate and key id", async () => {
    const plan = await new RoutingEngine().plan(
      "sonnet",
      snapshot(),
      TENANT_ID,
      undefined,
      true,
      KEY_ID,
    );
    expect(plan.resolved_model).toBe("workbuddy/hy4-preview-f");
  });
});
