import { describe, expect, test } from "bun:test";
import {
  applyTokenSavers,
  compressMessages,
  compressToolOutput,
  compressWithHeadroom,
  injectedSavers,
  injectSystemPrompt,
  normalizeTokenSaverConfig,
  tokenSaversActive,
} from "../../src/tokensaver";
import type { CanonicalMessage, CanonicalRequest } from "../../src/transport/canonical-model";

function toolMessage(output: string): CanonicalMessage {
  return {
    role: "tool",
    content: [{ kind: "toolResult", call_id: "call-1", content: output }],
  };
}

function userMessage(text: string): CanonicalMessage {
  return {
    role: "user",
    content: [{ kind: "text", text }],
  };
}

function bigGrepOutput(lines = 600): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(`src/module/file${i % 50}.ts:${100 + i}:    const value${i} = compute(${i});`);
  }
  return out.join("\n");
}

function baseRequest(messages: readonly CanonicalMessage[]): CanonicalRequest {
  return {
    model: "test/model",
    messages,
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  } as CanonicalRequest;
}

describe("normalizeTokenSaverConfig", () => {
  test("absent config yields defaults: RTK on, everything else off", () => {
    const config = normalizeTokenSaverConfig(undefined);
    expect(config.rtk).toBe(true);
    expect(config.caveman).toBe("off");
    expect(config.ponytail).toBe("off");
    expect(config.headroomEnabled).toBe(false);
  });

  test("explicit values are honored", () => {
    const config = normalizeTokenSaverConfig({
      rtk: false,
      caveman: "full",
      ponytail: "ultra",
      headroom: { enabled: true, url: "https://headroom.example.com" },
    });
    expect(config.rtk).toBe(false);
    expect(config.caveman).toBe("full");
    expect(config.ponytail).toBe("ultra");
    expect(config.headroomEnabled).toBe(true);
    expect(config.headroomUrl).toBe("https://headroom.example.com");
  });

  test("malformed input falls back to defaults", () => {
    expect(normalizeTokenSaverConfig(null).rtk).toBe(true);
    expect(normalizeTokenSaverConfig("nope").caveman).toBe("off");
    const bad = normalizeTokenSaverConfig({ caveman: "extreme", ponytail: 42 });
    expect(bad.caveman).toBe("off");
    expect(bad.ponytail).toBe("off");
  });

  test("headroom without a URL is disabled", () => {
    const config = normalizeTokenSaverConfig({ headroom: { enabled: true } });
    expect(config.headroomEnabled).toBe(false);
  });

  test("tokenSaversActive reflects any enabled saver", () => {
    expect(tokenSaversActive(normalizeTokenSaverConfig(undefined))).toBe(true); // rtk default
    expect(tokenSaversActive(normalizeTokenSaverConfig({ rtk: false }))).toBe(false);
    expect(
      tokenSaversActive(normalizeTokenSaverConfig({ rtk: false, ponytail: "lite" })),
    ).toBe(true);
  });
});

describe("compressToolOutput", () => {
  test("short output passes through untouched", () => {
    const text = "line1\nline2\nline3";
    expect(compressToolOutput(text)).toEqual({ text, compressed: false });
  });

  test("long grep-like output is smart-truncated with an omission marker", () => {
    const text = bigGrepOutput();
    const { text: out, compressed } = compressToolOutput(text);
    expect(compressed).toBe(true);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("lines omitted by token saver");
    // Head and tail survive.
    expect(out).toContain("file0.ts:100:");
    expect(out).toContain("file49.ts:699:");
  });

  test("runs of identical lines are deduplicated", () => {
    const text = [...Array<string>(300).fill("same line here"), "unique tail line"].join("\n") + "\n" + "x".repeat(1500);
    const { text: out, compressed } = compressToolOutput(text);
    expect(compressed).toBe(true);
    expect(out).toContain("more identical lines");
    expect(out).toContain("unique tail line");
  });

  test("diff-like output is detected and compressed", () => {
    const lines = ["diff --git a/f.ts b/f.ts", "@@ -1,3 +1,3 @@", "-old", "+new"];
    for (let i = 0; i < 500; i += 1) lines.push(` context line ${i} with some padding text here`);
    const { compressed } = compressToolOutput(lines.join("\n"));
    expect(compressed).toBe(true);
  });
});

describe("compressMessages", () => {
  test("compresses toolResult content, leaves user prose alone", () => {
    const userText = bigGrepOutput(300).replaceAll("src/module", "my thoughts about");
    const { messages, stats } = compressMessages([userMessage(userText), toolMessage(bigGrepOutput())]);
    expect(stats.partsCompressed).toBe(1);
    // User message untouched even though it is long.
    expect(messages[0]).toEqual(userMessage(userText));
    const toolPart = messages[1]!.content[0]!;
    expect(toolPart.kind).toBe("toolResult");
    if (toolPart.kind === "toolResult") {
      expect(typeof toolPart.content === "string" ? toolPart.content.length : -1).toBeLessThan(
        bigGrepOutput().length,
      );
    }
  });

  test("returns the original array reference when nothing changed", () => {
    const messages = [userMessage("hello"), toolMessage("short output")];
    const { messages: out, stats } = compressMessages(messages);
    expect(out).toBe(messages);
    expect(stats.partsCompressed).toBe(0);
  });

  test("non-text inner parts are preserved", () => {
    const message: CanonicalMessage = {
      role: "tool",
      content: [
        {
          kind: "toolResult",
          call_id: "c1",
          content: [{ kind: "image", payload: "img" }, { kind: "text", text: bigGrepOutput() }],
        },
      ],
    };
    const { messages } = compressMessages([message]);
    const part = messages[0]!.content[0]!;
    expect(part.kind).toBe("toolResult");
    if (part.kind === "toolResult" && typeof part.content !== "string") {
      expect(part.content[0]!.kind).toBe("image");
      expect(part.content[1]!.kind).toBe("text");
    }
  });
});

describe("injectSystemPrompt", () => {
  test("prepends the saver block to the system parts", () => {
    const request = baseRequest([userMessage("hi")]);
    const next = injectSystemPrompt(request, "caveman", "BE TERSE");
    expect(next.system).toBeDefined();
    expect(next.system![0]).toEqual({ kind: "text", text: "[token-saver:caveman]\nBE TERSE" });
    expect(injectedSavers(next)).toEqual(["caveman"]);
  });

  test("injection is idempotent", () => {
    const request = baseRequest([userMessage("hi")]);
    const once = injectSystemPrompt(request, "ponytail", "BE LAZY");
    const twice = injectSystemPrompt(once, "ponytail", "BE LAZY");
    expect(twice).toBe(once);
    expect(injectedSavers(twice)).toEqual(["ponytail"]);
  });

  test("preserves an existing system prompt after the injected block", () => {
    const request = baseRequest([userMessage("hi")]);
    const withSystem: CanonicalRequest = {
      ...request,
      system: [{ kind: "text", text: "You are helpful." }],
    };
    const next = injectSystemPrompt(withSystem, "caveman", "BE TERSE");
    expect(next.system!.length).toBe(2);
    expect(next.system![1]).toEqual({ kind: "text", text: "You are helpful." });
  });
});

describe("compressWithHeadroom", () => {
  test("fails open on an unreachable endpoint", async () => {
    const messages = [userMessage("hello")];
    const result = await compressWithHeadroom(messages, "http://127.0.0.1:1", 200);
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  test("fails open on a malformed URL", async () => {
    const messages = [userMessage("hello")];
    const result = await compressWithHeadroom(messages, "://bad-url");
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });
});

describe("applyTokenSavers", () => {
  test("default config compresses tool output via RTK only", async () => {
    const request = baseRequest([userMessage("hi"), toolMessage(bigGrepOutput())]);
    const outcome = await applyTokenSavers(request, undefined);
    expect(outcome.applied).toEqual(["rtk"]);
    expect(outcome.rtkStats).toBeDefined();
    expect(outcome.rtkStats!.partsCompressed).toBe(1);
    expect(injectedSavers(outcome.request)).toEqual([]);
  });

  test("rtk:false disables compression entirely", async () => {
    const request = baseRequest([userMessage("hi"), toolMessage(bigGrepOutput())]);
    const outcome = await applyTokenSavers(request, { rtk: false });
    expect(outcome.applied).toEqual([]);
    expect(outcome.request).toBe(request);
  });

  test("caveman and ponytail inject in order after rtk", async () => {
    const request = baseRequest([userMessage("hi"), toolMessage(bigGrepOutput())]);
    const outcome = await applyTokenSavers(request, { caveman: "full", ponytail: "lite" });
    expect(outcome.applied).toEqual(["rtk", "caveman:full", "ponytail:lite"]);
    expect(injectedSavers(outcome.request)).toEqual(["caveman", "ponytail"]);
    // Ponytail block is prepended last, so it comes first in system order.
    const first = outcome.request.system![0]!;
    expect(first.kind).toBe("text");
    if (first.kind === "text") expect(first.text).toContain("[token-saver:ponytail]");
  });

  test("headroom failure is skipped silently (fail-open)", async () => {
    const request = baseRequest([userMessage("hi")]);
    const outcome = await applyTokenSavers(request, {
      rtk: false,
      headroom: { enabled: true, url: "http://127.0.0.1:1" },
    });
    expect(outcome.applied).toEqual([]);
    expect(outcome.request).toBe(request);
  });
});
