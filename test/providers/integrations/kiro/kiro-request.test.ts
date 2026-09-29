/**
 * Kiro wire-payload construction.
 *
 * The upstream answers a malformed conversation with a terminal 400 that cools
 * every account, so the properties worth pinning are the ones that keep a
 * request out of that class: the ledger alternates and ends on the user turn,
 * a tool call and its result share one id, the system text travels as a prefix
 * rather than a field of its own, and names/ids fit the lengths the wire allows.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import {
  KIRO_THINKING_BUDGET_DEFAULT,
  KIRO_TOOL_ID_MAX_LENGTH,
  KIRO_TOOL_NAME_MAX_LENGTH,
  buildKiroWireRequest,
  buildThinkingMarker,
  kiroThinkingBudgetForEffort,
  normalizeJsonSchema,
} from "../../../../src/providers/integrations/kiro/kiro-request";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-sonnet-4.5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
    ...overrides,
  };
}

function build(
  overrides: Partial<CanonicalRequest> = {},
  options: Partial<Parameters<typeof buildKiroWireRequest>[1]> = {},
) {
  return buildKiroWireRequest(request(overrides), {
    conversationId: "conv-1",
    modelId: "claude-sonnet-4.5",
    profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/AAA",
    ...options,
  });
}

/** Reads the payload of a successful build, failing loudly on a refusal. */
function payloadOf(result: ReturnType<typeof build>): Record<string, unknown> {
  if (!result.ok) throw new Error(`expected a payload, got problems: ${result.error.problems.join(", ")}`);
  return result.value.payload;
}

describe("buildKiroWireRequest", () => {
  test("wraps a single user turn in conversationState with the profile", () => {
    const payload = payloadOf(build());
    const state = payload.conversationState as Record<string, unknown>;
    expect(state.chatTriggerType).toBe("MANUAL");
    expect(state.conversationId).toBe("conv-1");
    expect(state.history).toEqual([]);
    expect(payload.profileArn).toBe("arn:aws:codewhisperer:us-east-1:1:profile/AAA");
    const current = state.currentMessage as { userInputMessage: Record<string, unknown> };
    expect(current.userInputMessage.origin).toBe("AI_EDITOR");
    expect(current.userInputMessage.modelId).toBe("claude-sonnet-4.5");
    expect(String(current.userInputMessage.content)).toContain("hello");
  });

  test("carries no top-level systemPrompt field", () => {
    const payload = payloadOf(build({ system: [{ kind: "text", text: "be brief" }] }));
    expect(payload).not.toHaveProperty("systemPrompt");
    const state = payload.conversationState as { currentMessage: { userInputMessage: { content: string } } };
    expect(state.currentMessage.userInputMessage.content).toContain("be brief");
  });

  test("puts the system prefix on the opening turn of a multi-turn ledger", () => {
    const payload = payloadOf(
      build({
        system: [{ kind: "text", text: "be brief" }],
        messages: [
          { role: "user", content: [{ kind: "text", text: "first" }] },
          { role: "assistant", content: [{ kind: "text", text: "answer" }] },
          { role: "user", content: [{ kind: "text", text: "second" }] },
        ],
      }),
    );
    const state = payload.conversationState as {
      history: { userInputMessage?: { content: string } }[];
      currentMessage: { userInputMessage: { content: string } };
    };
    expect(state.history).toHaveLength(2);
    expect(state.history[0]?.userInputMessage?.content).toContain("be brief");
    expect(state.history[0]?.userInputMessage?.content).toContain("first");
    // The prefix is not repeated on the live turn.
    expect(state.currentMessage.userInputMessage.content).not.toContain("be brief");
    expect(state.currentMessage.userInputMessage.content).toContain("second");
  });

  test("keeps the cached prefix byte-identical across turns", () => {
    // The opening turn is the prefix the upstream caches, so it must not carry
    // anything that changes per request. A time line in there made every request
    // differ at the first turn, so nothing after it could ever be reused and the
    // whole conversation was re-read each turn.
    const first = payloadOf(
      build({
        system: [{ kind: "text", text: "be brief" }],
        messages: [
          { role: "user", content: [{ kind: "text", text: "first" }] },
          { role: "assistant", content: [{ kind: "text", text: "answer" }] },
          { role: "user", content: [{ kind: "text", text: "second" }] },
        ],
      }),
    );
    const opening = (
      first.conversationState as { history: { userInputMessage?: { content: string } }[] }
    ).history[0]?.userInputMessage?.content;
    expect(opening).toContain("be brief");
    expect(opening).toContain("first");
    // No volatile value in the cached turn.
    expect(opening).not.toContain("Current time is");

    // The volatile line belongs on the live turn, where new bytes are expected.
    const current = (first.conversationState as { currentMessage: { userInputMessage: { content: string } } })
      .currentMessage.userInputMessage.content;
    expect(current).toContain("Current time is");
    expect(current).toContain("second");
  });

  test("omits the profileArn field when the account resolved none", () => {
    const payload = payloadOf(build({}, { profileArn: "" }));
    expect(payload).not.toHaveProperty("profileArn");
  });

  test("refuses a tool call whose name the request never defined", () => {
    const result = build({
      messages: [
        { role: "user", content: [{ kind: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ kind: "toolCall", call_id: "c1", name: "missing_tool", arguments: {} }],
        },
        { role: "tool", content: [{ kind: "toolResult", call_id: "c1", content: "ok" }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.problems.some((problem) => problem.startsWith("spec:"))).toBe(true);
  });

  test("refuses a tool result whose call never appeared", () => {
    const result = build({
      messages: [
        { role: "user", content: [{ kind: "text", text: "go" }] },
        { role: "tool", content: [{ kind: "toolResult", call_id: "orphan", content: "ok" }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.problems.some((problem) => problem.startsWith("pair:"))).toBe(true);
  });

  test("sends a tool call and its result under one shared id", () => {
    const payload = payloadOf(
      build({
        tools: [
          {
            name: "search",
            description: "search things",
            jsonSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
        messages: [
          { role: "user", content: [{ kind: "text", text: "go" }] },
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "call-1", name: "search", arguments: { q: "x" } }],
          },
          { role: "tool", content: [{ kind: "toolResult", call_id: "call-1", content: "found" }] },
          { role: "user", content: [{ kind: "text", text: "next" }] },
        ],
      }),
    );
    const state = payload.conversationState as {
      history: {
        assistantResponseMessage?: { toolUses?: { toolUseId: string; name: string }[] };
      }[];
      currentMessage: {
        userInputMessage: { userInputMessageContext?: { toolResults?: { toolUseId: string }[] } };
      };
    };
    const assistantTurn = state.history.find((turn) => turn.assistantResponseMessage !== undefined);
    const callId = assistantTurn?.assistantResponseMessage?.toolUses?.[0]?.toolUseId;
    // The result turn merged with the following user turn, so it is the live
    // turn — and its id must still be the one the call reserved.
    const resultId = state.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0]?.toolUseId;
    expect(callId).toBe("call-1");
    expect(resultId).toBe(callId);
    expect(assistantTurn?.assistantResponseMessage?.toolUses?.[0]?.name).toBe("search");
  });

  test("rewrites an unsupported tool name and reports the mapping for restoration", () => {
    const result = build({
      tools: [{ name: "my.tool/search", description: "d", jsonSchema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ kind: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ kind: "toolCall", call_id: "c1", name: "my.tool/search", arguments: {} }],
        },
        { role: "tool", content: [{ kind: "toolResult", call_id: "c1", content: "ok" }] },
        { role: "user", content: [{ kind: "text", text: "next" }] },
      ],
    });
    if (!result.ok) throw new Error("expected a payload");
    const state = result.value.payload.conversationState as {
      history: { assistantResponseMessage?: { toolUses?: { name: string }[] } }[];
    };
    const assistantTurn = state.history.find((turn) => turn.assistantResponseMessage !== undefined);
    expect(assistantTurn?.assistantResponseMessage?.toolUses?.[0]?.name).toBe("my_tool_search");
    expect(result.value.toolNameMap.get("my_tool_search")).toBe("my.tool/search");
  });

  test("caps a tool name at the wire limit in code points", () => {
    const longName = "t".repeat(200);
    const payload = payloadOf(
      build({ tools: [{ name: longName, description: "d", jsonSchema: { type: "object" } }] }),
    );
    const state = payload.conversationState as {
      currentMessage: {
        userInputMessage: { userInputMessageContext?: { tools?: { toolSpecification: { name: string } }[] } };
      };
    };
    const name = state.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]?.toolSpecification.name;
    expect(name).toBeDefined();
    expect([...(name ?? "")].length).toBe(KIRO_TOOL_NAME_MAX_LENGTH);
  });

  test("gives a long tool the same wire name whatever order it appears in", () => {
    // Truncating a long name makes the wire name depend on the tool's position:
    // the second tool that truncates to the same prefix is the one that gets
    // renamed. A caller that reorders its tools would then see the same tool
    // called by two different names across turns, and a tool call already in the
    // ledger would name a tool the next request no longer declares.
    const shared = "t".repeat(KIRO_TOOL_NAME_MAX_LENGTH);
    const alpha = { name: `${shared}_alpha`, description: "d", jsonSchema: { type: "object" } };
    const beta = { name: `${shared}_beta`, description: "d", jsonSchema: { type: "object" } };
    const namesFor = (tools: readonly (typeof alpha)[]): readonly string[] => {
      const payload = payloadOf(build({ tools }));
      const state = payload.conversationState as {
        currentMessage: {
          userInputMessage: { userInputMessageContext?: { tools?: { toolSpecification: { name: string } }[] } };
        };
      };
      return (state.currentMessage.userInputMessage.userInputMessageContext?.tools ?? []).map(
        (tool) => tool.toolSpecification.name,
      );
    };

    const forward = namesFor([alpha, beta]);
    const reversed = namesFor([beta, alpha]);
    expect(forward).toHaveLength(2);
    expect(forward[0]).not.toBe(forward[1]);
    expect(reversed).toHaveLength(2);
    // The same tool keeps its own wire name in both orders.
    expect(reversed[1]).toBe(forward[0]);
    expect(reversed[0]).toBe(forward[1]);
    for (const name of [...forward, ...reversed]) {
      expect([...name].length).toBeLessThanOrEqual(KIRO_TOOL_NAME_MAX_LENGTH);
    }
  });

  test("caps a tool id at the wire limit", () => {
    const longId = "i".repeat(200);
    const payload = payloadOf(
      build({
        tools: [{ name: "t", description: "d", jsonSchema: { type: "object" } }],
        messages: [
          { role: "user", content: [{ kind: "text", text: "go" }] },
          { role: "assistant", content: [{ kind: "toolCall", call_id: longId, name: "t", arguments: {} }] },
          { role: "tool", content: [{ kind: "toolResult", call_id: longId, content: "ok" }] },
          { role: "user", content: [{ kind: "text", text: "next" }] },
        ],
      }),
    );
    const state = payload.conversationState as {
      history: { assistantResponseMessage?: { toolUses?: { toolUseId: string }[] } }[];
    };
    const assistantTurn = state.history.find((turn) => turn.assistantResponseMessage !== undefined);
    const id = assistantTurn?.assistantResponseMessage?.toolUses?.[0]?.toolUseId ?? "";
    expect([...id].length).toBe(KIRO_TOOL_ID_MAX_LENGTH);
  });

  test("merges adjacent user turns instead of emitting a broken alternation", () => {
    const payload = payloadOf(
      build({
        messages: [
          { role: "user", content: [{ kind: "text", text: "one" }] },
          { role: "user", content: [{ kind: "text", text: "two" }] },
          { role: "assistant", content: [{ kind: "text", text: "answer" }] },
          { role: "user", content: [{ kind: "text", text: "three" }] },
        ],
      }),
    );
    const state = payload.conversationState as {
      history: { userInputMessage?: { content: string } }[];
    };
    expect(state.history).toHaveLength(2);
    expect(state.history[0]?.userInputMessage?.content).toContain("one");
    expect(state.history[0]?.userInputMessage?.content).toContain("two");
  });

  test("appends a user turn when the conversation ends on an assistant turn", () => {
    const payload = payloadOf(
      build({
        messages: [
          { role: "user", content: [{ kind: "text", text: "hi" }] },
          { role: "assistant", content: [{ kind: "text", text: "done" }] },
        ],
      }),
    );
    const state = payload.conversationState as {
      history: { userInputMessage?: { content: string }; assistantResponseMessage?: { content: string } }[];
      currentMessage: { userInputMessage: { content: string } };
    };
    // The closing assistant turn stays in the ledger and a synthetic user turn
    // becomes the live one: the upstream requires the request to end on a user.
    expect(state.history).toHaveLength(2);
    expect(state.history[1]?.assistantResponseMessage?.content).toBe("done");
    expect(state.currentMessage.userInputMessage.content.length).toBeGreaterThan(0);
  });

  test("places tool definitions only on the current turn", () => {
    const payload = payloadOf(
      build({
        tools: [{ name: "t", description: "d", jsonSchema: { type: "object" } }],
        messages: [
          { role: "user", content: [{ kind: "text", text: "a" }] },
          { role: "assistant", content: [{ kind: "text", text: "b" }] },
          { role: "user", content: [{ kind: "text", text: "c" }] },
        ],
      }),
    );
    const state = payload.conversationState as {
      history: { userInputMessage?: { userInputMessageContext?: { tools?: unknown[] } } }[];
      currentMessage: {
        userInputMessage: { userInputMessageContext?: { tools?: unknown[] } };
      };
    };
    for (const turn of state.history) {
      expect(turn.userInputMessage?.userInputMessageContext?.tools).toBeUndefined();
    }
    expect(state.currentMessage.userInputMessage.userInputMessageContext?.tools).toHaveLength(1);
  });

  test("sends the thinking marker and no effort field when no effort path is set", () => {
    const payload = payloadOf(build({}, { thinkingBudget: 8192 }));
    expect(payload).not.toHaveProperty("additionalModelRequestFields");
    const state = payload.conversationState as { currentMessage: { userInputMessage: { content: string } } };
    expect(state.currentMessage.userInputMessage.content).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(state.currentMessage.userInputMessage.content).toContain("<max_thinking_length>8192</max_thinking_length>");
  });

  test("sends the Claude effort schema on the output_config path", () => {
    const payload = payloadOf(build({}, { effort: "high", effortPath: "output_config" }));
    expect(payload.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  test("collapses xhigh onto high for the Claude effort schema", () => {
    const payload = payloadOf(build({}, { effort: "xhigh", effortPath: "output_config" }));
    expect(payload.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  test("sends the GPT effort schema on the reasoning path", () => {
    const payload = payloadOf(build({}, { effort: "medium", effortPath: "reasoning" }));
    expect(payload.additionalModelRequestFields).toEqual({ reasoning: { effort: "medium" } });
  });

  test("maps max onto xhigh and minimal onto low for the GPT effort schema", () => {
    expect(payloadOf(build({}, { effort: "max", effortPath: "reasoning" })).additionalModelRequestFields).toEqual({
      reasoning: { effort: "xhigh" },
    });
    expect(
      payloadOf(build({}, { effort: "minimal", effortPath: "reasoning" })).additionalModelRequestFields,
    ).toEqual({ reasoning: { effort: "low" } });
  });

  test("never forwards generation controls the upstream has no field for", () => {
    // The generation surface takes no maxTokens/temperature/topP; it reports a
    // budget overrun through a truncation frame instead. Sending an unsupported
    // field is a request the real client never produces.
    const payload = payloadOf(
      build({ generation_controls: { max_output_tokens: 4096, temperature: 0.5, top_p: 0.9 } }),
    );
    expect(payload).not.toHaveProperty("inferenceConfig");
    expect(payload).not.toHaveProperty("maxTokens");
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("topP");
  });

  test("declares the agent task type that matches whether tools are attached", () => {
    const withTools = payloadOf(
      build({ tools: [{ name: "t", description: "d", jsonSchema: { type: "object" } }] }),
    );
    const state = withTools.conversationState as Record<string, unknown>;
    expect(state.agentTaskType).toBe("spectask");
    const withoutTools = payloadOf(build());
    expect((withoutTools.conversationState as Record<string, unknown>).agentTaskType).toBe("vibe");
  });

  test("sends a fresh continuation id per request, distinct from the conversation id", () => {
    const first = payloadOf(build());
    const second = payloadOf(build());
    const a = first.conversationState as Record<string, unknown>;
    const b = second.conversationState as Record<string, unknown>;
    expect(typeof a.agentContinuationId).toBe("string");
    expect(a.agentContinuationId).not.toBe(b.agentContinuationId);
    expect(a.agentContinuationId).not.toBe(a.conversationId);
  });

  test("carries a bare data-URL string, which the Responses wire produces", () => {
    const payload = payloadOf(
      build({
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "look" },
              { kind: "image", payload: "data:image/jpeg;base64,AAAA" },
            ],
          },
        ],
      }),
    );
    const state = payload.conversationState as {
      currentMessage: { userInputMessage: { images?: { format: string; source: { bytes: string } }[] } };
    };
    expect(state.currentMessage.userInputMessage.images).toEqual([
      { format: "jpeg", source: { bytes: "AAAA" } },
    ]);
  });

  test("carries the image an OpenAI Chat caller sends, which arrives as a data URL", () => {
    // This is the shape every Chat Completions caller produces, including the
    // dashboard: `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}`.
    // A resolver that recognised only the `{media_type, data}` spelling dropped
    // it silently, and the model answered "I don't see any image attached" for a
    // request that carried one.
    const payload = payloadOf(
      build({
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "what colour?" },
              {
                kind: "image",
                payload: { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
              },
            ],
          },
        ],
      }),
    );
    const state = payload.conversationState as {
      currentMessage: { userInputMessage: { images?: { format: string; source: { bytes: string } }[] } };
    };
    expect(state.currentMessage.userInputMessage.images).toEqual([
      { format: "png", source: { bytes: "BBBB" } },
    ]);
  });

  test("carries the image an Anthropic Messages caller sends", () => {
    const payload = payloadOf(
      build({
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "what colour?" },
              {
                kind: "image",
                payload: { type: "image", source: { type: "base64", media_type: "image/webp", data: "CCCC" } },
              },
            ],
          },
        ],
      }),
    );
    const state = payload.conversationState as {
      currentMessage: { userInputMessage: { images?: { format: string; source: { bytes: string } }[] } };
    };
    expect(state.currentMessage.userInputMessage.images).toEqual([
      { format: "webp", source: { bytes: "CCCC" } },
    ]);
  });

  test("keeps images that arrive on a merged turn instead of dropping all but the last", () => {
    // Two user turns in a row are merged into one, and the images on the earlier
    // turn must survive the merge: reading them from the last raw message alone
    // lost every image that was not on the very last one.
    const payload = payloadOf(
      build({
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "first" },
              { kind: "image", payload: { type: "image_url", image_url: { url: "data:image/png;base64,DDDD" } } },
            ],
          },
          { role: "user", content: [{ kind: "text", text: "second" }] },
        ],
      }),
    );
    const state = payload.conversationState as {
      currentMessage: { userInputMessage: { images?: { format: string; source: { bytes: string } }[] } };
    };
    expect(state.currentMessage.userInputMessage.images).toEqual([
      { format: "png", source: { bytes: "DDDD" } },
    ]);
  });

  test("maps an effort tier onto the thinking marker for a model with no effort field", () => {
    // The 4.5 generation rejects `additionalModelRequestFields` outright, so an
    // effort the caller requested has to reach it through the text marker. It
    // previously did not: the marker was sent only for an explicit budget, and
    // asking for `high` on these models produced an answer that never reasoned.
    expect(kiroThinkingBudgetForEffort("high")).toBe(KIRO_THINKING_BUDGET_DEFAULT);
    expect(kiroThinkingBudgetForEffort("low")).toBe(1_024);
    expect(kiroThinkingBudgetForEffort("minimal")).toBe(512);
    // No tier at all is not a request to reason a little: it is no marker.
    expect(kiroThinkingBudgetForEffort("none")).toBeUndefined();
    expect(kiroThinkingBudgetForEffort(undefined)).toBeUndefined();
    const payload = payloadOf(build({}, { thinkingBudget: kiroThinkingBudgetForEffort("high") }));
    const state = payload.conversationState as {
      currentMessage: { userInputMessage: { content: string } };
    };
    expect(state.currentMessage.userInputMessage.content).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(state.currentMessage.userInputMessage.content).toContain("<max_thinking_length>16000</max_thinking_length>");
  });
});

describe("buildThinkingMarker", () => {
  test("clamps the budget to the upstream ceiling and floor", () => {
    expect(buildThinkingMarker(99_999)).toContain("<max_thinking_length>32000</max_thinking_length>");
    expect(buildThinkingMarker(0)).toContain("<max_thinking_length>1</max_thinking_length>");
  });
});

describe("normalizeJsonSchema", () => {
  test("drops additionalProperties and an empty required list", () => {
    expect(
      normalizeJsonSchema({ type: "object", additionalProperties: false, required: [], properties: {} }),
    ).toEqual({ type: "object", properties: {} });
  });

  test("forces the root to an object with a properties map", () => {
    expect(normalizeJsonSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(normalizeJsonSchema({ type: "string" })).toEqual({ type: "object", properties: {} });
  });

  test("filters required down to names the properties actually declare", () => {
    expect(
      normalizeJsonSchema({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a", "missing"],
      }),
    ).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
  });
});
