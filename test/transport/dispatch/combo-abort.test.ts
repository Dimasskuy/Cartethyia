import { describe, expect, test } from "bun:test";

import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import { GatewayError } from "../../../src/transport/gateway-error";
import type { ComboDefinition, RouteCandidate } from "../../../src/transport/routing/route-model";
import { runCascadeCombo, type CascadeDispatch } from "../../../src/transport/dispatch/cascade";
import { runFusionCombo, type FusionDispatch } from "../../../src/transport/dispatch/fusion";
import { runSwarmCombo, type SwarmDispatch } from "../../../src/transport/dispatch/swarm";

// Regression: combo orchestrators run multi-stage pipelines that outlive any
// single upstream call. They must consult the request's abort signal between
// stages and stop — degrading/escalating after a cancellation would launch
// upstream calls nobody will ever read and keep the request alive in
// Live Activity.

function makeRequest(): CanonicalRequest {
  return {
    model: "my-combo",
    messages: [{ role: "user", content: [{ kind: "text", text: "Build me a todo app." }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
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

function requestText(request: CanonicalRequest): string {
  return request.messages
    .flatMap((m) => m.content)
    .map((p) => (p.kind === "text" ? p.text : ""))
    .join("");
}

function abortedSignal(): { signal: AbortSignal; controller: AbortController } {
  const controller = new AbortController();
  controller.abort(new DOMException("client gone", "AbortError"));
  return { signal: controller.signal, controller };
}

async function expectTransportClosed(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).code).toBe("transport_closed");
  expect((error as GatewayError).status).toBe(499);
}

describe("combo abort hygiene", () => {
  test("swarm: a cancelled request never starts — no upstream call at all", async () => {
    let calls = 0;
    const dispatch: SwarmDispatch = async () => {
      calls += 1;
      return jsonResponse(chatBody("x"));
    };
    const combo: ComboDefinition = { members: ["a/model", "b/model"], strategy: "swarm" };
    await expectTransportClosed(
      runSwarmCombo({
        combo,
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates: combo.members.map(makeCandidate),
        requestId: "req-abort-1",
        dispatch,
        signal: abortedSignal().signal,
      }),
    );
    expect(calls).toBe(0);
  });

  test("swarm: abort between gatekeeper and manager stops the pipeline — no fallback dispatch", async () => {
    const controller = new AbortController();
    let calls = 0;
    const dispatch: SwarmDispatch = async (request) => {
      calls += 1;
      const text = requestText(request);
      if (text.includes("SWARM GATEKEEPER")) {
        // The client disconnects while the gatekeeper verdict is read.
        controller.abort(new DOMException("client gone", "AbortError"));
        return jsonResponse(chatBody("VERDICT: COMPLEX"));
      }
      return jsonResponse(chatBody("SHOULD NOT HAPPEN"));
    };
    const combo: ComboDefinition = { members: ["a/model", "b/model"], strategy: "swarm" };
    await expectTransportClosed(
      runSwarmCombo({
        combo,
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates: combo.members.map(makeCandidate),
        requestId: "req-abort-2",
        dispatch,
        signal: controller.signal,
      }),
    );
    // Only the gatekeeper call happened; no manager strategy, no direct-answer
    // fallback after cancellation.
    expect(calls).toBe(1);
  });

  test("cascade: a cancelled request never starts — no upstream call at all", async () => {
    let calls = 0;
    const dispatch: CascadeDispatch = async () => {
      calls += 1;
      return jsonResponse(chatBody("x"));
    };
    const combo: ComboDefinition = { members: ["cheap/model", "mid/model"], strategy: "cascade" };
    await expectTransportClosed(
      runCascadeCombo({
        combo,
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates: combo.members.map(makeCandidate),
        requestId: "req-abort-3",
        dispatch,
        signal: abortedSignal().signal,
      }),
    );
    expect(calls).toBe(0);
  });

  test("cascade: a stage failure after cancellation escalates nowhere — the error propagates", async () => {
    const controller = new AbortController();
    let calls = 0;
    const dispatch: CascadeDispatch = async () => {
      calls += 1;
      controller.abort(new DOMException("client gone", "AbortError"));
      throw new Error("provider down");
    };
    const combo: ComboDefinition = { members: ["cheap/model", "mid/model"], strategy: "cascade" };
    const error = await runCascadeCombo({
      combo,
      comboName: "my-combo",
      canonicalRequest: makeRequest(),
      candidates: combo.members.map(makeCandidate),
      requestId: "req-abort-4",
      dispatch,
      signal: controller.signal,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    // The original stage error surfaces; cascade does not escalate to the
    // next member once the request is gone.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("provider down");
    expect(calls).toBe(1);
  });

  test("fusion: a cancelled request never starts — no upstream call at all", async () => {
    let calls = 0;
    const dispatch: FusionDispatch = async () => {
      calls += 1;
      return jsonResponse(chatBody("x"));
    };
    const combo: ComboDefinition = { members: ["a/model", "b/model"], strategy: "fusion" };
    await expectTransportClosed(
      runFusionCombo({
        combo,
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates: combo.members.map(makeCandidate),
        requestId: "req-abort-5",
        dispatch,
        signal: abortedSignal().signal,
      }),
    );
    expect(calls).toBe(0);
  });

  test("fusion: abort after the panel stops the judge — answers are not synthesized for nobody", async () => {
    const controller = new AbortController();
    let judgeCalls = 0;
    const dispatch: FusionDispatch = async (request, candidates) => {
      const text = requestText(request);
      if (text.includes("=== PANEL RESPONSES ===")) {
        judgeCalls += 1;
        return jsonResponse(chatBody("Final fused answer."));
      }
      controller.abort(new DOMException("client gone", "AbortError"));
      return jsonResponse(chatBody(`Answer from ${candidates[0]!.model_id}.`));
    };
    const combo: ComboDefinition = { members: ["a/model", "b/model"], strategy: "fusion" };
    await expectTransportClosed(
      runFusionCombo({
        combo,
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates: combo.members.map(makeCandidate),
        requestId: "req-abort-6",
        dispatch,
        signal: controller.signal,
      }),
    );
    expect(judgeCalls).toBe(0);
  });
});
