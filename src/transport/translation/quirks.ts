// Declarative provider parameter quirks.
//
// Some upstreams reject combinations the OpenAI/Anthropic contracts permit
// (e.g. Anthropic rejects `temperature` alongside extended thinking). Instead
// of scattering ad-hoc `delete payload.x` fixes through adapters, each quirk
// lives in one table row: the provider it applies to, an optional model
// matcher, and the strip/clamp to apply.
//
// Add a row ONLY when a concrete upstream 400/422 proves the quirk; do not
// speculate. The table is applied on the dispatch path before wire translation.

import type { CanonicalRequest, GenerationControls } from "../canonical-model";
import {
  THINKING_STRIPPED_SAMPLING_CONTROLS,
  isThinkingEnabled,
} from "./capabilities";

export interface ParamQuirk {
  /** Provider id the quirk applies to (matches `candidate.provider_id`). */
  readonly provider: string;
  /** Optional model-name matcher; when absent the quirk applies to every model. */
  readonly matchModel?: RegExp;
  /** Canonical `generation_controls` keys to strip before dispatch. */
  readonly stripControls?: readonly (keyof GenerationControls)[];
  /** Upper bound applied to `generation_controls.max_tokens` when exceeded. */
  readonly clampMaxOutput?: number;
}

/** Per-wire output-token policy, in one table instead of per-builder branches. */
export interface WireTokenBound {
  /** Default when the caller sent no limit (undefined = leave absent). */
  readonly defaultMaxTokens?: number;
  /** Floor applied when tools are present and the value is narrower. */
  readonly toolCallFloor?: number;
  /** Hard ceiling; values above are clamped down. */
  readonly ceiling?: number;
  /** OAuth ceiling applied after floor/default. */
  readonly oauthCeiling?: number;
}

/**
 * Output-token bounds per wire family. Values below are the current
 * per-builder behavior, centralized so the three codecs cannot drift:
 * chat clamps to 32k (free-tier backends 400 on unbounded values);
 * messages defaults to 4096 (Anthropic requires the field), floors to 32k
 * with tools, and clamps OAuth to 64k; responses passes through.
 */
export const WIRE_TOKEN_BOUNDS: Readonly<Record<string, WireTokenBound>> = {
  chat: { ceiling: 32_000 },
  messages: { defaultMaxTokens: 4_096, toolCallFloor: 32_000, oauthCeiling: 64_000 },
  responses: {},
};

/** Resolves the output-token value for one wire from caller controls. */
export function resolveWireMaxTokens(
  wire: string,
  controls: { max_tokens?: number | undefined },
  options: { hasTools?: boolean; isOAuth?: boolean } = {},
): number | undefined {
  const bound = WIRE_TOKEN_BOUNDS[wire];
  if (bound === undefined) return controls.max_tokens;
  let value = controls.max_tokens;
  if (value === undefined && bound.defaultMaxTokens !== undefined) value = bound.defaultMaxTokens;
  if (value !== undefined && bound.toolCallFloor !== undefined && options.hasTools === true && value < bound.toolCallFloor)
    value = bound.toolCallFloor;
  if (value !== undefined && bound.oauthCeiling !== undefined && options.isOAuth === true && value > bound.oauthCeiling)
    value = bound.oauthCeiling;
  if (value !== undefined && bound.ceiling !== undefined && value > bound.ceiling) value = bound.ceiling;
  return value;
}
/**
 * Confirmed quirks only. Currently confirmed: Anthropic rejects `temperature`
 * when extended thinking is active on Claude models.
 */
const PARAM_QUIRKS: readonly ParamQuirk[] = [
  { provider: "anthropic", matchModel: /claude/, stripControls: ["temperature"] },
];

/** Finds the first quirk matching the provider/model pair, or undefined. */
export function findParamQuirk(
  providerId: string,
  modelId: string,
): ParamQuirk | undefined {
  return PARAM_QUIRKS.find(
    (quirk) =>
      quirk.provider === providerId &&
      (quirk.matchModel === undefined || quirk.matchModel.test(modelId)),
  );
}

/**
 * Applies the provider/model quirks to a canonical request, returning the
 * original reference when nothing matched (callers can compare identity).
 */
export function applyParamQuirks(
  request: CanonicalRequest,
  providerId: string,
): CanonicalRequest {
  const quirk = findParamQuirk(providerId, request.model);
  // The thinking-sampling strip is universal, not quirk-gated: extended
  // thinking rejects temperature/top_p/top_k on every Messages-wire upstream.
  // Previously the early return below skipped it for any provider without a
  // PARAM_QUIRKS row (only anthropic/claude had one), so strict upstreams got
  // a 400 the strip exists to prevent. Declarative rows still apply after.

  let controls = request.generation_controls;
  let changed = false;

  if (quirk?.stripControls !== undefined && quirk.stripControls.length > 0) {
    controls = { ...controls };
    for (const key of quirk.stripControls) {
      if (key in controls) {
        delete controls[key];
        changed = true;
      }
    }
  }

  // Extended thinking rejects sampling controls upstream. The stripped set is
  // owned by capabilities.ts (shared with the Messages payload builder, which
  // applies the same rule at translation time) — the quirks table itself
  // keeps only its declarative temperature row.
  if (isThinkingEnabled(request)) {
    for (const key of THINKING_STRIPPED_SAMPLING_CONTROLS) {
      if (key in controls) {
        if (!changed) controls = { ...controls };
        delete controls[key];
        changed = true;
      }
    }
  }

  if (quirk?.clampMaxOutput !== undefined) {
    const limit = quirk.clampMaxOutput;
    if (typeof controls.max_tokens === "number" && controls.max_tokens > limit) {
      if (!changed) controls = { ...controls };
      controls = { ...controls, max_tokens: limit };
      changed = true;
    }
  }

  return changed ? { ...request, generation_controls: controls } : request;
}
