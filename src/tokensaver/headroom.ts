/**
 * Headroom: optional external `/v1/compress` proxy.
 *
 * When enabled, the canonical messages are POSTed to the configured
 * Headroom endpoint for compression. **Fails open**: any error, timeout,
 * non-200 status, shape mismatch, or malformed response returns the
 * original messages untouched, so a down Headroom never breaks dispatch.
 */
import type { CanonicalMessage } from "../transport/canonical-model";

const HEADROOM_TIMEOUT_MS = 5000;
const MAX_HEADROOM_CHARS = 500000;

export interface HeadroomResult {
  readonly messages: readonly CanonicalMessage[];
  /** True when Headroom actually rewrote the messages. */
  readonly compressed: boolean;
}

function isWireMessage(value: unknown): value is { role: string; content: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { role?: unknown }).role === "string" &&
    "content" in (value as Record<string, unknown>)
  );
}

/**
 * Accept the compressed payload only when it round-trips cleanly: same
 * message count, same roles in order. Anything else fails open.
 */
function acceptCompressed(
  original: readonly CanonicalMessage[],
  compressed: unknown,
): readonly CanonicalMessage[] | null {
  if (!Array.isArray(compressed) || compressed.length !== original.length) return null;
  for (let i = 0; i < original.length; i += 1) {
    const wire = compressed[i];
    if (!isWireMessage(wire) || wire.role !== original[i]!.role) return null;
  }
  return compressed as unknown as readonly CanonicalMessage[];
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
