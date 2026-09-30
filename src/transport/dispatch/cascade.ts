// Cascade combo strategy: progressive escalation from cheap to capable models.
//
// Each stage asks the model to self-rate its confidence (0-100). When the
// confidence meets the threshold the answer is returned; otherwise the next
// (stronger) member gets the prior answer as context and tries again. The
// final stage always returns, guaranteeing a response.
//
// Strategy adapted from ExtremeRouter's cascade (MIT licensed): same
// confidence-marker protocol (`CONFIDENCE: <0-100>` trailing the answer),
// same escalation shape, reimplemented against Cartethyia's canonical
// request/response pipeline instead of raw provider bodies.
//
// Stages run non-streaming internally so the confidence marker can be parsed
// from the completed body; when the client asked for `stream: true` the
// winning stage is re-encoded as SSE through the shared dispatch stream
// encoder, so the client's stream contract is honored on the outer boundary.
import type {
  CanonicalRequest,
  ContentPart,
  SourceSurface,
} from "../canonical-model";
import { GatewayError } from "../gateway-error";
import type { ComboDefinition, RouteCandidate } from "../routing/route-model";
import { createDispatchStreamEncoder } from "./stream-bridge";
import { throwIfAborted } from "./abort";
import { updateInFlightDetail } from "../request/inflight";

/** Cascade tuning defaults. */
export const CASCADE_DEFAULTS = {
  confidenceThreshold: 70,
  confidencePrompt:
    "Rate your confidence in this answer from 0 to 100. End your response with exactly: CONFIDENCE: <number>",
  escalatePrompt:
    "A prior model gave the following answer with low confidence. Review it, correct any issues, and provide a better answer.",
  maxStages: 3,
} as const;

/** Upper bound for the prior answer injected into an escalation stage. */
const PRIOR_ANSWER_MAX_CHARS = 12_000;

export interface ResolvedCascadeConfig {
  readonly confidenceThreshold: number;
  readonly confidencePrompt: string;
  readonly escalatePrompt: string;
  readonly maxStages: number;
}

/** Merge the combo's stored tuning over the defaults, clamped defensively. */
export function resolveCascadeConfig(combo: ComboDefinition): ResolvedCascadeConfig {
  const raw = combo.config?.cascade ?? {};
  const threshold =
    typeof raw.confidenceThreshold === "number" && Number.isFinite(raw.confidenceThreshold)
      ? Math.min(100, Math.max(0, raw.confidenceThreshold))
      : CASCADE_DEFAULTS.confidenceThreshold;
  const maxStages =
    typeof raw.maxStages === "number" && Number.isFinite(raw.maxStages)
      ? Math.min(8, Math.max(1, Math.floor(raw.maxStages)))
      : CASCADE_DEFAULTS.maxStages;
  return {
    confidenceThreshold: threshold,
    confidencePrompt:
      typeof raw.confidencePrompt === "string" && raw.confidencePrompt.trim().length > 0
        ? raw.confidencePrompt
        : CASCADE_DEFAULTS.confidencePrompt,
    escalatePrompt:
      typeof raw.escalatePrompt === "string" && raw.escalatePrompt.trim().length > 0
        ? raw.escalatePrompt
        : CASCADE_DEFAULTS.escalatePrompt,
    maxStages,
  };
}

/** Parse the trailing `CONFIDENCE: <0-100>` marker. Returns -1 when absent
 * or malformed — treated as "unknown", which escalates. */
export function parseConfidence(text: string): number {
  if (!text || typeof text !== "string") return -1;
  const match = text.match(/CONFIDENCE:\s*(\d{1,3})\s*$/i);
  if (!match) return -1;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : -1;
}

/** Strip the confidence marker so the client never sees the machinery. */
export function stripConfidenceMarker(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text.replace(/\s*CONFIDENCE:\s*\d{1,3}\s*$/i, "").trim();
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? ((part as { text: string }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** Extract the assistant's text from a completed surface JSON body. */
export function extractSurfaceText(surface: SourceSurface, body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  switch (surface) {
    case "chat": {
      const choice = (record.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const message = choice?.message as Record<string, unknown> | undefined;
      return asText(message?.content);
    }
    case "completion": {
      const choice = (record.choices as Array<Record<string, unknown>> | undefined)?.[0];
      return typeof choice?.text === "string" ? choice.text : "";
    }
    case "messages": {
      const content = record.content;
      if (!Array.isArray(content)) return "";
      return content
        .filter(
          (block): block is { type: string; text?: unknown } =>
            !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
        )
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .join("");
    }
    case "responses": {
      const output = record.output;
      if (!Array.isArray(output)) return "";
      const texts: string[] = [];
      for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const typed = item as { type?: unknown; content?: unknown };
        if (typed.type !== "message" || !Array.isArray(typed.content)) continue;
        for (const part of typed.content) {
          if (!part || typeof part !== "object") continue;
          const p = part as { type?: unknown; text?: unknown };
          if ((p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
            texts.push(p.text);
          }
        }
      }
      return texts.join("");
    }
  }
}

/**
 * Build the stage request: the cascade directive appended to the last user
 * turn (or the last turn when there is no user turn), streaming forced off
 * so the stage's confidence marker can be parsed from the completed body.
 */
export function withCascadePrompt(
  request: CanonicalRequest,
  prior: { readonly text: string; readonly model: string } | null,
  cfg: ResolvedCascadeConfig,
): CanonicalRequest {
  const directive =
    prior === null
      ? cfg.confidencePrompt
      : `${cfg.escalatePrompt}\n\n--- Prior answer (${prior.model}) ---\n${prior.text.slice(0, PRIOR_ANSWER_MAX_CHARS)}\n--- End prior answer ---\n\n${cfg.confidencePrompt}`;
  const messages = request.messages;
  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user") {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) targetIndex = messages.length - 1;
  if (targetIndex < 0) {
    // No messages at all: carry the directive as the whole user turn.
    return {
      ...request,
      stream: false,
      messages: [{ role: "user", content: [{ kind: "text", text: directive }] }],
    };
  }
  const directivePart: ContentPart = { kind: "text", text: `\n\n${directive}` };
  const updated = messages.map((message, index) =>
    index === targetIndex ? { ...message, content: [...message.content, directivePart] } : message,
  );
  return { ...request, stream: false, messages: updated };
}

/** Group ordered candidates back into per-member stages, preserving the
 * router's member order. */
export function groupCandidatesByModel(
  candidates: readonly RouteCandidate[],
): RouteCandidate[][] {
  const groups: RouteCandidate[][] = [];
  const byModel = new Map<string, RouteCandidate[]>();
  for (const candidate of candidates) {
    let group = byModel.get(candidate.model_id);
    if (!group) {
      group = [];
      byModel.set(candidate.model_id, group);
      groups.push(group);
    }
    group.push(candidate);
  }
  return groups;
}

/**
 * Re-encode a completed JSON stage response as SSE for clients that asked
 * for `stream: true`. Synthesizes canonical events through the shared
 * dispatch stream encoder so cascade streams frame exactly like live ones.
 */
export function cascadeJsonToSse(
  surface: SourceSurface,
  bodyText: string,
  model: string,
  requestId: string,
): Response {
  let text = "";
  try {
    text = stripConfidenceMarker(extractSurfaceText(surface, JSON.parse(bodyText)));
  } catch {
    // Fall through with empty text; the terminal event still closes the stream.
  }
  const encoder = createDispatchStreamEncoder(surface, {
    created: Date.now() / 1000,
    model,
    include_usage: false,
  });
  const now = Date.now();
  const chunks: Uint8Array[] = [];
  // A few chunks rather than one: downstream SSE parsers see content deltas.
  const pieceSize = Math.max(1, Math.ceil(text.length / 4));
  let sequence = 0;
  for (let offset = 0; offset < text.length; offset += pieceSize) {
    chunks.push(
      ...encoder.push({
        type: "content_delta",
        sequence_number: sequence++,
        content: { kind: "text", text: text.slice(offset, offset + pieceSize) },
        timestamp: now,
      }),
    );
  }
  chunks.push(
    ...encoder.push({
      type: "terminal",
      sequence_number: sequence++,
      state: "complete",
      timestamp: now,
    }),
  );
  chunks.push(...encoder.finish());
  const bytes = concatChunks(chunks);
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": "text/event-stream",
      connection: "keep-alive",
      "x-request-id": requestId,
      // Intermediaries (nginx, Cloudflare, corporate proxies) otherwise
      // buffer the whole SSE response and flush it at the end, which
      // makes a live stream look like one delayed chunk. `no-transform`
      // forbids compression and `x-accel-buffering: no` disables nginx
      // proxy buffering for this response.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface CascadeDispatch {
  (request: CanonicalRequest, candidates: readonly RouteCandidate[]): Promise<Response>;
}

export interface CascadeRunInput {
  readonly combo: ComboDefinition;
  /** Resolved combo name, for logging. */
  readonly comboName: string;
  readonly canonicalRequest: CanonicalRequest;
  readonly candidates: readonly RouteCandidate[];
  readonly requestId: string;
  /** Single-stage dispatch: runs the attempt loop over one member's group. */
  readonly dispatch: CascadeDispatch;
  /**
   * Owning request's abort signal. Checked before each stage so a cancelled
   * request stops instead of escalating through more members.
   */
  readonly signal: AbortSignal;
  readonly log?: (message: string) => void;
}

/**
 * Run the cascade stage loop. Returns the winning stage's response —
 * converted to SSE when the client asked for streaming.
 */
export async function runCascadeCombo(input: CascadeRunInput): Promise<Response> {
  const { combo, comboName, canonicalRequest, candidates, dispatch, signal } = input;
  throwIfAborted(signal);
  const cfg = resolveCascadeConfig(combo);
  const groups = groupCandidatesByModel(candidates);
  if (groups.length === 0) {
    throw new GatewayError("admission_unavailable", 503, "cascade combo has no candidates");
  }
  const maxStages = Math.min(Math.max(1, cfg.maxStages), groups.length);
  const wantStream = canonicalRequest.stream;
  const surface = canonicalRequest.source_surface;
  let prior: { readonly text: string; readonly model: string } | null = null;

  for (let stage = 0; stage < maxStages; stage += 1) {
    const group = groups[stage]!;
    const modelId = group[0]!.model_id;
    throwIfAborted(signal);
    updateInFlightDetail(input.requestId, { stage: `cascade · stage ${stage + 1}/${maxStages}` });
    const isFinal = stage === maxStages - 1;
    const stageRequest = withCascadePrompt(canonicalRequest, prior, cfg);
    input.log?.(`cascade ${comboName}: stage ${stage + 1}/${maxStages} (${modelId})`);

    let response: Response;
    try {
      response = await dispatch(stageRequest, group);
    } catch (error) {
      // A cancelled request must stop here, not escalate to the next member.
      if (signal.aborted) throw error;
      // Stage failed (provider down, no eligible account...): escalate to the
      // next member, keeping the last successful stage's answer as context.
      input.log?.(`cascade ${comboName}: stage ${stage + 1} failed, escalating`);
      if (isFinal) throw error;
      continue;
    }

    if (isFinal) {
      input.log?.(`cascade ${comboName}: final stage (${modelId}) returning`);
      return adaptStageResponse(response, surface, modelId, wantStream, input.requestId);
    }

    let text = "";
    try {
      text = extractSurfaceText(surface, await response.clone().json());
    } catch {
      // Best-effort: unparseable bodies escalate like unknown confidence.
    }
    const confidence = parseConfidence(text);
    input.log?.(`cascade ${comboName}: stage ${stage + 1} confidence=${confidence}`);
    if (confidence >= 0 && confidence >= cfg.confidenceThreshold) {
      input.log?.(`cascade ${comboName}: stage ${stage + 1} confident, returning`);
      return adaptStageResponse(response, surface, modelId, wantStream, input.requestId);
    }
    prior = { text: stripConfidenceMarker(text) || text, model: modelId };
  }

  // Unreachable: the final stage always returns. Guarded anyway.
  throw new GatewayError("admission_unavailable", 502, "cascade exhausted all stages");
}

async function adaptStageResponse(
  response: Response,
  surface: SourceSurface,
  model: string,
  wantStream: boolean,
  requestId: string,
): Promise<Response> {
  if (!wantStream) return response;
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    return response;
  }
  return cascadeJsonToSse(surface, bodyText, model, requestId);
}
