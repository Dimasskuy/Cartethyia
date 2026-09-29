/**
 * Kiro EventStream interpretation.
 *
 * These pin the two behaviours that are easy to get subtly wrong and that no
 * typecheck catches: a reasoning marker split across two events must still be
 * recognized (and never leak as text), and an unrecognized stop reason must be
 * reported as unknown rather than collapsed into a clean finish.
 */
import { describe, expect, test } from "bun:test";
import {
  KiroStreamDecoder,
  isKiroTruncationReason,
  normalizeKiroStopReason,
} from "../../../../src/providers/integrations/kiro/kiro-stream";

function event(eventType: string, payload: unknown): { headers: Record<string, string>; payload: string | null } {
  return {
    headers: { ":message-type": "event", ":event-type": eventType },
    payload: payload === null ? null : JSON.stringify(payload),
  };
}

describe("normalizeKiroStopReason", () => {
  test("maps the upstream's spellings onto canonical reasons", () => {
    expect(normalizeKiroStopReason("end_turn")).toBe("stop");
    expect(normalizeKiroStopReason("endTurn")).toBe("stop");
    expect(normalizeKiroStopReason("tool_use")).toBe("tool_use");
    expect(normalizeKiroStopReason("toolUse")).toBe("tool_use");
    expect(normalizeKiroStopReason("max_tokens")).toBe("length");
    expect(normalizeKiroStopReason("model_context_window_exceeded")).toBe("length");
  });

  test("reports an unrecognized reason as unknown rather than a clean finish", () => {
    expect(normalizeKiroStopReason("something_new")).toBeUndefined();
    expect(normalizeKiroStopReason(undefined)).toBeUndefined();
  });

  test("recognizes the truncation reasons", () => {
    expect(isKiroTruncationReason("max_tokens")).toBe(true);
    expect(isKiroTruncationReason("model_context_window_exceeded")).toBe(true);
    expect(isKiroTruncationReason("end_turn")).toBe(false);
  });
});

describe("KiroStreamDecoder", () => {
  test("emits a text delta from an assistant response event", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("assistantResponseEvent", { content: "hello" }));
    expect(outcome.deltas).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("emits a reasoning delta from a reasoning event", () => {
    const decoder = new KiroStreamDecoder();
    expect(decoder.decode(event("reasoningContentEvent", { text: "think" })).deltas).toEqual([
      { kind: "reasoning", text: "think" },
    ]);
    expect(decoder.decode(event("reasoningContentEvent", "bare")).deltas).toEqual([
      { kind: "reasoning", text: "bare" },
    ]);
  });

  test("lifts an inline thinking block out of the text channel", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(
      event("assistantResponseEvent", { content: "before<thinking>secret</thinking>after" }),
    );
    expect(outcome.deltas).toEqual([
      { kind: "text", text: "before" },
      { kind: "reasoning", text: "secret" },
      { kind: "text", text: "after" },
    ]);
  });

  test("recognizes a thinking marker split across two events", () => {
    const decoder = new KiroStreamDecoder();
    const first = decoder.decode(event("assistantResponseEvent", { content: "a<thin" }));
    expect(first.deltas).toEqual([{ kind: "text", text: "a" }]);
    const second = decoder.decode(event("assistantResponseEvent", { content: "king>b</thinking>c" }));
    expect(second.deltas).toEqual([
      { kind: "reasoning", text: "b" },
      { kind: "text", text: "c" },
    ]);
  });

  test("never emits a partial marker as text", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("assistantResponseEvent", { content: "text<" }));
    expect(outcome.deltas).toEqual([{ kind: "text", text: "text" }]);
  });

  test("flushes held-back text when the stream ends", () => {
    const decoder = new KiroStreamDecoder();
    decoder.decode(event("assistantResponseEvent", { content: "text<" }));
    expect(decoder.flush()).toEqual([{ kind: "text", text: "<" }]);
  });

  test("emits a tool call with its id, name and serialized arguments", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(
      event("toolUseEvent", { name: "search", toolUseId: "call-1", input: { q: "x" } }),
    );
    expect(outcome.deltas).toEqual([
      { kind: "tool_call", call_id: "call-1", name: "search", arguments_delta: '{"q":"x"}' },
    ]);
  });

  test("skips a tool event missing its name or id", () => {
    const decoder = new KiroStreamDecoder();
    expect(decoder.decode(event("toolUseEvent", { toolUseId: "call-1" })).deltas).toEqual([]);
    expect(decoder.decode(event("toolUseEvent", { name: "search" })).deltas).toEqual([]);
  });

  test("reads a stop reason from the message stop event", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("messageStopEvent", { stopReason: "tool_use" }));
    expect(outcome.stopReason).toBe("tool_use");
    expect(outcome.providerStopReason).toBe("tool_use");
  });

  test("reads a stop reason from the metadata event", () => {
    const decoder = new KiroStreamDecoder();
    expect(decoder.decode(event("metadataEvent", { metadataEvent: { stopReason: "end_turn" } })).stopReason).toBe(
      "stop",
    );
  });

  test("preserves an unknown stop reason as raw rather than reporting a clean finish", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("messageStopEvent", { stopReason: "brand_new_reason" }));
    expect(outcome.stopReason).toBeUndefined();
    expect(outcome.providerStopReason).toBe("brand_new_reason");
  });

  test("reads token usage from the metrics event", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(
      event("metricsEvent", {
        metricsEvent: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
        },
      }),
    );
    expect(outcome.deltas).toEqual([
      {
        kind: "usage",
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 },
      },
    ]);
  });

  test("reads credits and context usage from their own events", () => {
    const decoder = new KiroStreamDecoder();
    expect(decoder.decode(event("meteringEvent", { meteringEvent: { usage: 1.5 } })).deltas).toEqual([
      { kind: "usage", usage: { credits: 1.5 } },
    ]);
    expect(decoder.decode(event("contextUsageEvent", { contextUsagePercentage: 42 })).deltas).toEqual([
      { kind: "usage", usage: { contextUsagePercentage: 42 } },
    ]);
  });

  test("reports an upstream error message instead of a delta", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode({
      headers: { ":message-type": "error" },
      payload: JSON.stringify({ message: "boom" }),
    });
    expect(outcome.failure?.message).toBe("boom");
    expect(outcome.deltas).toEqual([]);
  });

  test("ignores an unknown event type instead of failing the stream", () => {
    const decoder = new KiroStreamDecoder();
    expect(decoder.decode(event("brandNewEvent", { anything: true })).deltas).toEqual([]);
  });
});
