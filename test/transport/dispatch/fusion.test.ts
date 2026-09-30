import { describe, expect, test } from "bun:test";

import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ComboDefinition, RouteCandidate } from "../../../src/transport/routing/route-model";
import {
  buildJudgeDirective,
  collectPanel,
  FUSION_DEFAULTS,
  resolveFusionConfig,
  runFusionCombo,
  withJudgePrompt,
  withPanelRequest,
  type FusionDispatch,
  type ResolvedFusionConfig,
} from "../../../src/transport/dispatch/fusion";

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "my-combo",
    messages: [{ role: "user", content: [{ kind: "text", text: "What is 2+2?" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

function makeCombo(config?: ComboDefinition["config"]): ComboDefinition {
  return { members: ["a/model", "b/model", "c/model"], strategy: "fusion", ...(config ? { config } : {}) };
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

const chatBody = (content: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "a/model",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
});

const DEFAULT_CFG: ResolvedFusionConfig = {
  judgeModel: null,
  minPanel: FUSION_DEFAULTS.minPanel,
  stragglerGraceMs: FUSION_DEFAULTS.stragglerGraceMs,
  panelTimeoutMs: FUSION_DEFAULTS.panelTimeoutMs,
  judgePrompt: null,
};

describe("fusion strategy", () => {
  test("resolveFusionConfig returns defaults for an empty config", () => {
    expect(resolveFusionConfig(makeCombo(), 3)).toEqual(DEFAULT_CFG);
  });

  test("resolveFusionConfig clamps out-of-range knobs", () => {
    const cfg = resolveFusionConfig(
      makeCombo({ fusion: { minPanel: 99, stragglerGraceMs: -5, panelTimeoutMs: 10 } }),
      3,
    );
    expect(cfg.minPanel).toBe(3);
    expect(cfg.stragglerGraceMs).toBe(0);
    expect(cfg.panelTimeoutMs).toBe(1000);
  });

  test("resolveFusionConfig keeps a valid judge model override", () => {
    const cfg = resolveFusionConfig(makeCombo({ fusion: { judgeModel: "c/model" } }), 3);
    expect(cfg.judgeModel).toBe("c/model");
  });

  test("withPanelRequest forces non-streaming and strips tools", () => {
    const req = makeRequest({
      stream: true,
      tools: [{ type: "function", function: { name: "get_weather", description: "x", parameters: {} } }] as never,
      tool_choice: { type: "allowed_tools", mode: "auto", names: ["get_weather"] },
    });
    const panel = withPanelRequest(req);
    expect(panel.stream).toBe(false);
    expect(panel.tools).toBeUndefined();
    expect(panel.tool_choice).toBeUndefined();
    // Original untouched.
    expect(req.stream).toBe(true);
  });

  test("buildJudgeDirective anonymizes sources and never names models", () => {
    const directive = buildJudgeDirective(
      [{ text: "Answer one." }, { text: "Answer two." }],
      null,
    );
    expect(directive).toContain("[Source 1]");
    expect(directive).toContain("[Source 2]");
    expect(directive).toContain("Answer one.");
    expect(directive).toContain("JUDGE");
    expect(directive).not.toContain("a/model");
  });

  test("withJudgePrompt appends the directive to the last user turn", () => {
    const req = makeRequest();
    const judged = withJudgePrompt(req, [{ text: "Panel answer." }], DEFAULT_CFG);
    const last = judged.messages[judged.messages.length - 1]!;
    const text = last.content.map((p) => (p.kind === "text" ? p.text : "")).join("");
    expect(text).toContain("What is 2+2?");
    expect(text).toContain("Panel answer.");
    expect(text).toContain("[Source 1]");
    // Client stream flag and tools preserved for the judge.
    expect(judged.stream).toBe(req.stream);
  });

  test("collectPanel resolves early once quorum + grace elapse", async () => {
    const fast = Promise.resolve(jsonResponse(chatBody("fast")));
    const slow = new Promise<Response>((resolve) =>
      setTimeout(() => resolve(jsonResponse(chatBody("slow"))), 5000),
    );
    const t0 = Date.now();
    const out = await collectPanel([fast, slow], {
      minPanel: 1,
      stragglerGraceMs: 50,
      panelTimeoutMs: 10000,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(out[0]?.status).toBe("ok");
    // The straggler arrived after the panel closed.
    expect(out[1]).toBeUndefined();
  });

  test("collectPanel marks legs that exceed the hard timeout", async () => {
    const hanging = new Promise<Response>(() => {});
    const out = await collectPanel([hanging], {
      minPanel: 1,
      stragglerGraceMs: 0,
      panelTimeoutMs: 50,
    });
    expect(out[0]?.status).toBe("timeout");
  });

  test("runFusionCombo fans out and judges the panel answers", async () => {
    const seen: { model: string; stream: boolean; hasTools: boolean; judgeDirective: boolean }[] = [];
    const dispatch: FusionDispatch = async (request, candidates) => {
      const model = candidates[0]!.model_id;
      const text = request.messages
        .flatMap((m) => m.content)
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      seen.push({
        model,
        stream: request.stream,
        hasTools: request.tools !== undefined,
        judgeDirective: text.includes("=== PANEL RESPONSES ==="),
      });
      if (text.includes("=== PANEL RESPONSES ===")) {
        return jsonResponse(chatBody("Final fused answer."));
      }
      return jsonResponse(chatBody(`Answer from ${model}.`));
    };
    const combo = makeCombo();
    const candidates = combo.members.map(makeCandidate);
    const response = await runFusionCombo({
      combo,
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates,
      requestId: "req-1",
      dispatch,
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("Final fused answer.");
    // 3 panel legs + 1 judge leg.
    expect(seen).toHaveLength(4);
    const panelLegs = seen.filter((s) => !s.judgeDirective);
    expect(panelLegs).toHaveLength(3);
    for (const leg of panelLegs) {
      expect(leg.stream).toBe(false);
      expect(leg.hasTools).toBe(false);
    }
    const judgeLeg = seen.find((s) => s.judgeDirective)!;
    // Judge defaults to the first panel member and keeps client flags.
    expect(judgeLeg.model).toBe("a/model");
    expect(judgeLeg.stream).toBe(false);
  });

  test("runFusionCombo honors a configured judge model", async () => {
    const judges: string[] = [];
    const dispatch: FusionDispatch = async (request, candidates) => {
      const text = request.messages
        .flatMap((m) => m.content)
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      if (text.includes("=== PANEL RESPONSES ===")) judges.push(candidates[0]!.model_id);
      return jsonResponse(chatBody("ok"));
    };
    await runFusionCombo({
      combo: makeCombo({ fusion: { judgeModel: "c/model" } }),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: ["a/model", "b/model", "c/model"].map(makeCandidate),
      requestId: "req-1",
      dispatch,
    });
    expect(judges).toEqual(["c/model"]);
  });

  test("runFusionCombo falls back to the first member when the judge is not in the panel", async () => {
    const judges: string[] = [];
    const dispatch: FusionDispatch = async (request, candidates) => {
      const text = request.messages
        .flatMap((m) => m.content)
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      if (text.includes("=== PANEL RESPONSES ===")) judges.push(candidates[0]!.model_id);
      return jsonResponse(chatBody("ok"));
    };
    await runFusionCombo({
      combo: makeCombo({ fusion: { judgeModel: "nope/model" } }),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: ["a/model", "b/model"].map(makeCandidate),
      requestId: "req-1",
      dispatch,
    });
    expect(judges).toEqual(["a/model"]);
  });

  test("runFusionCombo throws 503 when every panel leg fails", async () => {
    const dispatch: FusionDispatch = async () => {
      throw new Error("provider down");
    };
    const run = runFusionCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: ["a/model", "b/model"].map(makeCandidate),
      requestId: "req-1",
      dispatch,
    });
    await expect(run).rejects.toMatchObject({ status: 503 });
  });

  test("runFusionCombo returns the lone survivor directly for non-streaming requests", async () => {
    const dispatch: FusionDispatch = async (_request, candidates) => {
      if (candidates[0]!.model_id === "a/model") throw new Error("down");
      return jsonResponse(chatBody("Survivor answer."));
    };
    const response = await runFusionCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest({ stream: false }),
      candidates: ["a/model", "b/model"].map(makeCandidate),
      requestId: "req-1",
      dispatch,
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("Survivor answer.");
  });

  test("runFusionCombo re-runs the survivor with stream:true when the client asked for streaming", async () => {
    const streams: boolean[] = [];
    const dispatch: FusionDispatch = async (request, candidates) => {
      streams.push(request.stream);
      if (candidates[0]!.model_id === "a/model" && !request.stream) throw new Error("down");
      return jsonResponse(chatBody("ok"));
    };
    await runFusionCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest({ stream: true }),
      candidates: ["a/model", "b/model"].map(makeCandidate),
      requestId: "req-1",
      dispatch,
    });
    // Panel legs forced non-streaming; the survivor re-run honors stream:true.
    expect(streams).toContain(true);
    expect(streams.filter((s) => !s).length).toBeGreaterThanOrEqual(2);
  });

  test("runFusionCombo with a single member answers directly without judging", async () => {
    let judgeCalls = 0;
    const dispatch: FusionDispatch = async (request) => {
      const text = request.messages
        .flatMap((m) => m.content)
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      if (text.includes("=== PANEL RESPONSES ===")) judgeCalls += 1;
      return jsonResponse(chatBody("Direct answer."));
    };
    const response = await runFusionCombo({
      combo: { members: ["solo/model"], strategy: "fusion" },
      comboName: "solo-combo",
      canonicalRequest: makeRequest(),
      candidates: [makeCandidate("solo/model")],
      requestId: "req-1",
      dispatch,
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("Direct answer.");
    expect(judgeCalls).toBe(0);
  });
});
