/**
 * RTK-equivalent tool-output compression for the gateway.
 *
 * Upstream RTK (rtk-ai/rtk) is a terminal wrapper; here the same idea runs
 * as a message preprocessing stage: `toolResult` text parts are
 * auto-detected (git-diff, grep, ls/tree, logs) and compressed with
 * dedup + smart-truncate before the request reaches the LLM. Runs before
 * format translation so it works across all wire formats.
 *
 * Only `toolResult` text parts are ever rewritten; user/assistant prose and
 * non-text parts pass through untouched.
 */
import {
  canContainToolResult,
  toolResultParts,
  type CanonicalMessage,
  type ContentPart,
} from "../transport/canonical-model";

export interface RtkStats {
  readonly partsCompressed: number;
  readonly linesBefore: number;
  readonly linesAfter: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
}

/** Above this many lines (or chars) a tool output gets smart-truncated. */
const MAX_LINES = 400;
const MAX_CHARS = 16000;
/** Head/tail kept when truncating. */
const HEAD_LINES = 120;
const TAIL_LINES = 40;

const DIFF_MARKERS = ["diff --git", "@@", "+++ ", "--- "] as const;
const TREE_CHARS = ["├──", "└──", "│"] as const;

function isDiffLike(lines: readonly string[]): boolean {
  let markers = 0;
  for (const line of lines.slice(0, 50)) {
    if (DIFF_MARKERS.some((m) => line.startsWith(m))) markers += 1;
    else if (line.startsWith("+") || line.startsWith("-")) markers += 1;
    if (markers >= 3) return true;
  }
  return false;
}

function isGrepLike(lines: readonly string[]): boolean {
  let hits = 0;
  const sample = lines.slice(0, 60);
  for (const line of sample) {
    if (/^[^:\s]{1,120}:\d{1,6}(:\d{1,6})?:/.test(line)) hits += 1;
    if (hits >= 5) return true;
  }
  return hits >= 3 && sample.length >= 10;
}

function isTreeLike(lines: readonly string[]): boolean {
  let hits = 0;
  for (const line of lines.slice(0, 60)) {
    if (TREE_CHARS.some((c) => line.includes(c))) hits += 1;
    if (hits >= 3) return true;
  }
  return false;
}

/** Collapse runs of identical consecutive lines: `foo` x5 -> `foo\n… (4 more identical lines)`. */
function dedupLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let run = 1;
    while (i + run < lines.length && lines[i + run] === line && run < 100000) run += 1;
    out.push(line);
    if (run > 2) out.push(`… (${run - 1} more identical lines)`);
    else for (let k = 1; k < run; k += 1) out.push(line);
    i += run;
  }
  return out;
}

function smartTruncate(lines: readonly string[]): string[] {
  if (lines.length <= MAX_LINES && lines.join("\n").length <= MAX_CHARS) return [...lines];
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  if (omitted <= 0) {
    // Over the char budget but not the line budget: hard cut with a marker.
    const head = lines.slice(0, HEAD_LINES);
    return [...head, `… (output truncated: exceeded ${MAX_CHARS} chars)`];
  }
  return [
    ...lines.slice(0, HEAD_LINES),
    `… (${omitted} lines omitted by token saver)`,
    ...lines.slice(lines.length - TAIL_LINES),
  ];
}

/** Compress one tool-result text blob. Returns the original when nothing applies. */
export function compressToolOutput(text: string): { text: string; compressed: boolean } {
  if (!text.includes("\n") || text.length < 2000) return { text, compressed: false };
  const lines = text.split("\n");
  const looksStructured = isDiffLike(lines) || isGrepLike(lines) || isTreeLike(lines);
  // Always dedup; truncate only when over budget or clearly structured noise.
  const deduped = dedupLines(lines);
  const final = smartTruncate(deduped);
  const out = final.join("\n");
  if (out === text) return { text, compressed: false };
  // Guard: never compress tiny outputs, and never grow the text.
  if (!looksStructured && out.length > text.length * 0.95 && lines.length <= MAX_LINES) {
    return { text, compressed: false };
  }
  return { text: out, compressed: out.length < text.length };
}

function compressInnerText(
  text: string,
  stats: { linesBefore: number; linesAfter: number; charsBefore: number; charsAfter: number; parts: number },
): string {
  const { text: out, compressed } = compressToolOutput(text);
  if (!compressed) return text;
  stats.parts += 1;
  stats.linesBefore += text.split("\n").length;
  stats.linesAfter += out.split("\n").length;
  stats.charsBefore += text.length;
  stats.charsAfter += out.length;
  return out;
}

/** Rewrite a single `toolResult` part's inner content; other parts pass through. */
function compressPart(
  part: ContentPart,
  stats: { linesBefore: number; linesAfter: number; charsBefore: number; charsAfter: number; parts: number },
): ContentPart {
  if (part.kind !== "toolResult") return part;
  if (typeof part.content === "string") {
    const next = compressInnerText(part.content, stats);
    return next === part.content ? part : { ...part, content: next };
  }
  let innerChanged = false;
  const content = part.content.map((inner) => {
    if (inner.kind !== "text") return inner;
    const next = compressInnerText(inner.text, stats);
    if (next !== inner.text) innerChanged = true;
    return next === inner.text ? inner : { ...inner, text: next };
  });
  return innerChanged ? { ...part, content } : part;
}

export function compressMessages(
  messages: readonly CanonicalMessage[],
): { messages: readonly CanonicalMessage[]; stats: RtkStats } {
  const stats = { linesBefore: 0, linesAfter: 0, charsBefore: 0, charsAfter: 0, parts: 0 };
  let changed = false;
  const out = messages.map((message) => {
    if (!canContainToolResult(message)) return message;
    // Only rewrite when the message actually carries toolResult parts.
    if (toolResultParts(message).length === 0) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      const next = compressPart(part, stats);
      if (next !== part) messageChanged = true;
      return next;
    });
    if (messageChanged) changed = true;
    return messageChanged ? { ...message, content } : message;
  });
  return {
    messages: changed ? out : messages,
    stats: {
      partsCompressed: stats.parts,
      linesBefore: stats.linesBefore,
      linesAfter: stats.linesAfter,
      charsBefore: stats.charsBefore,
      charsAfter: stats.charsAfter,
    },
  };
}
