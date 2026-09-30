import { describe, expect, test } from "bun:test";

import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ComboDefinition, RouteCandidate } from "../../../src/transport/routing/route-model";
import {
  CASCADE_DEFAULTS,
  extractSurfaceText,
  groupCandidatesByModel,
  parseConfidence,
  resolveCascadeConfig,
  runCascadeCombo,
  stripConfidenceMarker,
  withCascadePrompt,
  type ResolvedCascadeConfig,
} from "../../../src/transport/dispatch/cascade";

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
  return { members: ["cheap/model", "mid/model", "strong/model"], strategy: "cascade", ...(config ? { config } : {}) };
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
  model: "cheap/model",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
});

const DEFAULT_CFG: ResolvedCascadeConfig = {
  confidenceThreshold: CASCADE_DEFAULTS.confidenceThreshold,
  confidencePrompt: CASCADE_DEFAULTS.confidencePrompt,
  escalatePrompt: CASCADE_DEFAULTS.escalatePrompt,
  maxStages: CASCADE_DEFAULTS.maxStages,
};

describe("cascade strategy", () => {
  describe("parseConfidence", () => {
    test("accepts 0-100 at the end of the answer", () => {
      expect(parseConfidence("It is four. CONFIDENCE: 70")).toBe(70);
      expect(parseConfidence("It is four.\nCONFIDENCE: 0")).toBe(0);
      expect(parseConfidence("Done CONFIDENCE:100")).toBe(100);
      expect(parseConfidence("Done confidence: 42")).toBe(42);
    });
    test("rejects out-of-range and malformed markers", () => {
      expect(parseConfidence("Done CONFIDENCE: 101")).toBe(-1);
      expect(parseConfidence("Done CONFIDENCE: abc")).toBe(-1);
      expect(parseConfidence("Done CONFIDENCE:")).toBe(-1);
      expect(parseConfidence("No marker here")).toBe(-1);
    });
    test("ignores markers that are not trailing", () => {
      expect(parseConfidence("CONFIDENCE: 90 is my guess, but done")).toBe(-1);
    });
  });

  describe("stripConfidenceMarker", () => {
    test("removes the trailing marker and trims", () => {
      expect(stripConfidenceMarker("It is four. CONFIDENCE: 70")).toBe("It is four.");
      expect(stripConfidenceMarker("No marker")).toBe("No marker");
    });
  });

  describe("resolveCascadeConfig", () => {
    test("falls back to defaults", () => {
      expect(resolveCascadeConfig(makeCombo())).toEqual(DEFAULT_CFG);
      expect(resolveCascadeConfig(makeCombo(null))).toEqual(DEFAULT_CFG);
      expect(resolveCascadeConfig(makeCombo({}))).toEqual(DEFAULT_CFG);
    });
    test("honors custom values and clamps out-of-range ones", () => {
      const cfg = resolveCascadeConfig(
        makeCombo({ cascade: { confidenceThreshold: 150, maxStages: 99 } }),
      );
      expect(cfg.confidenceThreshold).toBe(100);
      expect(cfg.maxStages).toBe(8);
      const low = resolveCascadeConfig(makeCombo({ cascade: { confidenceThreshold: -5, maxStages: 0 } }));
      expect(low.confidenceThreshold).toBe(0);
      expect(low.maxStages).toBe(1);
    });
    test("blank prompt overrides fall back to defaults", () => {
      const cfg = resolveCascadeConfig(makeCombo({ cascade: { confidencePrompt: "   " } }));
      expect(cfg.confidencePrompt).toBe(CASCADE_DEFAULTS.confidencePrompt);
    });
  });

  describe("withCascadePrompt", () => {
    test("appends the confidence directive to the last user turn and disables streaming", () => {
      const staged = withCascadePrompt(makeRequest({ stream: true }), null, DEFAULT_CFG);
      expect(staged.stream).toBe(false);
      const last = staged.messages[staged.messages.length - 1]!;
      const text = last.content.map((p) => (p.kind === "text" ? p.text : "")).join("");
      expect(text).toContain("What is 2+2?");
      expect(text).toContain(CASCADE_DEFAULTS.confidencePrompt);
    });
    test("escalation stages include the prior answer", () => {
      const staged = withCascadePrompt(
        makeRequest(),
        { text: "The prior answer", model: "cheap/model" },
        DEFAULT_CFG,
      );
      const last = staged.messages[staged.messages.length - 1]!;
      const text = last.content.map((p) => (p.kind === "text" ? p.text : "")).join("");
      expect(text).toContain(CASCADE_DEFAULTS.escalatePrompt);
      expect(text).toContain("The prior answer");
      expect(text).toContain("cheap/model");
    });
    test("does not mutate the original request", () => {
      const original = makeRequest();
      withCascadePrompt(original, null, DEFAULT_CFG);
      expect(original.stream).toBe(false); // already false
      expect(original.messages[0]!.content).toHaveLength(1);
    });
  });

  describe("extractSurfaceText", () => {
    test("chat surface", () => {
      expect(extractSurfaceText("chat", chatBody("hello"))).toBe("hello");
      expect(
        extractSurfaceText("chat", {
          choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }],
        }),
      ).toBe("ab");
    });
    test("messages surface", () => {
      expect(
        extractSurfaceText("messages", {
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", name: "x" },
            { type: "text", text: " there" },
          ],
        }),
      ).toBe("hi there");
    });
    test("responses surface", () => {
      expect(
        extractSurfaceText("responses", {
          output: [
            { type: "reasoning", summary: [] },
            { type: "message", content: [{ type: "output_text", text: "final" }] },
          ],
        }),
      ).toBe("final");
    });
    test("completion surface", () => {
      expect(extractSurfaceText("completion", { choices: [{ text: "tok" }] })).toBe("tok");
    });
    test("malformed bodies yield empty text", () => {
      expect(extractSurfaceText("chat", null)).toBe("");
      expect(extractSurfaceText("chat", { choices: [] })).toBe("");
    });
  });

  describe("groupCandidatesByModel", () => {
    test("groups ordered candidates back into per-member stages", () => {
      const groups = groupCandidatesByModel([
        makeCandidate("a"),
        makeCandidate("a"),
        makeCandidate("b"),
        makeCandidate("c"),
      ]);
      expect(groups.map((g) => g.map((c) => c.model_id))).toEqual([["a", "a"], ["b"], ["c"]]);
    });
  });

  describe("runCascadeCombo", () => {
    const candidates = [makeCandidate("cheap/model"), makeCandidate("mid/model"), makeCandidate("strong/model")];

    test("confident first stage returns immediately", async () => {
      const seen: CanonicalRequest[] = [];
      const dispatch = async (request: CanonicalRequest, group: readonly RouteCandidate[]) => {
        seen.push(request);
        expect(group.map((c) => c.model_id)).toEqual(["cheap/model"]);
        return jsonResponse(chatBody("Four. CONFIDENCE: 95"));
      };
      const response = await runCascadeCombo({
        combo: makeCombo(),
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates,
        requestId: "req-1",
        signal: new AbortController().signal,
        dispatch,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.stream).toBe(false);
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]!.message.content).toBe("Four. CONFIDENCE: 95");
    });

    test("low confidence escalates with the prior answer as context", async () => {
      const seen: CanonicalRequest[] = [];
      const calls: string[][] = [];
      const dispatch = async (request: CanonicalRequest, group: readonly RouteCandidate[]) => {
        seen.push(request);
        calls.push(group.map((c) => c.model_id));
        if (calls.length === 1) return jsonResponse(chatBody("Maybe four. CONFIDENCE: 40"));
        return jsonResponse(chatBody("Definitely four. CONFIDENCE: 99"));
      };
      const response = await runCascadeCombo({
        combo: makeCombo(),
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates,
        requestId: "req-2",
        signal: new AbortController().signal,
        dispatch,
      });
      expect(calls).toEqual([["cheap/model"], ["mid/model"]]);
      const stage2Text = seen[1]!.messages
        .flatMap((m) => m.content)
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      expect(stage2Text).toContain("Maybe four.");
      expect(stage2Text).not.toContain("CONFIDENCE: 40");
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]!.message.content).toContain("Definitely four.");
    });

    test("unknown confidence escalates", async () => {
      let calls = 0;
      const dispatch = async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(chatBody("Four, no marker at all"))
          : jsonResponse(chatBody("Four. CONFIDENCE: 80"));
      };
      await runCascadeCombo({
        combo: makeCombo(),
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates,
        requestId: "req-3",
        signal: new AbortController().signal,
        dispatch,
      });
      expect(calls).toBe(2);
    });

    test("final stage always returns even below threshold", async () => {
      const bodies = [
        chatBody("Guess one. CONFIDENCE: 10"),
        chatBody("Guess two. CONFIDENCE: 20"),
        chatBody("Final answer. CONFIDENCE: 30"),
      ];
      let calls = 0;
      const dispatch = async () => jsonResponse(bodies[calls++ % bodies.length]);
      const response = await runCascadeCombo({
        combo: makeCombo(),
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates,
        requestId: "req-4",
        signal: new AbortController().signal,
        dispatch,
      });
      expect(calls).toBe(3);
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]!.message.content).toContain("Final answer.");
    });

    test("a failed non-final stage escalates instead of failing", async () => {
      const calls: string[][] = [];
      const dispatch = async (_request: CanonicalRequest, group: readonly RouteCandidate[]) => {
        calls.push(group.map((c) => c.model_id));
        if (calls.length === 1) throw new Error("provider down");
        return jsonResponse(chatBody("Recovered. CONFIDENCE: 88"));
      };
      await runCascadeCombo({
        combo: makeCombo(),
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates,
        requestId: "req-5",
        signal: new AbortController().signal,
        dispatch,
      });
      expect(calls).toEqual([["cheap/model"], ["mid/model"]]);
    });

    test("maxStages caps the number of stages", async () => {
      let calls = 0;
      const dispatch = async () => {
        calls += 1;
        return jsonResponse(chatBody("Low. CONFIDENCE: 5"));
      };
      await runCascadeCombo({
        combo: makeCombo({ cascade: { maxStages: 2 } }),
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates,
        requestId: "req-6",
        signal: new AbortController().signal,
        dispatch,
      });
      expect(calls).toBe(2);
    });

    test("stream:true clients get an SSE re-encoding of the winning stage", async () => {
      const dispatch = async () => jsonResponse(chatBody("Streamed answer. CONFIDENCE: 92"));
      const response = await runCascadeCombo({
        combo: makeCombo(),
        comboName: "my-combo",
        canonicalRequest: makeRequest({ stream: true }),
        candidates,
        requestId: "req-7",
        signal: new AbortController().signal,
        dispatch,
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const text = await response.text();
      // The answer arrives chunked ("Stre"+"amed"+" ans"+"wer."), so assert
      // on the pieces rather than the contiguous sentence.
      expect(text).toContain("Stre");
      expect(text).toContain("wer.");
      expect(text).not.toContain("CONFIDENCE");
      expect(text).toContain("[DONE]");
    });

    test("empty candidates throw", async () => {
      await expect(
        runCascadeCombo({
          combo: makeCombo(),
          comboName: "my-combo",
          canonicalRequest: makeRequest(),
          candidates: [],
          requestId: "req-8",
          signal: new AbortController().signal,
          dispatch: async () => jsonResponse(chatBody("x")),
        }),
      ).rejects.toThrow();
    });

    test("threshold 0 accepts any reported confidence; 100 only accepts 100", async () => {
      const zero: number[] = [];
      await runCascadeCombo({
        combo: makeCombo({ cascade: { confidenceThreshold: 0 } }),
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates,
        requestId: "req-9",
        signal: new AbortController().signal,
        dispatch: async () => {
          zero.push(1);
          return jsonResponse(chatBody("Barely. CONFIDENCE: 1"));
        },
      });
      expect(zero).toHaveLength(1);

      const hundred: number[] = [];
      await runCascadeCombo({
        combo: makeCombo({ cascade: { confidenceThreshold: 100 } }),
        comboName: "my-combo",
        canonicalRequest: makeRequest(),
        candidates,
        requestId: "req-10",
        signal: new AbortController().signal,
        dispatch: async () => {
          hundred.push(1);
          return jsonResponse(chatBody(`Try ${hundred.length}. CONFIDENCE: 99`));
        },
      });
      expect(hundred).toHaveLength(3); // 99 < 100 every stage; final stage returns
    });
  });
});
