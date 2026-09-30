import { describe, expect, test } from "bun:test";

import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ComboDefinition, RouteCandidate } from "../../../src/transport/routing/route-model";
import {
  parseSwarmStrategy,
  resolveSwarmConfig,
  runSwarmCombo,
  SWARM_DEFAULTS,
  type SwarmDispatch,
} from "../../../src/transport/dispatch/swarm";

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "my-combo",
    messages: [{ role: "user", content: [{ kind: "text", text: "Build me a todo app." }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
    ...overrides,
  };
}

function makeCombo(config?: ComboDefinition["config"]): ComboDefinition {
  return {
    members: ["a/model", "b/model", "c/model"],
    strategy: "swarm",
    ...(config ? { config } : {}),
  };
}

function makeCandidate(modelId: string): RouteCandidate {
  return {
    provider_id: "openai",
    model_id: modelId,
    account_id: null,
    provider_account_id: null,
    endpoint_path: "/v1/chat/completions",
  } as unknown as RouteCandidate;
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const chatBody = (content: string, model = "a/model") => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
});

function lastUserText(request: CanonicalRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const m = request.messages[i]!;
    if (m.role !== "user") continue;
    return m.content.map((p) => (p.kind === "text" ? p.text : "")).join("\n");
  }
  return "";
}

const STRATEGY_JSON = JSON.stringify({
  assessment: "Build a todo app in three parts.",
  subtasks: [
    { id: 1, title: "Data layer", role: "data-layer", instruction: "Design the todo schema." },
    { id: 2, title: "UI", role: "ui", instruction: "Build the todo list UI." },
    { id: 3, title: "Tests", role: "testing", instruction: "Write tests for the todo app." },
  ],
});

/**
 * Mock dispatch that plays the swarm roles based on the directive marker in
 * the last user turn. `script` controls gatekeeper verdict and failures.
 */
function scriptedDispatch(script: {
  gatekeeper?: string;
  strategy?: string | null;
  workerPrefix?: string;
  failWorkers?: boolean;
}): { dispatch: SwarmDispatch; calls: { text: string; models: string[]; stream: boolean }[] } {
  const calls: { text: string; models: string[]; stream: boolean }[] = [];
  const dispatch: SwarmDispatch = async (request, candidates) => {
    const text = lastUserText(request);
    calls.push({ text, models: candidates.map((c) => c.model_id), stream: request.stream });
    if (text.includes("SWARM GATEKEEPER")) {
      return jsonResponse(chatBody(script.gatekeeper ?? "VERDICT: COMPLEX"));
    }
    if (text.includes("SWARM MANAGER (STRATEGY)")) {
      if (script.strategy === null) return jsonResponse(chatBody("not json at all {{{"));
      return jsonResponse(chatBody(script.strategy ?? STRATEGY_JSON));
    }
    if (text.includes("SWARM WORKER DIRECTIVE")) {
      if (script.failWorkers) throw new Error("worker down");
      const title = (text.match(/Subtask: (.+)/) ?? ["", "work"])[1];
      return jsonResponse(chatBody(`${script.workerPrefix ?? "worker output"}: ${title}`));
    }
    if (text.includes("SWARM STAFF (AUDIT)")) {
      return jsonResponse(chatBody("AUDIT REPORT: all good"));
    }
    if (text.includes("SWARM MANAGER (SYNTHESIS)")) {
      return jsonResponse(chatBody("FINAL ANSWER"));
    }
    return jsonResponse(chatBody("DIRECT ANSWER"));
  };
  return { dispatch, calls };
}

describe("swarm strategy", () => {
  test("resolveSwarmConfig returns defaults for an empty config", () => {
    const cfg = resolveSwarmConfig(makeCombo(), ["a/model", "b/model"]);
    expect(cfg.managerModel).toBe("a/model");
    expect(cfg.staffModel).toBeNull();
    expect(cfg.workerModels).toEqual(["a/model", "b/model"]);
    expect(cfg.workerQuorum).toBe(SWARM_DEFAULTS.workerQuorum);
    expect(cfg.maxWorkers).toBe(SWARM_DEFAULTS.maxWorkers);
  });

  test("resolveSwarmConfig honors explicit roles and clamps numbers", () => {
    const cfg = resolveSwarmConfig(
      makeCombo({
        swarm: {
          managerModel: "c/model",
          staffModel: "b/model",
          workerModels: ["b/model", "nope/model"],
          workerCount: 99,
          stragglerGraceMs: -5,
        },
      }),
      ["a/model", "b/model", "c/model"],
    );
    expect(cfg.managerModel).toBe("c/model");
    expect(cfg.staffModel).toBe("b/model");
    expect(cfg.workerModels).toEqual(["b/model"]);
    expect(cfg.workerCount).toBe(16);
    expect(cfg.stragglerGraceMs).toBe(0);
  });

  test("parseSwarmStrategy parses strict JSON", () => {
    const strategy = parseSwarmStrategy("```json\n" + STRATEGY_JSON + "\n```");
    expect(strategy?.subtasks).toHaveLength(3);
    expect(strategy?.subtasks[0]?.title).toBe("Data layer");
  });

  test("parseSwarmStrategy recovers subtasks from truncated output", () => {
    const truncated = `{"assessment": "x", "subtasks": [{"id": 1, "title": "One", "role": "ui", "instruction": "do one"}, {"id": 2, "title": "Two", "role`;
    const strategy = parseSwarmStrategy(truncated);
    expect(strategy?.subtasks).toHaveLength(1);
    expect(strategy?.assessment).toContain("recovered");
  });

  test("parseSwarmStrategy returns null for garbage", () => {
    expect(parseSwarmStrategy("hello world")).toBeNull();
    expect(parseSwarmStrategy("")).toBeNull();
  });

  test("gatekeeper SIMPLE bypasses the swarm with a direct answer", async () => {
    const { dispatch, calls } = scriptedDispatch({ gatekeeper: "VERDICT: SIMPLE" });
    const response = await runSwarmCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: makeCombo().members.map(makeCandidate),
      requestId: "req-1",
      signal: new AbortController().signal,
      dispatch,
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("DIRECT ANSWER");
    // Only the gatekeeper ran; the direct answer preserved the client stream flag.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.stream).toBe(true);
    expect(calls[1]!.models).toEqual(["a/model"]);
  });

  test("full pipeline: gatekeeper → strategy → workers → audit → synthesis", async () => {
    const { dispatch, calls } = scriptedDispatch({});
    const logs: string[] = [];
    const response = await runSwarmCombo({
      combo: makeCombo({ swarm: { staffModel: "b/model" } }),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: makeCombo().members.map(makeCandidate),
      requestId: "req-1",
      signal: new AbortController().signal,
      dispatch,
      log: (m) => logs.push(m),
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("FINAL ANSWER");

    const kinds = calls.map((c) =>
      c.text.includes("SWARM GATEKEEPER")
        ? "gatekeeper"
        : c.text.includes("SWARM MANAGER (STRATEGY)")
          ? "strategy"
          : c.text.includes("SWARM WORKER DIRECTIVE")
            ? "worker"
            : c.text.includes("SWARM STAFF (AUDIT)")
              ? "audit"
              : c.text.includes("SWARM MANAGER (SYNTHESIS)")
                ? "synthesis"
                : "direct",
    );
    expect(kinds).toEqual(["gatekeeper", "strategy", "worker", "worker", "worker", "audit", "synthesis"]);
    // Workers fan out round-robin across the member pool.
    const workerCalls = calls.filter((c) => c.text.includes("SWARM WORKER DIRECTIVE"));
    expect(workerCalls.map((c) => c.models)).toEqual([["a/model"], ["b/model"], ["c/model"]]);
    // Internal legs are non-streaming; the synthesis preserves the client flag.
    expect(workerCalls.every((c) => c.stream === false)).toBe(true);
    expect(calls.at(-1)!.stream).toBe(true);
    // Audit saw the worker outputs.
    const auditCall = calls.find((c) => c.text.includes("SWARM STAFF (AUDIT)"))!;
    expect(auditCall.text).toContain("worker output: Data layer");
    expect(logs.some((m) => m.includes("synthesizing final answer"))).toBe(true);
  });

  test("audit is skipped without a staff model", async () => {
    const { dispatch, calls } = scriptedDispatch({});
    await runSwarmCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: makeCombo().members.map(makeCandidate),
      requestId: "req-1",
      signal: new AbortController().signal,
      dispatch,
    });
    expect(calls.some((c) => c.text.includes("SWARM STAFF (AUDIT)"))).toBe(false);
    expect(calls.some((c) => c.text.includes("SWARM MANAGER (SYNTHESIS)"))).toBe(true);
  });

  test("unparseable strategy falls back to a direct answer", async () => {
    const { dispatch, calls } = scriptedDispatch({ strategy: null });
    const response = await runSwarmCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: makeCombo().members.map(makeCandidate),
      requestId: "req-1",
      signal: new AbortController().signal,
      dispatch,
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("DIRECT ANSWER");
    expect(calls.some((c) => c.text.includes("SWARM WORKER DIRECTIVE"))).toBe(false);
  });

  test("failed workers fall back to a direct answer", async () => {
    const { dispatch } = scriptedDispatch({ failWorkers: true });
    const response = await runSwarmCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: makeCombo().members.map(makeCandidate),
      requestId: "req-1",
      signal: new AbortController().signal,
      dispatch,
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("DIRECT ANSWER");
  });

  test("workerCount caps the dispatched subtasks", async () => {
    const { dispatch, calls } = scriptedDispatch({});
    await runSwarmCombo({
      combo: makeCombo({ swarm: { workerCount: 2 } }),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: makeCombo().members.map(makeCandidate),
      requestId: "req-1",
      signal: new AbortController().signal,
      dispatch,
    });
    expect(calls.filter((c) => c.text.includes("SWARM WORKER DIRECTIVE"))).toHaveLength(2);
  });

  test("single member without explicit roles dispatches directly", async () => {
    const { dispatch, calls } = scriptedDispatch({});
    const combo: ComboDefinition = { members: ["a/model"], strategy: "swarm" };
    await runSwarmCombo({
      combo,
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: [makeCandidate("a/model")],
      requestId: "req-1",
      signal: new AbortController().signal,
      dispatch,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).not.toContain("SWARM GATEKEEPER");
  });

  test("runSwarmCombo throws 503 with no candidates", async () => {
    const { dispatch } = scriptedDispatch({});
    const run = runSwarmCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: [],
      requestId: "req-1",
      signal: new AbortController().signal,
      dispatch,
    });
    await expect(run).rejects.toMatchObject({ status: 503 });
  });
});
