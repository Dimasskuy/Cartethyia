// Fusion combo strategy: parallel panel fan-out + judge synthesis.
//
// Every panel member answers the prompt independently and in parallel
// (non-streaming, tools stripped so the judge gets complete prose). A judge
// model then synthesizes ONE final answer from the panel responses —
// analyzing consensus, contradictions, partial coverage, unique insights,
// and blind spots — with sources anonymized so substance wins over brand.
//
// Collection uses quorum-grace: once `minPanel` legs succeed, stragglers get
// a short grace window, then the panel closes. A hard timeout caps every leg
// so one hung model can't stall the request.
//
// Strategy adapted from ExtremeRouter's fusion (MIT licensed): same
// quorum-grace collection and judge-synthesis shape, reimplemented against
// Cartethyia's canonical request/response pipeline instead of raw bodies.
import type { CanonicalRequest, ContentPart } from "../canonical-model";
import { GatewayError } from "../gateway-error";
import type { ComboDefinition, RouteCandidate } from "../routing/route-model";
import { extractSurfaceText, groupCandidatesByModel } from "./cascade";
import { throwIfAborted } from "./abort";
import { updateInFlightDetail } from "../request/inflight";

/** Fusion tuning defaults (mirrors ExtremeRouter's FUSION_DEFAULTS). */
export const FUSION_DEFAULTS = {
  /** Answers needed before stragglers get a grace window. */
  minPanel: 2,
  /** Ms to wait for laggards once quorum is reached. */
  stragglerGraceMs: 8000,
  /** Hard cap per panel leg and the judge call, in ms. */
  panelTimeoutMs: 90000,
} as const;

/** Upper bound for a panel answer injected into the judge prompt. */
const PANEL_ANSWER_MAX_CHARS = 12_000;

export interface ResolvedFusionConfig {
  /** Judge model ref as configured; null = default (first panel member). */
  readonly judgeModel: string | null;
  readonly minPanel: number;
  readonly stragglerGraceMs: number;
  readonly panelTimeoutMs: number;
  /** Custom judge directive header; null = built-in. */
  readonly judgePrompt: string | null;
}

/** Merge the combo's stored tuning over the defaults, clamped defensively. */
export function resolveFusionConfig(
  combo: ComboDefinition,
  panelSize: number,
): ResolvedFusionConfig {
  const raw = combo.config?.fusion ?? {};
  const size = Math.max(1, panelSize);
  const minPanel =
    typeof raw.minPanel === "number" && Number.isFinite(raw.minPanel)
      ? Math.min(size, Math.max(1, Math.floor(raw.minPanel)))
      : Math.min(size, FUSION_DEFAULTS.minPanel);
  const stragglerGraceMs =
    typeof raw.stragglerGraceMs === "number" && Number.isFinite(raw.stragglerGraceMs)
      ? Math.min(60000, Math.max(0, Math.floor(raw.stragglerGraceMs)))
      : FUSION_DEFAULTS.stragglerGraceMs;
  const panelTimeoutMs =
    typeof raw.panelTimeoutMs === "number" && Number.isFinite(raw.panelTimeoutMs)
      ? Math.min(600000, Math.max(1000, Math.floor(raw.panelTimeoutMs)))
      : FUSION_DEFAULTS.panelTimeoutMs;
  return {
    judgeModel:
      typeof raw.judgeModel === "string" && raw.judgeModel.trim().length > 0
        ? raw.judgeModel.trim()
        : null,
    minPanel,
    stragglerGraceMs,
    panelTimeoutMs,
    judgePrompt:
      typeof raw.judgePrompt === "string" && raw.judgePrompt.trim().length > 0
        ? raw.judgePrompt
        : null,
  };
}

function defaultJudgeHeader(answerCount: number): string {
  return [
    `You are the JUDGE in a model-fusion panel. ${answerCount} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
  ].join("\n");
}

/**
 * Build the judge directive: role header, anonymized panel answers
 * ("Source N" — never the model names), then the closing instruction.
 */
export function buildJudgeDirective(
  answers: readonly { readonly text: string }[],
  judgePrompt: string | null,
): string {
  const header =
    judgePrompt && judgePrompt.trim().length > 0
      ? judgePrompt.trim()
      : defaultJudgeHeader(answers.length);
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text.slice(0, PANEL_ANSWER_MAX_CHARS)}`)
    .join("\n\n");
  return [
    header,
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

/**
 * Panel legs run non-streaming with tools stripped: the judge needs complete
 * prose to synthesize, and tool calls from N models can't be merged sanely.
 */
export function withPanelRequest(request: CanonicalRequest): CanonicalRequest {
  // Strip via destructuring: exactOptionalPropertyTypes forbids assigning
  // `undefined` to the optional tool fields explicitly.
  const { tools: _tools, tool_choice: _toolChoice, ...rest } = request;
  return { ...rest, stream: false };
}

function appendDirectiveToUserTurn(request: CanonicalRequest, directive: string): CanonicalRequest {
  const messages = request.messages;
  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user") {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) targetIndex = messages.length - 1;
  const directivePart: ContentPart = { kind: "text", text: `\n\n${directive}` };
  if (targetIndex < 0) {
    return {
      ...request,
      messages: [{ role: "user", content: [directivePart] }],
    };
  }
  const updated = messages.map((message, index) =>
    index === targetIndex ? { ...message, content: [...message.content, directivePart] } : message,
  );
  return { ...request, messages: updated };
}

/**
 * Build the judge request: the synthesis directive (with anonymized panel
 * answers) appended to the last user turn. The client's stream flag and
 * tools are preserved so streaming and downstream tool use still work.
 */
export function withJudgePrompt(
  request: CanonicalRequest,
  answers: readonly { readonly text: string }[],
  cfg: ResolvedFusionConfig,
): CanonicalRequest {
  return appendDirectiveToUserTurn(request, buildJudgeDirective(answers, cfg.judgePrompt));
}

type LegOutcome =
  | { readonly status: "ok"; readonly response: Response }
  | { readonly status: "timeout" }
  | { readonly status: "error"; readonly error: unknown };

/**
 * Quorum-grace parallel collection. Each leg is raced against
 * `panelTimeoutMs`; once `minPanel` legs succeed, stragglers get
 * `stragglerGraceMs` before the panel closes. Returns a sparse array aligned
 * to `legs` (undefined = dropped after the panel closed early).
 */
export async function collectPanel(
  legs: readonly Promise<Response>[],
  opts: { minPanel: number; stragglerGraceMs: number; panelTimeoutMs: number },
): Promise<readonly (LegOutcome | undefined)[]> {
  const out: (LegOutcome | undefined)[] = new Array(legs.length);
  if (legs.length === 0) return out;
  let settled = 0;
  let ok = 0;
  let finished = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  return new Promise((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      if (graceTimer !== null) clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      resolve(out);
    };
    // Safety net: every leg times out individually, but never hang forever.
    const hardTimer = setTimeout(finish, opts.panelTimeoutMs + opts.stragglerGraceMs + 5000);
    legs.forEach((leg, index) => {
      const timed: Promise<LegOutcome> = Promise.race([
        leg.then(
          (response): LegOutcome => ({ status: "ok", response }),
          (error): LegOutcome => ({ status: "error", error }),
        ),
        new Promise<LegOutcome>((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ status: "timeout" }), opts.panelTimeoutMs),
        ),
      ]);
      void timed.then((outcome) => {
        if (finished) return;
        out[index] = outcome;
        settled += 1;
        if (outcome.status === "ok") ok += 1;
        if (settled === legs.length) {
          finish();
          return;
        }
        if (ok >= opts.minPanel && graceTimer === null) {
          graceTimer = setTimeout(finish, opts.stragglerGraceMs);
        }
      });
    });
  });
}

async function withLegTimeout(
  promise: Promise<Response>,
  ms: number,
  label: string,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(
          () => reject(new GatewayError("transport_unavailable", 504, `${label} timed out`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export interface FusionDispatch {
  (request: CanonicalRequest, candidates: readonly RouteCandidate[]): Promise<Response>;
}

export interface FusionRunInput {
  readonly combo: ComboDefinition;
  /** Resolved combo name, for logging. */
  readonly comboName: string;
  readonly canonicalRequest: CanonicalRequest;
  readonly candidates: readonly RouteCandidate[];
  readonly requestId: string;
  /** Single-model dispatch: runs the attempt loop over one member's group. */
  readonly dispatch: FusionDispatch;
  /**
   * Owning request's abort signal. Checked around the panel fan-out and the
   * judge call so a cancelled request stops instead of judging answers
   * nobody will ever read.
   */
  readonly signal: AbortSignal;
  readonly log?: (message: string) => void;
}

/**
 * Run the fusion panel: fan out in parallel, collect with quorum-grace,
 * then have the judge synthesize one final answer.
 */
export async function runFusionCombo(input: FusionRunInput): Promise<Response> {
  const { combo, comboName, canonicalRequest, candidates, dispatch, signal } = input;
  throwIfAborted(signal);
  const groups = groupCandidatesByModel(candidates);
  if (groups.length === 0) {
    throw new GatewayError("admission_unavailable", 503, "fusion combo has no candidates");
  }
  const panelModels = groups.map((group) => group[0]!.model_id);

  // A single-model fusion has nothing to fuse — answer directly.
  if (groups.length === 1) {
    input.log?.(`fusion ${comboName}: single panel member, answering directly`);
    return dispatch(canonicalRequest, groups[0]!);
  }

  const cfg = resolveFusionConfig(combo, groups.length);
  let judgeModel = panelModels[0]!;
  if (cfg.judgeModel) {
    if (panelModels.includes(cfg.judgeModel)) {
      judgeModel = cfg.judgeModel;
    } else {
      input.log?.(
        `fusion ${comboName}: judge ${cfg.judgeModel} is not a panel member, falling back to ${judgeModel}`,
      );
    }
  }
  input.log?.(
    `fusion ${comboName}: panel=${groups.length} [${panelModels.join(", ")}] judge=${judgeModel} quorum=${cfg.minPanel}`,
  );

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped.
  const panelRequest = withPanelRequest(canonicalRequest);
  updateInFlightDetail(input.requestId, { stage: `fusion · panel ×${groups.length}` });
  const legs = groups.map((group) => dispatch(panelRequest, group));
  const settled = await collectPanel(legs, cfg);
  // A cancelled request must stop here — every leg already failed fast, and
  // judging an empty panel would misreport the cancellation as a 503.
  throwIfAborted(signal);

  // 2. Collect successful answers.
  const answers: { model: string; text: string; response: Response }[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    const model = panelModels[i]!;
    if (!outcome) {
      input.log?.(`fusion ${comboName}: panel ${model} dropped (panel closed early)`);
      continue;
    }
    if (outcome.status === "timeout") {
      input.log?.(`fusion ${comboName}: panel ${model} timed out`);
      continue;
    }
    if (outcome.status === "error") {
      input.log?.(`fusion ${comboName}: panel ${model} errored`);
      continue;
    }
    let text = "";
    try {
      text = extractSurfaceText(canonicalRequest.source_surface, await outcome.response.clone().json());
    } catch {
      input.log?.(`fusion ${comboName}: panel ${model} returned an unparseable body`);
      continue;
    }
    if (!text.trim()) {
      input.log?.(`fusion ${comboName}: panel ${model} returned empty content`);
      continue;
    }
    answers.push({ model, text, response: outcome.response });
    input.log?.(`fusion ${comboName}: panel ${model} ok (${text.length} chars)`);
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    throw new GatewayError("admission_unavailable", 503, "All fusion panel models failed");
  }
  if (answers.length === 1) {
    const survivor = answers[0]!;
    if (canonicalRequest.stream) {
      // The survivor was forced to stream:false; re-run with the original
      // request so the client's SSE contract is honored.
      input.log?.(`fusion ${comboName}: only ${survivor.model} succeeded — re-running with stream:true`);
      const group = groups[panelModels.indexOf(survivor.model)]!;
      return dispatch(canonicalRequest, group);
    }
    input.log?.(`fusion ${comboName}: only ${survivor.model} succeeded — returning directly`);
    return survivor.response;
  }

  // 4. Judge analyzes + writes one final answer (streams if requested).
  const judgeGroup = groups[panelModels.indexOf(judgeModel)]!;
  const judgeRequest = withJudgePrompt(canonicalRequest, answers, cfg);
  input.log?.(`fusion ${comboName}: judging ${answers.length} answers with ${judgeModel}`);
  throwIfAborted(signal);
  updateInFlightDetail(input.requestId, { stage: "fusion · judging" });
  return withLegTimeout(
    dispatch(judgeRequest, judgeGroup),
    cfg.panelTimeoutMs,
    `Judge ${judgeModel}`,
  );
}
