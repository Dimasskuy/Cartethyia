import { sanitizeUpstreamLabel } from "../../provider-metadata";
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";
import type { DiscoveryInput } from "../../discovery/discovery-types";
import { record } from "../../authentication/oauth-flow-store";
import { fetchAutoClawUserApi } from "./autoclaw-shared";
import { AUTOCLAW_ENDPOINT_PATHS } from "./autoclaw";

const MODEL_CONFIG_PATH = "/autoclaw-proxy/proxy/autoclaw-model-config";

function modelEntries(data: unknown): readonly Record<string, unknown>[] | null {
  const root = record(data);
  const values = root?.["models"];
  if (!Array.isArray(values)) return null;
  const entries: Record<string, unknown>[] = [];
  for (const value of values) {
    const model = record(value);
    if (model !== null && model !== undefined) entries.push(model);
  }
  return entries;
}

function positiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

/** Reads the account-scoped model list and limits from AutoClaw's CN model configuration. */
export async function discoverAutoClawModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const data = await fetchAutoClawUserApi(MODEL_CONFIG_PATH, input.credential, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
  const entries = modelEntries(data);
  if (entries === null) return null;
  const byId = new Map<string, ModelDefinition>();
  for (const entry of entries) {
    const id = sanitizeUpstreamLabel(entry["id"]);
    if (!id) continue;
    const contextLimit = positiveNumber(entry["contextWindow"]);
    const outputLimit = positiveNumber(entry["maxTokens"]);
    const modalities = typeof entry["modality"] === "string" ? entry["modality"].toLowerCase() : "";
    byId.set(id, defineModel({
      id,
      providerId: "autoclaw",
      endpoint: AUTOCLAW_ENDPOINT_PATHS.chat,
      ...(contextLimit === undefined ? {} : { ctx: contextLimit }),
      ...(outputLimit === undefined ? {} : { out: outputLimit }),
      vision: modalities.includes("image"),
      reasoning: entry["reasoning"] === true,
      toolCall: true,
    }));
  }
  return [...byId.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
}
