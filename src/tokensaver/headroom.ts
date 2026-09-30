/**
 * Headroom: optional external `/v1/compress` proxy.
 *
 * Integration target is headroomlabs-ai/headroom (Apache-2.0), used only
 * through its `/v1/compress` HTTP contract — no upstream code is vendored.
 * The canonical messages are POSTed to the configured endpoint for
 * compression. **Fails open**: any error, timeout, non-200 status, shape
 * mismatch, or malformed response returns the original messages untouched,
 * so a down or hostile Headroom never breaks dispatch or smuggles
 * unexpected content shapes into the pipeline.
 */
import type { CanonicalMessage, ContentPart } from "../transport/canonical-model";

const HEADROOM_TIMEOUT_MS = 5000;
const MAX_HEADROOM_CHARS = 500000;

export interface HeadroomResult {
  readonly messages: readonly CanonicalMessage[];
  /** True when Headroom actually rewrote the messages. */
  readonly compressed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Strict structural check for one canonical content part. Unknown `kind`
 * values and missing required fields fail closed (the whole response is
 * rejected and the pipeline fails open to the original messages).
 */
function isValidPart(part: unknown): part is ContentPart {
  if (!isRecord(part) || typeof part.kind !== "string") return false;
  switch (part.kind) {
    case "text":
    case "refusal":
      return typeof part.text === "string";
    case "image":
    case "reasoning":
      return "payload" in part;
    case "file":
    case "audio":
    case "document":
      return "data" in part && typeof part.media_type === "string";
    case "toolCall":
      return (
        typeof part.call_id === "string" &&
        typeof part.name === "string" &&
        "arguments" in part
      );
    case "toolResult": {
      if (typeof part.call_id !== "string" || !("content" in part)) return false;
      const content = part.content;
      return (
        typeof content === "string" ||
        (Array.isArray(content) && content.every(isValidPart))
      );
    }
    case "extension":
      return typeof part.name === "string" && "payload" in part;
    default:
      return false;
  }
}

/**
 * Accept the compressed payload only when it round-trips cleanly: same
 * message count, same roles in order, and every content part passes strict
 * structural validation. Accepted messages are rebuilt as clean canonical
 * objects (role + validated parts + preserved phase) so unknown wire fields
 * can never leak into the pipeline. Anything else fails open.
 */
function acceptCompressed(
  original: readonly CanonicalMessage[],
  compressed: unknown,
): readonly CanonicalMessage[] | null {
  if (!Array.isArray(compressed) || compressed.length !== original.length) return null;
  const rebuilt: CanonicalMessage[] = [];
  for (let i = 0; i < original.length; i += 1) {
    const wire = compressed[i];
    const source = original[i]!;
    if (
      !isRecord(wire) ||
      wire.role !== source.role ||
      !Array.isArray(wire.content) ||
      !wire.content.every(isValidPart)
    ) {
      return null;
    }
    const message: CanonicalMessage = {
      role: source.role,
      content: wire.content as ContentPart[],
    };
    if (source.phase !== undefined) message.phase = source.phase;
    rebuilt.push(message);
  }
  return rebuilt;
}

export async function compressWithHeadroom(
  messages: readonly CanonicalMessage[],
  url: string,
  timeoutMs = HEADROOM_TIMEOUT_MS,
): Promise<HeadroomResult> {
  const failOpen = (): HeadroomResult => ({ messages, compressed: false });
  let endpoint: URL;
  try {
    endpoint = new URL(url.replace(/\/$/, "") + "/v1/compress");
  } catch {
    return failOpen();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return failOpen();
    const text = await response.text();
    if (text.length > MAX_HEADROOM_CHARS) return failOpen();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return failOpen();
    }
    const compressed = (parsed as { messages?: unknown } | null)?.messages;
    const accepted = acceptCompressed(messages, compressed);
    if (!accepted) return failOpen();
    return { messages: accepted, compressed: true };
  } catch {
    return failOpen();
  } finally {
    clearTimeout(timer);
  }
}
