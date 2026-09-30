// Smart-routing combo strategy: order the member pool per request from two signals.
//
//   1. Tool-calling need (deterministic): the request carries tools or a
//      non-"none" tool_choice. The pool is restricted to tool-capable members
//      (`toolCallingMembers` when configured, otherwise all members minus
//      `noToolMembers`). An empty tool pool degrades to the full member order.
//   2. Research intent (fuzzy): keyword/URL heuristic over the last user
//      message, with an optional cheap LLM classifier fallback when the
//      heuristic is ambiguous. Research requests try `researchMembers` first.
//
// The ordered pool is handed to the normal dispatch, which already fails over
// across candidates — a dead member can never kill the request, the next pool
// member is tried automatically.
//
// Strategy adapted from ExtremeRouter's smart routing (MIT licensed).
// ExtremeRouter derives tool/research capability from its provider registry
// (cookie vs API providers); Cartethyia has no such registry, so capability
// is configured per combo instead.
import type { CanonicalRequest, SourceSurface } from "../canonical-model";
import { GatewayError } from "../gateway-error";
import type { ComboDefinition, RouteCandidate } from "../routing/route-model";
import { extractSurfaceText, groupCandidatesByModel } from "./cascade";
import { updateInFlightDetail } from "../request/inflight";

/** Curated research-intent keywords (lowercased). Overridable per combo. */
export const DEFAULT_RESEARCH_KEYWORDS = [
  "riset", "research", "cari sumber", "sumber terpercaya", "terbaru",
  "compare", "bandingkan", "cite", "summarize article", "rangkum artikel",
  "berita", "trend", "studi", "jurnal", "menurut data", "investigate",
  "look up", "search the web", "find information", "web search",
];

/** Classifier call budget — must never stall the main request for long. */
export const CLASSIFIER_TIMEOUT_MS = 15_000;

export const DEFAULT_CLASSIFIER_PROMPT =
  "Classify the following user task as one of: research, coding, general. Respond with a single word.\n\nTask: {{userPrompt}}";

export type ResearchIntent = "research" | "general";

export interface HeuristicResult {
  readonly intent: ResearchIntent;
  readonly confidence: number;
  readonly signal: "keyword" | "url" | "none" | "empty";
}

export interface ResolvedSmartRoutingConfig {
  readonly keywords: readonly string[];
  readonly confidenceThreshold: number;
  readonly urlPatternBoost: boolean;
  /** Explicit tool-capable member order; null = all members minus noToolMembers. */
  readonly toolCallingMembers: readonly string[] | null;
  readonly noToolMembers: readonly string[];
  readonly researchMembers: readonly string[];
  /** Classifier model ref; null = heuristic only. */
  readonly classifierModel: string | null;
  readonly classifierPrompt: string;
}

const asStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];

/** Merge the combo's stored tuning over the defaults, clamped defensively. */
export function resolveSmartRoutingConfig(combo: ComboDefinition): ResolvedSmartRoutingConfig {
  const raw = combo.config?.smartRouting ?? {};
  const intent = typeof raw.intentDetection === "object" && raw.intentDetection !== null ? raw.intentDetection : {};
  const classifier =
    typeof intent.llmClassifierFallback === "object" && intent.llmClassifierFallback !== null
      ? intent.llmClassifierFallback
      : {};
  const keywords = asStringList(intent.keywords);
  return {
    keywords: keywords.length > 0 ? keywords : DEFAULT_RESEARCH_KEYWORDS,
    confidenceThreshold:
      typeof intent.confidenceThreshold === "number" && Number.isFinite(intent.confidenceThreshold)
        ? Math.min(1, Math.max(0, intent.confidenceThreshold))
        : 0.6,
    urlPatternBoost: intent.urlPatternBoost !== false,
    toolCallingMembers: (() => {
      const list = asStringList(raw.toolCallingMembers);
      return list.length > 0 ? list : null;
    })(),
    noToolMembers: asStringList(raw.noToolMembers),
    researchMembers: asStringList(raw.researchMembers),
    classifierModel:
      typeof classifier.model === "string" && classifier.model.trim().length > 0
        ? classifier.model.trim()
        : null,
    classifierPrompt:
      typeof classifier.promptTemplate === "string" && classifier.promptTemplate.trim().length > 0
        ? classifier.promptTemplate
        : DEFAULT_CLASSIFIER_PROMPT,
  };
}

/**
 * Deterministic tool-calling detection — no model call, just the payload.
 * True when the request carries tool definitions or a non-"none" tool_choice.
 */
export function requiresToolCalling(request: CanonicalRequest): boolean {
  if ((request.tools?.length ?? 0) > 0) return true;
  const choice = request.tool_choice;
  return choice !== undefined && choice !== "none";
}

/** Flatten the last user message to plain text for the research signal. */
export function lastUserMessageText(request: CanonicalRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== "user") continue;
    const text = message.content
      .map((part) => (part.kind === "text" ? part.text : ""))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * Cheap keyword/URL heuristic. Returns research with 0.75 on a keyword hit
 * or a URL (when urlPatternBoost is on), general with 0.4 otherwise — low
 * confidence, so it may escalate to the LLM classifier when one is set.
 */
export function detectResearchHeuristic(
  promptText: string,
  opts: { keywords?: readonly string[]; urlPatternBoost?: boolean } = {},
): HeuristicResult {
  const keywords = opts.keywords ?? DEFAULT_RESEARCH_KEYWORDS;
  const urlPatternBoost = opts.urlPatternBoost !== false;
  const text = typeof promptText === "string" ? promptText.toLowerCase() : "";
  if (!text.trim()) return { intent: "general", confidence: 0.4, signal: "empty" };

  const hasUrl = /https?:\/\/[^\s]+/.test(text);
  const keywordHit = keywords.some((keyword) => text.includes(keyword.toLowerCase()));

  if (keywordHit || (urlPatternBoost && hasUrl)) {
    return { intent: "research", confidence: 0.75, signal: keywordHit ? "keyword" : "url" };
  }
  return { intent: "general", confidence: 0.4, signal: "none" };
}

export interface SmartRoutingDispatch {
  (request: CanonicalRequest, candidates: readonly RouteCandidate[]): Promise<Response>;
}

/** Run the classifier model with a minimal non-streaming prompt. Throws on failure. */
async function classifyWithModel(
  dispatch: SmartRoutingDispatch,
  candidates: readonly RouteCandidate[],
  sourceSurface: SourceSurface,
  model: string,
  prompt: string,
): Promise<ResearchIntent> {
  const classifierRequest: CanonicalRequest = {
    model,
    messages: [{ role: "user", content: [{ kind: "text", text: prompt }] }],
    generation_controls: {},
    stream: false,
    source_surface: sourceSurface,
  };
  const response = await Promise.race([
    dispatch(classifierRequest, candidates),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("classifier timed out")), CLASSIFIER_TIMEOUT_MS),
    ),
  ]);
  const text = extractSurfaceText(sourceSurface, await response.clone().json());
  const firstWord = (String(text).trim().toLowerCase().match(/[a-z]+/) ?? [""])[0];
  return firstWord === "research" ? "research" : "general";
}

/**
 * Heuristic first, LLM classifier only when the heuristic is ambiguous AND a
 * classifier model is configured. Any classifier failure degrades to the
 * heuristic answer — never blocks the main request.
 */
export function buildIntentResolver(opts: {
  config: ResolvedSmartRoutingConfig;
  dispatch: SmartRoutingDispatch;
  /** All combo candidates; used to find a route for the classifier model. */
  candidates: readonly RouteCandidate[];
  sourceSurface: SourceSurface;
  log?: ((message: string) => void) | undefined;
}): (promptText: string) => Promise<ResearchIntent> {
  const { config, dispatch, candidates, sourceSurface, log } = opts;
  return async (promptText: string) => {
    const heuristic = detectResearchHeuristic(promptText, config);
    if (heuristic.confidence >= config.confidenceThreshold) return heuristic.intent;
    if (!config.classifierModel || !promptText.trim()) return heuristic.intent;

    const classifierGroups = groupCandidatesByModel(candidates);
    const classifierGroup = classifierGroups.find(
      (group) => group[0]!.model_id === config.classifierModel,
    );
    if (!classifierGroup) {
      log?.(`smart-routing: classifier ${config.classifierModel} has no route, using heuristic`);
      return heuristic.intent;
    }
    const prompt = config.classifierPrompt.replace("{{userPrompt}}", promptText);
    try {
      const label = await classifyWithModel(
        dispatch,
        classifierGroup,
        sourceSurface,
        config.classifierModel,
        prompt,
      );
      log?.(`smart-routing: intent classifier (${config.classifierModel}) → ${label}`);
      return label;
    } catch {
      log?.(`smart-routing: intent classifier failed — treating as ${heuristic.intent}`);
      return heuristic.intent;
    }
  };
}

export type SmartRoutingReason =
  | "tool_calling"
  | "tool_calling_pool_empty_fallback"
  | "research_preferred"
  | "research_pool_empty"
  | "general";

export interface SmartRoutingOrder {
  /** Member model_ids in try order. */
  readonly order: readonly string[];
  readonly reason: SmartRoutingReason;
  readonly details: Record<string, unknown>;
}

/**
 * Build the ordered member pool for ONE request. Pure ordering logic except
 * for the injected intent resolver (async classifier).
 */
export async function buildSmartRoutingOrder(input: {
  request: CanonicalRequest;
  /** Combo member model_ids in default order. */
  members: readonly string[];
  config: ResolvedSmartRoutingConfig;
  resolveIntent?: (promptText: string) => Promise<ResearchIntent>;
}): Promise<SmartRoutingOrder> {
  const { request, members, config } = input;
  const ordered = members.filter(Boolean);
  if (ordered.length === 0) return { order: [], reason: "general", details: {} };

  // STEP 1 — deterministic tool-calling check (wins over everything).
  if (requiresToolCalling(request)) {
    const excluded = new Set(config.noToolMembers);
    const base = config.toolCallingMembers ?? ordered.filter((m) => !excluded.has(m));
    const toolPool = base.filter((m) => ordered.includes(m) && !excluded.has(m));
    if (toolPool.length > 0) {
      return {
        order: toolPool,
        reason: "tool_calling",
        details: { excluded: ordered.filter((m) => !toolPool.includes(m)) },
      };
    }
    return {
      order: ordered,
      reason: "tool_calling_pool_empty_fallback",
      details: { note: "no tool-capable member in combo" },
    };
  }

  // STEP 2 — fuzzy research-intent check.
  const promptText = lastUserMessageText(request);
  let intent: ResearchIntent = "general";
  if (input.resolveIntent) {
    try {
      intent = await input.resolveIntent(promptText);
    } catch {
      intent = "general";
    }
  } else {
    const heuristic = detectResearchHeuristic(promptText, config);
    intent = heuristic.confidence >= config.confidenceThreshold ? heuristic.intent : "general";
  }

  if (intent === "research") {
    const preferred = config.researchMembers.filter((m) => ordered.includes(m));
    if (preferred.length > 0) {
      const rest = ordered.filter((m) => !preferred.includes(m));
      return {
        order: [...preferred, ...rest],
        reason: "research_preferred",
        details: { preferred, rest },
      };
    }
    return {
      order: ordered,
      reason: "research_pool_empty",
      details: { note: "no research-preferred member in combo; using default order" },
    };
  }

  // STEP 3 — default chain (combo member order).
  return { order: ordered, reason: "general", details: {} };
}

export interface SmartRoutingRunInput {
  readonly combo: ComboDefinition;
  /** Resolved combo name, for logging. */
  readonly comboName: string;
  readonly canonicalRequest: CanonicalRequest;
  readonly candidates: readonly RouteCandidate[];
  readonly requestId: string;
  /** Single dispatch over the ordered pool; fails over across candidates. */
  readonly dispatch: SmartRoutingDispatch;
  readonly log?: (message: string) => void;
}

/** Route one request: compute the per-request member order, then dispatch over it. */
export async function runSmartRoutingCombo(input: SmartRoutingRunInput): Promise<Response> {
  const { combo, comboName, canonicalRequest, candidates, dispatch } = input;
  const groups = groupCandidatesByModel(candidates);
  if (groups.length === 0) {
    throw new GatewayError("admission_unavailable", 503, "smart-routing combo has no candidates");
  }
  const members = groups.map((group) => group[0]!.model_id);
  const config = resolveSmartRoutingConfig(combo);
  const resolveIntent = buildIntentResolver({
    config,
    dispatch,
    candidates,
    sourceSurface: canonicalRequest.source_surface,
    log: input.log,
  });
  const routing = await buildSmartRoutingOrder({
    request: canonicalRequest,
    members,
    config,
    resolveIntent,
  });
  input.log?.(`smart-routing ${comboName}: reason=${routing.reason} order=[${routing.order.join(", ")}]`);
  updateInFlightDetail(input.requestId, { stage: `smart-routing · ${routing.reason}` });

  const byModel = new Map(groups.map((group) => [group[0]!.model_id, group] as const));
  const orderedCandidates = routing.order.flatMap((model) => byModel.get(model) ?? []);
  return dispatch(canonicalRequest, orderedCandidates);
}
