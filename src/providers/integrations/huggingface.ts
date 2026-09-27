/**
 * Hugging Face router model directory.
 *
 * The router serves an OpenAI-shaped `/v1/models` listing whose *entries* are
 * not OpenAI-shaped. Each row is one model with a nested `providers[]` array —
 * the router is a broker, so a model is served by several upstream providers at
 * different prices and context lengths — and capability lives under
 * `architecture.input_modalities` plus a per-provider `supports_tools` flag.
 *
 * The shared tolerant fetcher reads a top-level `context_length` and a
 * `modality` string, so against this listing it would publish every row at the
 * 200k/64k defaults, drop tools from every model, and lose the image input that
 * 28 of the 78 bundled rows declare. So this module reads the nesting directly.
 *
 * The context window and price are taken from the **cheapest** live provider
 * entry: the router routes to whichever backend it picks, and the cheapest is
 * the rate the operator can actually expect. `supports_tools` is ANDed across
 * entries because a model routed to a backend without tool support cannot call
 * tools, and `toolCall: false` is what makes capability preflight strip `tools`
 * from the request.
 */
import type { ModelDefinition } from "../provider-registry";
import { isRecord } from "../../protocol/primitives";
import {
  boundedUpstreamArray,
  boundedUpstreamNumber,
  sanitizeUpstreamLabel,
} from "../provider-metadata";
import { modelsDevCatalog } from "../discovery/models-dev-catalog";
import type { DiscoveryInput } from "../discovery/discovery-types";
import type { ApiKeyProviderSpec } from "./configured-provider";

export const HUGGINGFACE_PROVIDER_ID = "huggingface" as const;
export const HUGGINGFACE_MODELS_URL = "https://router.huggingface.co/v1/models" as const;
export const HUGGINGFACE_ENDPOINT_PATH = "/chat/completions" as const;

/**
 * The router is bearer-authenticated and OpenAI-compatible on chat, so the
 * adapter is the shared factory. The base URL already carries `/v1`, so the
 * endpoint path is the suffix that completes it.
 */
export const HUGGINGFACE_SPEC: ApiKeyProviderSpec = {
  provider_id: HUGGINGFACE_PROVIDER_ID,
  endpoint_paths_by_wire_family: { chat: HUGGINGFACE_ENDPOINT_PATH },
};

const MAX_CONTEXT = 1_000_000_000;
const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_OUTPUT_LIMIT = 64_192;

function positiveLimit(value: unknown): number | undefined {
  return boundedUpstreamNumber(value, { min: 1, max: MAX_CONTEXT });
}

/** One live provider entry behind a model. */
interface RouterProvider {
  readonly contextLength: number | undefined;
  readonly inputCost: number | undefined;
  readonly supportsTools: boolean | undefined;
}

function parseProvider(entry: unknown): RouterProvider {
  const record = (isRecord(entry) ? entry : undefined) as Record<string, unknown> | undefined;
  const pricing = (record !== undefined && isRecord(record.pricing) ? record.pricing : undefined) as Record<string, unknown> | undefined;
  return {
    contextLength: positiveLimit(record?.context_length),
    inputCost: boundedUpstreamNumber(pricing?.input, { min: 0 }),
    supportsTools:
      typeof record?.supports_tools === "boolean" ? record.supports_tools : undefined,
  };
}

/** The live entries for one model; a row with none is not routable. */
function liveProviders(entry: Record<string, unknown>): readonly RouterProvider[] {
  const declared = boundedUpstreamArray(entry.providers);
  if (!declared) return [];
  return declared
    .map((entry: unknown): RouterProvider => parseProvider(entry))
    .filter((provider) => provider.contextLength !== undefined || provider.supportsTools !== undefined);
}

/** Canonical input modalities from the entry's `architecture` block. */
function inputModalities(entry: Record<string, unknown>): readonly string[] {
  const architecture = (isRecord(entry.architecture) ? entry.architecture : undefined) as Record<string, unknown> | undefined;
  const declared = boundedUpstreamArray(architecture?.input_modalities);
  if (!declared) return ["text"];
  const known = new Set<string>(["text"]);
  for (const value of declared) {
    const modality = sanitizeUpstreamLabel(value)?.toLowerCase();
    if (modality === "image") known.add("image");
    else if (modality === "audio") known.add("audio");
    else if (modality === "video") known.add("video");
    else if (modality === "file" || modality === "pdf") known.add("document");
  }
  return [...known];
}

/** Builds one catalog row, or `undefined` when the entry carries no usable id. */
function toModelDefinition(entry: Record<string, unknown>): ModelDefinition | undefined {
  const modelId = sanitizeUpstreamLabel(entry.id);
  if (modelId === undefined) return undefined;
  const providers = liveProviders(entry);
  // The cheapest live entry decides the window and the price. When no entry
  // states a context length, the base catalog answers — it files this provider's
  // rows under the same id, so the lookup is exact rather than a bare-id guess.
  const cheapest = providers
    .filter((provider) => provider.inputCost !== undefined)
    .sort((left, right) => (left.inputCost ?? 0) - (right.inputCost ?? 0))[0];
  const fallback = modelsDevCatalog.resolve(HUGGINGFACE_PROVIDER_ID, modelId);
  const contextLimit =
    cheapest?.contextLength ?? providers[0]?.contextLength ?? fallback?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const declaredOutput = fallback?.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const outputLimit = Math.min(declaredOutput, contextLimit);
  // Every live entry must accept tools: one backend that does not makes the
  // routed request unable to call them, and an over-declared capability is what
  // makes preflight send a `tools` array the backend then rejects.
  const toolCall =
    providers.length > 0
      ? providers.every((provider) => provider.supportsTools !== false)
      : true;
  return {
    modelId,
    wireFamily: "chat",
    endpointPath: HUGGINGFACE_ENDPOINT_PATH,
    contextLimit,
    outputLimit,
    modalities: { input: inputModalities(entry), output: ["text"] },
    // The listing states no reasoning flag; the base catalog does for the ids it
    // files under this provider, and an id it does not file stays false rather
    // than being guessed from the model name.
    reasoning: fallback?.reasoning ?? false,
    toolCall,
    webSearch: false,
    cost: modelsDevCatalog.costFor(HUGGINGFACE_PROVIDER_ID, modelId),
  };
}

/**
 * Reads the Hugging Face router directory.
 *
 * Returns `null` — not an empty list — on any failure, so the caller can tell
 * "the directory could not be read" apart from "the directory is empty".
 */
export async function discoverHuggingfaceModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = input.fetcher ?? fetch;
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal =
    input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
  try {
    const response = await fetcher(HUGGINGFACE_MODELS_URL, {
      headers: { accept: "application/json", authorization: `Bearer ${input.credential}` },
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) return null;
    const entries = boundedUpstreamArray((payload as Record<string, unknown>).data);
    if (!entries) return null;
    const byId = new Map<string, ModelDefinition>();
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const definition = toModelDefinition(entry);
      if (definition !== undefined) byId.set(definition.modelId, definition);
    }
    if (byId.size === 0) return null;
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}
