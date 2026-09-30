/**
 * Token-saver pipeline: applies the enabled savers to one canonical
 * request, in upstream order —
 *
 *   RTK compress → Headroom → Caveman inject → Ponytail inject → dispatch
 *
 * RTK and Headroom rewrite the message history (input tokens); Caveman and
 * Ponytail inject system prompts (output tokens / build discipline). The
 * pipeline is pure except Headroom's single fail-open HTTP call.
 */
import type { CanonicalRequest } from "../transport/canonical-model";
import { normalizeTokenSaverConfig, type NormalizedTokenSaverConfig } from "./config";
import { compressMessages, type RtkStats } from "./rtk";
import { compressWithHeadroom } from "./headroom";
import { injectSystemPrompt } from "./inject";
import { cavemanPrompt, ponytailPrompt } from "./prompts";

export interface TokenSaverOutcome {
  readonly request: CanonicalRequest;
  /** Savers that actually changed the request, in application order. */
  readonly applied: readonly string[];
  readonly rtkStats?: RtkStats;
}

export async function applyTokenSavers(
  request: CanonicalRequest,
  rawConfig: unknown,
): Promise<TokenSaverOutcome> {
  const config: NormalizedTokenSaverConfig = normalizeTokenSaverConfig(rawConfig);
  const applied: string[] = [];
  let current = request;
  let rtkStats: RtkStats | undefined;

  if (config.rtk) {
    const { messages, stats } = compressMessages(current.messages);
    if (stats.partsCompressed > 0) {
      current = { ...current, messages };
      rtkStats = stats;
      applied.push("rtk");
    }
  }

  if (config.headroomEnabled && config.headroomUrl) {
    const { messages, compressed } = await compressWithHeadroom(current.messages, config.headroomUrl);
    if (compressed) {
      current = { ...current, messages };
      applied.push("headroom");
    }
  }

  if (config.caveman !== "off") {
    const next = injectSystemPrompt(current, "caveman", cavemanPrompt(config.caveman));
    if (next !== current) {
      current = next;
      applied.push(`caveman:${config.caveman}`);
    }
  }

  if (config.ponytail !== "off") {
    const next = injectSystemPrompt(current, "ponytail", ponytailPrompt(config.ponytail));
    if (next !== current) {
      current = next;
      applied.push(`ponytail:${config.ponytail}`);
    }
  }

  return { request: current, applied, ...(rtkStats ? { rtkStats } : {}) };
}
