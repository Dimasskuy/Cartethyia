import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import {
  authCredential,
  getJson,
  percentWindow,
  quotaRecord,
  record,
  text,
  number,
  isoDate,
} from "../../quota/quota-contracts";
import { getAntigravityUserAgent, collapseAntigravityVariant } from "./antigravity-protocol";
import { ANTIGRAVITY_MODELS } from "./antigravity";

interface AntigravityQuotaFamily {
  readonly key: string;
  readonly label: string;
}

/**
 * Catalog model ids whose quota the console reports.
 *
 * The upstream `fetchAvailableModels` payload carries every deployment the
 * account can reach — internal ones, and one entry per effort tier
 * (`gemini-3.8-flash-low`/`-medium`/`-high`), which are a single model to the
 * operator. Each upstream key is collapsed with
 * {@link collapseAntigravityVariant} and kept only when the catalog serves the
 * resulting id, so a quota row exists for exactly the models the operator can
 * select.
 *
 * This replaced a hand-kept list plus a permissive id pattern, which let a
 * deployment the catalog no longer serves (`gemini-2.5-pro`) report a quota row
 * for a model that cannot be chosen. Deriving the set means removing a catalog
 * model removes its quota row in the same change.
 */
const CATALOG_MODEL_IDS: ReadonlySet<string> = new Set(
  ANTIGRAVITY_MODELS.map((model) => model.modelId),
);

function modelFamily(modelId: string): AntigravityQuotaFamily {
  if (/^(?:gemini[-_]|tab_)/i.test(modelId)) return { key: "google", label: "Google" };
  return { key: "claude", label: "Claude" };
}

/** Display names for the two per-model families, as the operator reads them. */
const FAMILY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  google: "Gemini (Flash / Pro)",
  claude: "Claude (Sonnet / Opus)",
});

/**
 * Display names for the weekly summary groups.
 *
 * The upstream groups buckets by family rather than by model, so the label
 * names both families that share the window — a row labelled only "Claude"
 * would hide that GPT-OSS draws on the same weekly allowance.
 */
const WEEKLY_LABELS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /gemini/i, label: "Gemini (Weekly)" },
  { pattern: /claude|gpt/i, label: "Claude & GPT (Weekly)" },
];

function isQuotaModel(modelId: string): boolean {
  return CATALOG_MODEL_IDS.has(collapseAntigravityVariant(modelId));
}

/**
 * Keeps the row whose remaining allowance is lowest.
 *
 * The upstream reports one quota per deployment, and several deployments are
 * tier variants of one catalog model (`gemini-3.8-flash-high`/`-medium`/`-low`).
 * The family row must reflect the *worst* variant, because that is the one the
 * operator will actually run out of; averaging them, or showing the first, hid
 * an exhausted tier behind a healthy sibling.
 */
function keepWorse(
  current: ProviderQuotaWindow | undefined,
  candidate: ProviderQuotaWindow,
): ProviderQuotaWindow {
  if (current === undefined) return candidate;
  const currentRemaining = current.remainingPercent;
  const candidateRemaining = candidate.remainingPercent;
  if (currentRemaining === null) return candidate;
  if (candidateRemaining === null) return current;
  return candidateRemaining < currentRemaining ? candidate : current;
}

/** Total the upstream's fractional allowance is normalized against. */
const QUOTA_TOTAL = 1000;

/** Builds a window from a `remainingFraction` + `resetTime` pair. */
function fractionWindow(
  kind: string,
  label: string,
  remainingFraction: number,
  resetsAt: string | null,
): ProviderQuotaWindow {
  const fraction = Math.min(1, Math.max(0, remainingFraction));
  const used = QUOTA_TOTAL - Math.round(QUOTA_TOTAL * fraction);
  return {
    ...percentWindow(kind, label, (1 - fraction) * 100, resetsAt, used, QUOTA_TOTAL),
    recurring: true,
  };
}

/**
 * Per-model quotas from `v1internal:fetchAvailableModels`.
 *
 * Collapses tier variants to one row per catalog family: the upstream lists
 * `gemini-3.8-flash-low`, `…-medium`, and `…-high` as three deployments, and
 * three rows for one model is noise. Each key is collapsed to its catalog id,
 * kept only when the catalog serves it, and the worst variant in a family
 * becomes that family's row.
 */
function parseModelQuotas(payload: Record<string, unknown>): ProviderQuotaWindow[] {
  const models = record(payload.models) ?? record(payload.modelQuotas) ?? record(payload.quota);
  if (models === null) return [];
  const grouped = new Map<string, ProviderQuotaWindow>();
  for (const [modelId, raw] of Object.entries(models)) {
    const model = record(raw);
    if (!model || model.isInternal === true || !isQuotaModel(modelId)) continue;
    const quota = record(model.quotaInfo);
    if (!quota) continue;
    const fraction = number(quota.remainingFraction);
    if (fraction === null) continue;
    const family = modelFamily(collapseAntigravityVariant(modelId));
    const label = FAMILY_LABELS[family.key] ?? family.label;
    const window = fractionWindow(family.key, label, fraction, isoDate(quota.resetTime));
    grouped.set(family.key, keepWorse(grouped.get(family.key), window));
  }
  return [...grouped.values()];
}

/**
 * Weekly quotas from `v1internal:retrieveUserQuotaSummary`.
 *
 * This is the *only* quota a free-tier account has: the upstream omits
 * per-model quota for it, so a parser that reads only `models` reports no
 * windows at all on a free account. The groups are matched to a family by
 * display name and only weekly buckets are read — the same response also
 * carries shorter buckets, which are not the weekly allowance this row means.
 */
function parseWeeklyQuotas(payload: Record<string, unknown>): ProviderQuotaWindow[] {
  const summary = record(payload.quotaSummary) ?? payload;
  const groups = Array.isArray(summary.groups) ? summary.groups : [];
  const found = new Map<string, ProviderQuotaWindow>();
  for (const rawGroup of groups) {
    const group = record(rawGroup);
    if (!group) continue;
    const groupName = text(group.displayName) ?? "";
    const match = WEEKLY_LABELS.find((candidate) => candidate.pattern.test(groupName));
    if (match === undefined) continue;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const rawBucket of buckets) {
      const bucket = record(rawBucket);
      if (!bucket) continue;
      // Identify the weekly bucket by its own id/label; a group can carry
      // several windows and only the weekly one is this row's meaning.
      const bucketText = `${text(bucket.bucketId) ?? ""} ${text(bucket.displayName) ?? ""}`;
      if (!/weekly/i.test(bucketText)) continue;
      if (bucket.disabled === true) continue;
      const fraction = number(bucket.remainingFraction);
      if (fraction === null) continue;
      const window = fractionWindow(
        `weekly:${match.label}`,
        match.label,
        fraction,
        isoDate(bucket.resetTime),
      );
      found.set(match.label, keepWorse(found.get(match.label), window));
      break;
    }
  }
  return [...found.values()];
}

export async function fetchAntigravityQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(fields.accessToken) ?? credential;
  const headers = {
    authorization: `Bearer ${access}`,
    // Discovered client UA, never a stale pinned version or invented
    // x-client-* headers the reference client does not send.
    "user-agent": getAntigravityUserAgent(),
  };
  const project = fields.projectId ?? fields.providerAccountId;
  const hosts = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
  ];
  // Both endpoints are read and merged, because each carries a quota the other
  // does not: `fetchAvailableModels` has the per-model windows, and
  // `retrieveUserQuotaSummary` has the weekly ones — the only windows a
  // free-tier account has at all. Either may fail without failing the other,
  // and a result with neither is the caller's error to report.
  const windows: ProviderQuotaWindow[] = [];
  let plan: string | null = null;
  for (const host of hosts) {
    try {
      const summary = quotaRecord(
        await getJson(`${host}/v1internal:retrieveUserQuotaSummary`, headers, fetcher, {
          ...(project === undefined ? {} : { project }),
        }),
      );
      windows.push(...parseWeeklyQuotas(summary));
      plan = plan ?? text(summary.tier) ?? text(summary.plan);
      if (windows.length > 0) break;
    } catch {
      // Fall through to the next host.
    }
  }
  for (const host of hosts) {
    try {
      const models = quotaRecord(
        await getJson(`${host}/v1internal:fetchAvailableModels`, headers, fetcher, {
          ...(project === undefined ? {} : { project }),
        }),
      );
      windows.push(...parseModelQuotas(models));
      plan = plan ?? text(models.tier) ?? text(models.plan);
      break;
    } catch {
      // Fall through to the next host.
    }
  }
  return {
    source: "antigravity",
    plan: plan ?? "Antigravity",
    windows,
    error: null,
  };
}
