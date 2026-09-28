import { describe, expect, test } from "bun:test";
import { CodexStreamFrameProcessor, reasoningEvent } from "../../../src/protocol/response/codex";
import type { CanonicalEvent } from "../../../src/transport/canonical-model";

function processFrames(frames: Array<Record<string, unknown>>): CanonicalEvent[] {
  const processor = new CodexStreamFrameProcessor(1);
  const events: CanonicalEvent[] = [];
  for (const frame of frames) events.push(...processor.process(frame));
  return events;
}

function callIds(events: CanonicalEvent[]): Array<[string, string | undefined]> {
  return events
    .filter((event) => event.type === "tool_call_delta")
    .map((event) =>
      event.type === "tool_call_delta" ? [event.call_id, event.name] : ["", undefined],
    );
}

describe("CodexStreamFrameProcessor tool-call identity", () => {
  test("parallel argument deltas resolve their call from output_item.added", () => {
    const events = processFrames([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_0", call_id: "call_a", name: "a", arguments: "" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_b", name: "b", arguments: "" },
      },
      // Stock Responses deltas carry item_id/output_index, never call_id.
      { type: "response.function_call_arguments.delta", item_id: "fc_0", output_index: 0, delta: '{"x":1}' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"y":2}' },
    ]);
    // Before the fix both deltas emitted call_id "call" and merged.
    expect(callIds(events)).toEqual([
      ["call_a", "a"],
      ["call_b", "b"],
    ]);
  });

  test("a delta carrying only output_index still finds its call", () => {
    const events = processFrames([
      {
        type: "response.output_item.added",
        output_index: 3,
        item: { type: "function_call", id: "fc_3", call_id: "call_c", name: "c", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", output_index: 3, delta: "{}" },
    ]);
    expect(callIds(events)).toEqual([["call_c", "c"]]);
  });

  test("an explicit call_id on the delta still wins", () => {
    const events = processFrames([
      { type: "response.function_call_arguments.delta", call_id: "call_x", name: "x", delta: "{}" },
    ]);
    expect(callIds(events)).toEqual([["call_x", "x"]]);
  });

  test("custom-tool input deltas share the same identity resolution", () => {
    const events = processFrames([
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "custom_tool_call", id: "ct_0", call_id: "call_d", name: "d" },
      },
      { type: "response.custom_tool_call_input.delta", item_id: "ct_0", output_index: 2, delta: "raw" },
    ]);
    expect(callIds(events)).toEqual([["call_d", "d"]]);
  });
});

describe("Codex reasoning summary decoding", () => {
  test("multi-part summary array joins with double newlines, not readable payload", () => {
    const event = reasoningEvent(
      {
        type: "reasoning",
        id: "rs_summary",
        summary: [
          { type: "summary_text", text: "A." },
          { type: "summary_text", text: "B." },
        ],
      },
      0,
      4,
    );
    expect(event).toMatchObject({
      type: "content_delta",
      item_id: "rs_summary",
      output_index: 4,
      content: {
        kind: "reasoning",
        payload: null,
        summary: "A.\n\nB.",
      },
    });
  });

  test("does not duplicate visible summary when completed item repeats delta summary", () => {
    const events = processFrames([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        item_id: "rs_1",
        summary_index: 0,
        delta: "Think one",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Think one" }],
          encrypted_content: "encrypted-state",
        },
      },
    ]);
    const visible = events.filter(
      (event) =>
        event.type === "content_delta" &&
        event.content.kind === "reasoning" &&
        event.content.summary !== undefined,
    );
    const encrypted = events.filter(
      (event) =>
        event.type === "content_delta" &&
        event.content.kind === "reasoning" &&
        event.content.encrypted_content === "encrypted-state",
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ content: { payload: null } });
    expect(encrypted).toHaveLength(1);
  });
  test("streamed summary deltas do not become duplicate reasoning-text content", () => {
    const events = processFrames([
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_stream",
        output_index: 2,
        summary_index: 0,
        delta: "visible summary",
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "content_delta",
      item_id: "rs_stream",
      output_index: 2,
      content: {
        kind: "reasoning",
        payload: null,
        summary: "visible summary",
        summary_index: 0,
      },
    });
  });

  test("reasoning_text deltas stay separate from summary parts", () => {
    const events = processFrames([
      {
        type: "response.reasoning_text.delta",
        item_id: "rs_text",
        output_index: 1,
        delta: "readable reasoning",
      },
    ]);
    expect(events[0]).toMatchObject({
      type: "content_delta",
      item_id: "rs_text",
      output_index: 1,
      content: {
        kind: "reasoning",
        payload: "readable reasoning",
      },
    });
    const event = events[0];
    if (event?.type !== "content_delta" || event.content.kind !== "reasoning")
      throw new Error("expected a reasoning content delta");
    expect(event.content.summary).toBeUndefined();
  });
});
