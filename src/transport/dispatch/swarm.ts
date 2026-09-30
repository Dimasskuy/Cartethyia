// Swarm combo strategy: hierarchical multi-agent orchestration.
//
//   Stage 0  Gatekeeper — the manager model classifies the request as
//            SIMPLE (answered directly) or COMPLEX (full swarm pipeline).
//   Stage 1  Manager strategy — decomposes the request into a JSON plan of
//            independent subtasks.
//   Stage 2  Worker dispatch — subtasks fan out in parallel across the
//            worker pool (quorum + straggler grace, like fusion's panel).
//   Stage 3  Staff audit (optional) — compiles worker outputs into a
//            technical audit report.
//   Stage 4  Manager synthesis — one final answer, streamed to the client.
//
// Internal legs run non-streaming with tools stripped; only the final
// synthesis preserves the client's stream flag and tools. Any stage failure
// degrades gracefully: a gatekeeper failure assumes COMPLEX, an unparseable
// strategy or too few workers falls back to a direct manager answer, and an
// uncaught error degrades to a direct answer as well.
//
// Strategy adapted from ExtremeRouter's hierarchical swarm engine
// (MIT licensed). ExtremeRouter's role-capability validation (cookie
// providers cannot serve control roles), run-budget output clamps, and
// telemetry hooks have no Cartethyia equivalent and are omitted; stage
// progress is reported through the log callback instead.
import type { CanonicalRequest } from "../canonical-model";
import { GatewayError } from "../gateway-error";
import type { ComboDefinition, RouteCandidate } from "../routing/route-model";
import { throwIfAborted } from "./abort";
import { extractSurfaceText, groupCandidatesByModel } from "./cascade";
import { withPanelRequest } from "./fusion";
import { updateInFlightDetail } from "../request/inflight";

/** Tuning defaults. Overridable per combo. */
export const SWARM_DEFAULTS = {
  workerHardTimeoutMs: 90_000, // absolute cap per worker call
  workerQuorum: 2, // min workers that must succeed before the grace window
  stragglerGraceMs: 10_000, // wait this long for laggard workers once quorum hit
  managerTimeoutMs: 60_000, // cap for each coordinator (gatekeeper/manager/audit) call
  minWorkers: 2, // if fewer workers succeed, fall back to direct
  maxWorkers: 8, // safety cap on fan-out width
} as const;

export interface SwarmSubtask {
  readonly id: number;
  readonly title: string;
  readonly role: string;
  readonly instruction: string;
}

export interface SwarmStrategy {
  readonly assessment: string;
  readonly subtasks: readonly SwarmSubtask[];
}

export interface ResolvedSwarmConfig {
  /** Manager/coordinator model ref; defaults to the first combo member. */
  readonly managerModel: string;
  /** Staff/audit model ref; null = audit stage skipped. */
  readonly staffModel: string | null;
  /** Worker pool model refs; defaults to all combo members. */
  readonly workerModels: readonly string[];
  /** Cap on subtasks dispatched per request. */
  readonly workerCount: number;
  readonly minWorkers: number;
  readonly maxWorkers: number;
  readonly workerQuorum: number;
  readonly stragglerGraceMs: number;
  readonly workerHardTimeoutMs: number;
  readonly managerTimeoutMs: number;
}

const asStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

/** Merge the combo's stored tuning over the defaults, clamped defensively. */
export function resolveSwarmConfig(
  combo: ComboDefinition,
  members: readonly string[],
): ResolvedSwarmConfig {
  const raw = combo.config?.swarm ?? {};
  const first = members[0] ?? "";
  const managerModel =
    typeof raw.managerModel === "string" && raw.managerModel.trim() ? raw.managerModel.trim() : first;
  const staffModel =
    typeof raw.staffModel === "string" && raw.staffModel.trim() ? raw.staffModel.trim() : null;
  const configured = asStringList(raw.workerModels).filter((m) => members.includes(m));
  const workerModels = configured.length > 0 ? configured : members.filter(Boolean);
  return {
    managerModel,
    staffModel,
    workerModels,
    workerCount: clampInt(raw.workerCount, 1, 16, SWARM_DEFAULTS.maxWorkers),
    minWorkers: clampInt(raw.minWorkers, 1, 8, SWARM_DEFAULTS.minWorkers),
    maxWorkers: clampInt(raw.maxWorkers, 1, 16, SWARM_DEFAULTS.maxWorkers),
    workerQuorum: clampInt(raw.workerQuorum, 1, 8, SWARM_DEFAULTS.workerQuorum),
    stragglerGraceMs: clampInt(raw.stragglerGraceMs, 0, 120_000, SWARM_DEFAULTS.stragglerGraceMs),
    workerHardTimeoutMs: clampInt(
      raw.workerHardTimeoutMs,
      1_000,
      600_000,
      SWARM_DEFAULTS.workerHardTimeoutMs,
    ),
    managerTimeoutMs: clampInt(raw.managerTimeoutMs, 1_000, 600_000, SWARM_DEFAULTS.managerTimeoutMs),
  };
}

// ── Role prompts ──────────────────────────────────────────────────────────

const GATEKEEPER_PROMPT = [
  "=== SWARM GATEKEEPER ===",
  "You are the GATEKEEPER of a hierarchical swarm. Classify the user's most recent request as SIMPLE or COMPLEX.",
  "",
  "SIMPLE = greeting, small talk, a factual question, a one-line clarification, or anything answerable in under ~50 tokens without decomposition.",
  "COMPLEX = a coding task, multi-step build request, design problem, debugging session, or anything benefiting from decomposition into parallel specialist work.",
  "",
  "Respond with EXACTLY one line, nothing else:",
  "VERDICT: SIMPLE",
  "or",
  "VERDICT: COMPLEX",
].join("\n");

function buildManagerStrategyPrompt(userPrompt: string): string {
  return [
    "=== SWARM MANAGER (STRATEGY) ===",
    "You are the MANAGER of a hierarchical swarm. Analyze the user's request and produce a high-level execution strategy that decomposes it into independent parallel subtasks.",
    "",
    "Respond with ONLY a JSON object (no markdown fences, no prose) of this exact shape:",
    `{`,
    `  "assessment": "<1-2 sentence summary of what the request needs>",`,
    `  "subtasks": [`,
    `    { "id": 1, "title": "<short title>", "role": "<architecture|game-logic|data-layer|ui|testing|security|devops|default>", "instruction": "<detailed instruction for the specialist worker>" }`,
    `  ]`,
    `}`,
    "",
    "Rules:",
    "- Aim for 2-5 subtasks. Each must be independently executable in parallel.",
    "- `role` must be one of the listed values; pick the best specialist fit.",
    "- `instruction` must be self-contained — a worker sees only its own subtask.",
    "- Do NOT include integration/assembly as a subtask; the Staff auditor + Manager synthesis handle that.",
    "",
    "=== USER REQUEST ===",
    userPrompt,
  ].join("\n");
}

const WORKER_SPECIALIST_HINTS: Record<string, string> = {
  architecture: "You are a senior software architect. Focus on structure, interfaces, and design trade-offs.",
  "game-logic": "You are a game-logic specialist. Focus on rules, state, and gameplay systems.",
  "data-layer": "You are a data-layer specialist. Focus on schemas, storage, and data flow.",
  ui: "You are a UI specialist. Focus on layout, components, and user experience.",
  testing: "You are a testing specialist. Focus on test coverage, edge cases, and verification.",
  security: "You are a security specialist. Focus on threats, validation, and safe practices.",
  devops: "You are a DevOps specialist. Focus on build, deployment, and operations.",
  default: "You are a specialist engineer. Focus on completing the subtask thoroughly and correctly.",
};

function buildWorkerDirective(subtask: SwarmSubtask): string {
  const hint = WORKER_SPECIALIST_HINTS[subtask.role] ?? WORKER_SPECIALIST_HINTS.default!;
  const instruction = subtask.instruction || subtask.title || "Complete your assigned subtask.";
  return [
    "=== SWARM WORKER DIRECTIVE ===",
    hint,
    "",
    `Subtask: ${subtask.title || "Untitled"}`,
    "",
    instruction,
    "",
    "Output ONLY your work for this subtask. Do not reference other workers or the orchestrator.",
    "=== END DIRECTIVE ===",
  ].join("\n");
}

function buildStaffAuditPrompt(subtasks: readonly (SwarmSubtask & { output: string })[]): string {
  const report = subtasks
    .map(
      (st) =>
        `### Subtask ${st.id}: ${st.title}\nRole: ${st.role}\nInstruction: ${st.instruction}\n\n#### Worker Output\n${st.output || "(worker did not produce output)"}`,
    )
    .join("\n\n---\n\n");
  return [
    "=== SWARM STAFF (AUDIT) ===",
    "You are the STAFF auditor of a hierarchical swarm. Specialist workers have independently completed their assigned subtasks. Your job is to produce a TECHNICAL AUDIT REPORT that the Manager will use to synthesize the final answer.",
    "",
    "For each worker output, evaluate:",
    "- Completeness: did it fulfill the subtask instruction?",
    "- Correctness: any bugs, type errors, logic flaws, or missing edge cases?",
    "- Consistency: naming conflicts, duplicated logic, or mismatched interfaces with other workers?",
    "- Integration risks: what will need reconciliation when combining outputs?",
    "",
    "Then provide a CONSOLIDATION PLAN: the order in which outputs should be merged, what conflicts to resolve, and what gaps remain.",
    "",
    "=== SUBTASKS & WORKER OUTPUTS ===",
    report,
    "=== END ===",
    "",
    "Now write the technical audit report. Be concrete and specific. Reference subtask IDs.",
  ].join("\n");
}

function buildManagerSynthesisPrompt(auditOrOutputs: string, userPrompt: string): string {
  return [
    "=== SWARM MANAGER (SYNTHESIS) ===",
    "You are the MANAGER producing the FINAL ANSWER. A Staff auditor has reviewed the parallel worker outputs and produced a technical audit report below. Synthesize ONE cohesive, complete, production-quality answer for the user's original request.",
    "",
    "Rules:",
    "- Resolve any conflicts the auditor flagged.",
    "- Integrate all worker outputs into a single coherent result (codebase, explanation, or both).",
    "- Do NOT mention the swarm, workers, audit, or that multiple agents were used. The user sees only your final answer.",
    "- Match the user's language and intent exactly.",
    "",
    "=== TECHNICAL AUDIT REPORT ===",
    auditOrOutputs,
    "=== END AUDIT ===",
    "",
    "=== ORIGINAL USER REQUEST ===",
    userPrompt,
    "",
    "Now produce the final answer.",
  ].join("\n");
}

// ── Strategy parsing ──────────────────────────────────────────────────────

/**
 * Scan a string for complete JSON object blocks using brace-depth tracking
 * with string-context awareness. Correctly handles braces inside string
 * values (e.g. code snippets). Blocks are yielded innermost-first as they
 * close, so complete subtask objects are salvaged even when the outer
 * strategy object was truncated mid-output.
 */
function* scanJsonBlocks(text: string): Generator<string> {
  const stack: number[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      stack.push(i);
    } else if (ch === "}") {
      const start = stack.pop();
      if (start !== undefined) yield text.slice(start, i + 1);
    }
  }
}

/** Parse the manager's strategy JSON; lenient recovery for truncated output. */
export function parseSwarmStrategy(text: string): SwarmStrategy | null {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

  // Attempt 1: strict parse of the outermost object.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
        assessment?: unknown;
        subtasks?: unknown;
      };
      if (Array.isArray(obj.subtasks) && obj.subtasks.length > 0) {
        return { assessment: String(obj.assessment ?? ""), subtasks: normalizeSubtasks(obj.subtasks) };
      }
    } catch {
      // fall through to lenient recovery
    }
  }

  // Attempt 2: salvage complete subtask objects from truncated output.
  const subtaskBlocks: SwarmSubtask[] = [];
  for (const blockText of scanJsonBlocks(cleaned)) {
    if (!/"id"\s*:/.test(blockText)) continue;
    try {
      const parsed = JSON.parse(blockText) as Record<string, unknown>;
      if (parsed && (parsed.title || parsed.instruction || parsed.role)) {
        subtaskBlocks.push({
          id: typeof parsed.id === "number" ? parsed.id : subtaskBlocks.length + 1,
          title: String(parsed.title ?? `Subtask ${subtaskBlocks.length + 1}`),
          role: String(parsed.role ?? "default"),
          instruction: String(parsed.instruction ?? parsed.title ?? ""),
        });
      }
    } catch {
      // skip unparseable individual block
    }
  }
  if (subtaskBlocks.length > 0) {
    return { assessment: "(recovered from truncated output)", subtasks: subtaskBlocks };
  }
  return null;
}

function normalizeSubtasks(raw: unknown[]): SwarmSubtask[] {
  return raw.map((item, index) => {
    const obj = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    return {
      id: typeof obj.id === "number" ? obj.id : index + 1,
      title: String(obj.title ?? `Subtask ${index + 1}`),
      role: String(obj.role ?? "default"),
      instruction: String(obj.instruction ?? obj.title ?? ""),
    };
  });
}

// ── Stage helpers ─────────────────────────────────────────────────────────

export interface SwarmDispatch {
  (request: CanonicalRequest, candidates: readonly RouteCandidate[]): Promise<Response>;
}

/** Coordinator/worker legs: strip tools, force non-streaming, append a user turn. */
function buildInternalRequest(base: CanonicalRequest, directive: string): CanonicalRequest {
  const panel = withPanelRequest(base);
  return {
    ...panel,
    messages: [
      ...panel.messages,
      { role: "user", content: [{ kind: "text", text: directive }] },
    ],
  };
}

/** The final synthesis: original request + directive, stream/tools preserved. */
function buildSynthesisRequest(base: CanonicalRequest, directive: string): CanonicalRequest {
  return {
    ...base,
    messages: [
      ...base.messages,
      { role: "user", content: [{ kind: "text", text: directive }] },
    ],
  };
}

function lastUserText(request: CanonicalRequest): string {
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

async function readLegText(
  dispatch: SwarmDispatch,
  request: CanonicalRequest,
  candidates: readonly RouteCandidate[],
  sourceSurface: CanonicalRequest["source_surface"],
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const response = await Promise.race([
      dispatch(request, candidates),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("leg timed out")), timeoutMs);
      }),
    ]);
    const text = extractSurfaceText(sourceSurface, await response.clone().json().catch(() => ({})));
    const trimmed = String(text ?? "").trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// Track consecutive gatekeeper failures per manager model. If the manager
// keeps failing, every request falls through to a full swarm pipeline —
// warn once so operators can investigate a degraded manager model.
const gatekeeperFailures = new Map<string, number>();
const GATEKEEPER_WARN_THRESHOLD = 3;

async function runGatekeeper(opts: {
  base: CanonicalRequest;
  managerGroup: readonly RouteCandidate[];
  managerModel: string;
  config: ResolvedSwarmConfig;
  dispatch: SwarmDispatch;
  log?: (message: string) => void;
}): Promise<"simple" | "complex"> {
  const { base, managerGroup, managerModel, config, dispatch, log } = opts;
  const request = buildInternalRequest(base, GATEKEEPER_PROMPT);
  try {
    const text = await readLegText(dispatch, request, managerGroup, base.source_surface, config.managerTimeoutMs);
    if (text === null) {
      trackGatekeeperFailure(managerModel, log);
      return "complex"; // assume complex on failure
    }
    const verdict = /VERDICT:\s*SIMPLE/i.test(text) ? "simple" : "complex";
    gatekeeperFailures.delete(managerModel);
    log?.(`swarm gatekeeper verdict: ${verdict}`);
    return verdict;
  } catch {
    trackGatekeeperFailure(managerModel, log);
    return "complex";
  }
}

function trackGatekeeperFailure(managerModel: string, log?: (message: string) => void): void {
  const count = (gatekeeperFailures.get(managerModel) ?? 0) + 1;
  gatekeeperFailures.set(managerModel, count);
  if (count === GATEKEEPER_WARN_THRESHOLD) {
    log?.(
      `swarm gatekeeper failed ${count} consecutive times for ${managerModel} — every request falls through to a full swarm pipeline; the manager model may be degraded`,
    );
  }
}

async function runManagerStrategy(opts: {
  base: CanonicalRequest;
  managerGroup: readonly RouteCandidate[];
  config: ResolvedSwarmConfig;
  dispatch: SwarmDispatch;
  log?: (message: string) => void;
}): Promise<SwarmStrategy | null> {
  const { base, managerGroup, config, dispatch, log } = opts;
  const request = buildInternalRequest(base, buildManagerStrategyPrompt(lastUserText(base)));
  const text = await readLegText(dispatch, request, managerGroup, base.source_surface, config.managerTimeoutMs);
  if (text === null) {
    log?.("swarm manager strategy call failed");
    return null;
  }
  const strategy = parseSwarmStrategy(text);
  if (!strategy) log?.("swarm manager produced unparseable strategy");
  else log?.(`swarm strategy: ${strategy.subtasks.length} subtasks — ${strategy.assessment}`);
  return strategy;
}

interface WorkerOutput {
  readonly subtask: SwarmSubtask;
  readonly text: string;
}

interface WorkerLegResult {
  readonly ok: boolean;
  readonly text: string;
  readonly subtask: SwarmSubtask;
}

/**
 * Quorum-grace parallel collection for worker legs. Once `minPanel` legs
 * succeed, stragglers get `stragglerGraceMs` before the panel closes. Returns
 * a sparse array aligned to `legs` (undefined = dropped after early close).
 * Mirrors fusion's collectPanel but for text legs instead of Responses.
 */
async function collectWorkerPanel(
  legs: readonly Promise<WorkerLegResult>[],
  opts: {
    minPanel: number;
    stragglerGraceMs: number;
    panelTimeoutMs: number;
    subtasks: readonly SwarmSubtask[];
  },
): Promise<readonly (WorkerLegResult | undefined)[]> {
  const out: (WorkerLegResult | undefined)[] = new Array(legs.length);
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
      const timed: Promise<WorkerLegResult> = Promise.race([
        leg,
        new Promise<WorkerLegResult>((resolveTimeout) =>
          setTimeout(
            () => resolveTimeout({ ok: false, text: "", subtask: opts.subtasks[index]! }),
            opts.panelTimeoutMs,
          ),
        ),
      ]);
      void timed.then((result) => {
        if (finished) return;
        out[index] = result.ok ? result : undefined;
        settled += 1;
        if (result.ok) ok += 1;
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

async function dispatchWorkers(opts: {
  base: CanonicalRequest;
  subtasks: readonly SwarmSubtask[];
  groups: ReadonlyMap<string, readonly RouteCandidate[]>;
  config: ResolvedSwarmConfig;
  dispatch: SwarmDispatch;
  log?: (message: string) => void;
}): Promise<WorkerOutput[]> {
  const { base, subtasks, groups, config, dispatch, log } = opts;
  const pool = config.workerModels.filter((m) => groups.has(m));
  if (pool.length === 0) return [];

  const legs = subtasks.map((subtask, index) => {
    const workerModel = pool[index % pool.length]!;
    const workerGroup = groups.get(workerModel)!;
    const workerRequest = buildInternalRequest(base, buildWorkerDirective(subtask));
    return (async (): Promise<WorkerLegResult> => {
      const text = await readLegText(
        dispatch,
        workerRequest,
        workerGroup,
        base.source_surface,
        config.workerHardTimeoutMs,
      );
      return { ok: text !== null, text: text ?? "", subtask };
    })();
  });

  const settled = await collectWorkerPanel(legs, {
    minPanel: Math.min(config.workerQuorum, legs.length),
    stragglerGraceMs: config.stragglerGraceMs,
    panelTimeoutMs: config.workerHardTimeoutMs,
    subtasks,
  });

  const outputs: WorkerOutput[] = [];
  for (const result of settled) {
    if (result && result.ok && result.text) {
      outputs.push({ subtask: result.subtask, text: result.text });
    }
  }
  log?.(`swarm workers: ${outputs.length}/${subtasks.length} succeeded`);
  return outputs;
}

async function runStaffAudit(opts: {
  base: CanonicalRequest;
  subtasks: readonly SwarmSubtask[];
  workerOutputs: readonly WorkerOutput[];
  staffGroup: readonly RouteCandidate[] | null;
  config: ResolvedSwarmConfig;
  dispatch: SwarmDispatch;
  log?: (message: string) => void;
}): Promise<string | null> {
  const { base, subtasks, workerOutputs, staffGroup, config, dispatch, log } = opts;
  if (!staffGroup) {
    log?.("swarm audit skipped (no staff model)");
    return null;
  }
  const withOutputs = subtasks.map((st) => ({
    ...st,
    output: workerOutputs.find((w) => w.subtask === st)?.text ?? "(no output)",
  }));
  const request = buildInternalRequest(base, buildStaffAuditPrompt(withOutputs));
  const text = await readLegText(dispatch, request, staffGroup, base.source_surface, config.managerTimeoutMs);
  if (text === null) log?.("swarm staff audit failed — synthesizing from raw worker outputs");
  return text;
}

// ── Main entry ────────────────────────────────────────────────────────────

export interface SwarmRunInput {
  readonly combo: ComboDefinition;
  /** Resolved combo name, for logging. */
  readonly comboName: string;
  readonly canonicalRequest: CanonicalRequest;
  readonly candidates: readonly RouteCandidate[];
  readonly requestId: string;
  /** Single dispatch over a candidate list; fails over across candidates. */
  readonly dispatch: SwarmDispatch;
  /**
   * Owning request's abort signal. Checked between stages so a cancelled
   * request stops the pipeline instead of burning more upstream calls.
   */
  readonly signal: AbortSignal;
  readonly log?: (message: string) => void;
}

/** Run the hierarchical swarm pipeline for one request. */
export async function runSwarmCombo(input: SwarmRunInput): Promise<Response> {
  const { combo, comboName, canonicalRequest, candidates, dispatch, signal } = input;
  throwIfAborted(signal);
  const groups = groupCandidatesByModel(candidates);
  if (groups.length === 0) {
    throw new GatewayError("admission_unavailable", 503, "swarm combo has no candidates");
  }
  const members = groups.map((group) => group[0]!.model_id);
  const byModel = new Map(groups.map((group) => [group[0]!.model_id, group] as const));
  const config = resolveSwarmConfig(combo, members);

  // Single-model fast path: no point orchestrating a swarm over one model.
  const explicitRoles = combo.config?.swarm?.managerModel ?? combo.config?.swarm?.staffModel;
  if (groups.length === 1 && !explicitRoles) {
    input.log?.(`swarm ${comboName}: single member — direct dispatch`);
    return dispatch(canonicalRequest, candidates);
  }

  const managerGroup = byModel.get(config.managerModel) ?? groups[0]!;
  const staffGroup = config.staffModel ? (byModel.get(config.staffModel) ?? null) : null;
  const log = (message: string): void => input.log?.(`swarm ${comboName}: ${message}`);
  const stage = (label: string): void =>
    updateInFlightDetail(input.requestId, { stage: `swarm · ${label}` });

  try {
    // ── Stage 0: Gatekeeper ──
    stage("gatekeeper");
    const verdict = await runGatekeeper({
      base: canonicalRequest,
      managerGroup,
      managerModel: config.managerModel,
      config,
      dispatch,
      log,
    });
    if (verdict === "simple") {
      log("gatekeeper bypass — simple request, direct answer");
      throwIfAborted(signal);
      return dispatch(canonicalRequest, managerGroup);
    }

    // ── Stage 1: Manager strategy ──
    throwIfAborted(signal);
    stage("manager decomposing");
    const strategy = await runManagerStrategy({
      base: canonicalRequest,
      managerGroup,
      config,
      dispatch,
      log,
    });
    if (!strategy || strategy.subtasks.length === 0) {
      log("strategy decomposition failed — falling back to direct answer");
      throwIfAborted(signal);
      stage("fallback · direct answer");
      return dispatch(canonicalRequest, managerGroup);
    }

    // ── Stage 2: Dispatch workers (parallel) ──
    const effectiveCount = Math.min(config.workerCount, config.maxWorkers);
    const effectiveSubtasks = strategy.subtasks.slice(0, effectiveCount);
    throwIfAborted(signal);
    stage(`workers ×${effectiveSubtasks.length}`);
    const workerOutputs = await dispatchWorkers({
      base: canonicalRequest,
      subtasks: effectiveSubtasks,
      groups: byModel,
      config,
      dispatch,
      log,
    });
    if (workerOutputs.length < config.minWorkers) {
      log(`only ${workerOutputs.length}/${effectiveSubtasks.length} workers succeeded — fallback`);
      throwIfAborted(signal);
      stage("fallback · direct answer");
      if (workerOutputs.length === 1) {
        const single = workerOutputs[0]!;
        const presentRequest = buildSynthesisRequest(
          canonicalRequest,
          `The specialist worker produced this answer for the subtask "${single.subtask.title}". Output it verbatim to the user, adjusting only for formatting if needed:\n\n${single.text}`,
        );
        return dispatch(presentRequest, managerGroup);
      }
      return dispatch(canonicalRequest, managerGroup);
    }

    // ── Stage 3: Staff audit ──
    throwIfAborted(signal);
    if (staffGroup) stage("staff audit");
    const auditReport = await runStaffAudit({
      base: canonicalRequest,
      subtasks: effectiveSubtasks,
      workerOutputs,
      staffGroup,
      config,
      dispatch,
      log,
    });

    // ── Stage 4: Manager synthesis (client stream/tools preserved) ──
    const synthesisSource = auditReport ?? workerOutputs.map((w) => w.text).join("\n\n---\n\n");
    const synthesisRequest = buildSynthesisRequest(
      canonicalRequest,
      buildManagerSynthesisPrompt(synthesisSource, lastUserText(canonicalRequest)),
    );
    log(`synthesizing final answer from ${workerOutputs.length} worker outputs`);
    throwIfAborted(signal);
    stage("synthesis");
    return dispatch(synthesisRequest, managerGroup);
  } catch (error) {
    // A cancelled request must stop here — degrading to a direct answer would
    // launch another full upstream call nobody will ever read.
    if (signal.aborted) throw error;
    // Graceful degradation: fall back to a direct answer on any uncaught error.
    log(`swarm failed (${error instanceof Error ? error.message : String(error)}) — direct answer`);
    return dispatch(canonicalRequest, managerGroup);
  }
}
