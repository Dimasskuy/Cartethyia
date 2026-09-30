import { describe, expect, test } from "bun:test";

import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ComboDefinition, RouteCandidate } from "../../../src/transport/routing/route-model";
import {
  buildIntentResolver,
  buildSmartRoutingOrder,
  detectResearchHeuristic,
  lastUserMessageText,
  requiresToolCalling,
  resolveSmartRoutingConfig,
  runSmartRoutingCombo,
  type SmartRoutingDispatch,
} from "../../../src/transport/dispatch/smart-routing";

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "my-combo",
    messages: [{ role: "user", content: [{ kind: "text", text: "Hello there." }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

function makeCombo(config?: ComboDefinition["config"]): ComboDefinition {
  return {
    members: ["a/model", "b/model", "c/model"],
    strategy: "smart_routing",
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

const chatBody = (content: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "a/model",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
});

const toolRequest = () =>
  makeRequest({
    tools: [{ type: "function", function: { name: "get_weather", description: "x", parameters: {} } }] as never,
  });

describe("smart-routing strategy", () => {
  test("requiresToolCalling detects tools and tool_choice", () => {
    expect(requiresToolCalling(makeRequest())).toBe(false);
    expect(requiresToolCalling(toolRequest())).toBe(true);
    expect(requiresToolCalling(makeRequest({ tool_choice: "required" }))).toBe(true);
    expect(requiresToolCalling(makeRequest({ tool_choice: "auto" }))).toBe(true);
    expect(requiresToolCalling(makeRequest({ tool_choice: "none" }))).toBe(false);
  });

  test("lastUserMessageText picks the last user turn", () => {
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ kind: "text", text: "First question." }] },
        { role: "assistant", content: [{ kind: "text", text: "First answer." }] },
        { role: "user", content: [{ kind: "text", text: "Second question?" }] },
      ],
    });
    expect(lastUserMessageText(req)).toBe("Second question?");
    expect(lastUserMessageText(makeRequest({ messages: [] }))).toBe("");
  });

  test("detectResearchHeuristic flags keywords and URLs", () => {
    expect(detectResearchHeuristic("please research the latest trends").intent).toBe("research");
    expect(detectResearchHeuristic("summarize https://example.com/article").intent).toBe("research");
    expect(detectResearchHeuristic("what is 2+2?").intent).toBe("general");
    expect(detectResearchHeuristic("").signal).toBe("empty");
  });

  test("resolveSmartRoutingConfig returns defaults for an empty config", () => {
    const cfg = resolveSmartRoutingConfig(makeCombo());
    expect(cfg.toolCallingMembers).toBeNull();
    expect(cfg.noToolMembers).toEqual([]);
    expect(cfg.researchMembers).toEqual([]);
    expect(cfg.classifierModel).toBeNull();
    expect(cfg.confidenceThreshold).toBe(0.6);
  });

  test("tool-calling requests exclude noToolMembers", async () => {
    const order = await buildSmartRoutingOrder({
      request: toolRequest(),
      members: ["a/model", "b/model", "c/model"],
      config: resolveSmartRoutingConfig(makeCombo({ smartRouting: { noToolMembers: ["b/model"] } })),
    });
    expect(order.reason).toBe("tool_calling");
    expect(order.order).toEqual(["a/model", "c/model"]);
  });

  test("tool-calling requests use the explicit toolCallingMembers order", async () => {
    const order = await buildSmartRoutingOrder({
      request: toolRequest(),
      members: ["a/model", "b/model", "c/model"],
      config: resolveSmartRoutingConfig(
        makeCombo({ smartRouting: { toolCallingMembers: ["c/model", "a/model"] } }),
      ),
    });
    expect(order.reason).toBe("tool_calling");
    expect(order.order).toEqual(["c/model", "a/model"]);
  });

  test("empty tool pool degrades to the full member order", async () => {
    const order = await buildSmartRoutingOrder({
      request: toolRequest(),
      members: ["a/model", "b/model"],
      config: resolveSmartRoutingConfig(
        makeCombo({ smartRouting: { noToolMembers: ["a/model", "b/model"] } }),
      ),
    });
    expect(order.reason).toBe("tool_calling_pool_empty_fallback");
    expect(order.order).toEqual(["a/model", "b/model"]);
  });

  test("tool-calling wins over research intent", async () => {
    const req = makeRequest({
      messages: [{ role: "user", content: [{ kind: "text", text: "research the latest news" }] }],
      tools: [{ type: "function", function: { name: "f", description: "x", parameters: {} } }] as never,
    });
    const order = await buildSmartRoutingOrder({
      request: req,
      members: ["a/model", "b/model"],
      config: resolveSmartRoutingConfig(
        makeCombo({ smartRouting: { researchMembers: ["b/model"], noToolMembers: ["b/model"] } }),
      ),
    });
    expect(order.reason).toBe("tool_calling");
    expect(order.order).toEqual(["a/model"]);
  });

  test("research intent prefers researchMembers first", async () => {
    const req = makeRequest({
      messages: [{ role: "user", content: [{ kind: "text", text: "research the latest trends" }] }],
    });
    const order = await buildSmartRoutingOrder({
      request: req,
      members: ["a/model", "b/model", "c/model"],
      config: resolveSmartRoutingConfig(makeCombo({ smartRouting: { researchMembers: ["c/model"] } })),
    });
    expect(order.reason).toBe("research_preferred");
    expect(order.order).toEqual(["c/model", "a/model", "b/model"]);
  });

  test("research without configured members keeps default order", async () => {
    const req = makeRequest({
      messages: [{ role: "user", content: [{ kind: "text", text: "research the latest trends" }] }],
    });
    const order = await buildSmartRoutingOrder({
      request: req,
      members: ["a/model", "b/model"],
      config: resolveSmartRoutingConfig(makeCombo()),
    });
    expect(order.reason).toBe("research_pool_empty");
    expect(order.order).toEqual(["a/model", "b/model"]);
  });

  test("general requests keep the combo member order", async () => {
    const order = await buildSmartRoutingOrder({
      request: makeRequest(),
      members: ["a/model", "b/model"],
      config: resolveSmartRoutingConfig(makeCombo()),
    });
    expect(order.reason).toBe("general");
    expect(order.order).toEqual(["a/model", "b/model"]);
  });

  test("intent resolver escalates ambiguous prompts to the classifier model", async () => {
    const seen: string[] = [];
    const dispatch: SmartRoutingDispatch = async (request, candidates) => {
      const text = request.messages
        .flatMap((m) => m.content)
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      seen.push(`${candidates[0]!.model_id}:${text.slice(0, 20)}`);
      return jsonResponse(chatBody("research"));
    };
    const config = resolveSmartRoutingConfig(
      makeCombo({
        smartRouting: { intentDetection: { llmClassifierFallback: { model: "c/model" } } },
      }),
    );
    const resolveIntent = buildIntentResolver({
      config,
      dispatch,
      candidates: ["a/model", "b/model", "c/model"].map(makeCandidate),
      sourceSurface: "chat",
    });
    // "what is 2+2?" is ambiguous for the heuristic (low confidence) → classifier.
    expect(await resolveIntent("what is 2+2?")).toBe("research");
    expect(seen.some((s) => s.startsWith("c/model:"))).toBe(true);
    // Keyword hits never reach the classifier.
    seen.length = 0;
    expect(await resolveIntent("research the latest trends")).toBe("research");
    expect(seen).toHaveLength(0);
  });

  test("intent resolver degrades to the heuristic when the classifier fails", async () => {
    const dispatch: SmartRoutingDispatch = async () => {
      throw new Error("classifier down");
    };
    const config = resolveSmartRoutingConfig(
      makeCombo({
        smartRouting: { intentDetection: { llmClassifierFallback: { model: "c/model" } } },
      }),
    );
    const resolveIntent = buildIntentResolver({
      config,
      dispatch,
      candidates: ["a/model", "b/model", "c/model"].map(makeCandidate),
      sourceSurface: "chat",
    });
    expect(await resolveIntent("what is 2+2?")).toBe("general");
  });

  test("runSmartRoutingCombo dispatches over the ordered pool", async () => {
    const seenOrders: string[][] = [];
    const reasons: string[] = [];
    const dispatch: SmartRoutingDispatch = async (_request, candidates) => {
      seenOrders.push(candidates.map((c) => c.model_id));
      return jsonResponse(chatBody("done"));
    };
    const combo = makeCombo({ smartRouting: { researchMembers: ["c/model"] } });
    const request = makeRequest({
      messages: [{ role: "user", content: [{ kind: "text", text: "research the latest trends" }] }],
    });
    const logs: string[] = [];
    const response = await runSmartRoutingCombo({
      combo,
      comboName: "my-combo",
      canonicalRequest: request,
      candidates: combo.members.map(makeCandidate),
      requestId: "req-1",
      dispatch,
      log: (m) => {
        logs.push(m);
        reasons.push(m);
      },
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("done");
    expect(seenOrders).toEqual([["c/model", "a/model", "b/model"]]);
    expect(reasons.some((m) => m.includes("reason=research_preferred"))).toBe(true);
  });

  test("runSmartRoutingCombo throws 503 with no candidates", async () => {
    const dispatch: SmartRoutingDispatch = async () => jsonResponse(chatBody("x"));
    const run = runSmartRoutingCombo({
      combo: makeCombo(),
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: [],
      requestId: "req-1",
      dispatch,
    });
    await expect(run).rejects.toMatchObject({ status: 503 });
  });
});
