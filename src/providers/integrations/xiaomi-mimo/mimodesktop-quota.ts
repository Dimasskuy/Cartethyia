import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { percentWindow, record, number } from "../../quota/quota-contracts";
import { acquireMimoServiceSession, MIMO_API_UA } from "./mimodesktop-sso";
import { parseMimoCredential } from "./mimodesktop-oauth";
import { MIMODESKTOP_BASE_URL } from "./mimodesktop";

export const MIMODESKTOP_USAGE_ENDPOINT = `${MIMODESKTOP_BASE_URL}/api/user/usage` as const;

export function parseMimoDesktopQuota(payload: unknown): ProviderQuotaResult {
  const root = record(payload);
  const data = record(root?.["data"]);
  if (!data) {
    return {
      source: "mimodesktop",
      plan: "Xiaomi MiMo Desktop",
      windows: [],
      error: "Unexpected response format from MiMo usage endpoint",
    };
  }

  // Upstream returns remaining percent, e.g. 99.9% remaining.
  const rawRemaining = number(data["percent"]);
  const usedPercent = rawRemaining !== null ? Math.max(0, Math.min(100, 100 - rawRemaining)) : null;

  const rawResetAt = number(data["resetAt"]);
  const resetIso =
    rawResetAt !== null && Number.isFinite(rawResetAt)
      ? new Date(rawResetAt * 1000).toISOString()
      : typeof data["resetDate"] === "string"
        ? new Date(data["resetDate"]).toISOString()
        : null;

  const windows: ProviderQuotaWindow[] = [];
  if (usedPercent !== null || resetIso !== null) {
    windows.push(
      percentWindow(
        "weekly",
        "Weekly Quota",
        usedPercent !== null ? Math.round(usedPercent * 10) / 10 : null,
        resetIso,
      ),
    );
  }

  return {
    source: "mimodesktop",
    plan: "Xiaomi MiMo Desktop",
    windows,
    error: null,
  };
}

export async function fetchMimoDesktopQuota(
  credential: string,
  fetcher: FetchLike = fetch,
): Promise<ProviderQuotaResult> {
  const parsed = parseMimoCredential(credential);
  if (!parsed.passToken) {
    return {
      source: "mimodesktop",
      plan: "Xiaomi MiMo Desktop",
      windows: [],
      error: "MiMo Desktop passToken is missing",
    };
  }

  try {
    const sessionCookie = await acquireMimoServiceSession(
      {
        passToken: parsed.passToken,
        ...(parsed.userId ? { userId: parsed.userId } : {}),
        apiBase: MIMODESKTOP_BASE_URL,
      },
      fetcher as typeof fetch,
    );

    const res = await fetcher(MIMODESKTOP_USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        "User-Agent": MIMO_API_UA,
        Cookie: sessionCookie,
        "X-Mimo-Source": "mimocode-cli-free",
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      return {
        source: "mimodesktop",
        plan: "Xiaomi MiMo Desktop",
        windows: [],
        error: `Usage API returned HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as unknown;
    return parseMimoDesktopQuota(json);
  } catch (error) {
    return {
      source: "mimodesktop",
      plan: "Xiaomi MiMo Desktop",
      windows: [],
      error: error instanceof Error ? error.message : "Failed to fetch MiMo quota",
    };
  }
}
