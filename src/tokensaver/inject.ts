/**
 * System-prompt injection for the prompt-based token savers (Caveman,
 * Ponytail). Shared injector, mirroring upstream's `systemInject.js`:
 * the saver prompt is prepended to the canonical `system` parts so every
 * surface adapter renders it as (part of) the system message, across all
 * wire formats.
 *
 * Idempotent: each injected block carries a `[token-saver:<name>]` marker
 * and is skipped when already present, so retries and re-dispatches never
 * stack the prompt.
 */
import type { CanonicalRequest, ContentPart } from "../transport/canonical-model";

function marker(name: string): string {
  return `[token-saver:${name}]`;
}

function systemText(parts: readonly ContentPart[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p): p is Extract<ContentPart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Prepend `prompt` to the request's system parts unless already injected. */
export function injectSystemPrompt(
  request: CanonicalRequest,
  name: "caveman" | "ponytail",
  prompt: string,
): CanonicalRequest {
  const tag = marker(name);
  if (systemText(request.system).includes(tag)) return request;
  const block: ContentPart = { kind: "text", text: `${tag}\n${prompt}` };
  return { ...request, system: [block, ...(request.system ?? [])] };
}

/** Names of the savers already injected into this request. */
export function injectedSavers(request: CanonicalRequest): readonly string[] {
  const text = systemText(request.system);
  const found: string[] = [];
  for (const name of ["caveman", "ponytail"] as const) {
    if (text.includes(marker(name))) found.push(name);
  }
  return found;
}
