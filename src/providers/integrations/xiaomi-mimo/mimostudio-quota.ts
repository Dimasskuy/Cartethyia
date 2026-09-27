import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { percentWindow, record, number } from "../../quota/quota-contracts";
import {
  buildMimoStudioCookieHeader,
  parseMimoStudioCredential,
  MIMO_STUDIO_UA,
} from "./mimostudio-auth";

export const MIMO_STUDIO_USAGE_URL = "https://aistudio.xiaomimimo.com/open-apis/v1/user/usage" as const;

export function parseMimoStudioQuota(payload: unknown): ProviderQuotaResult {
  const root = record(payload);
  const data = record(root?.["data"]);
  if (!data) {
    return {
      source: "mimostudio",
      plan: "MiMo Studio",
      windows: [],
      error: "Unexpected response format from MiMo Studio usage endpoint",
    };
  }

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
    source: "mimostudio",
    plan: "MiMo Studio",
    windows,
    error: null,
  };
}

export async function fetchMimoStudioQuota(
  credential: string,
  fetcher: FetchLike = fetch,
): Promise<ProviderQuotaResult> {
  const creds = parseMimoStudioCredential(credential);
  try {
    const cookie = buildMimoStudioCookieHeader(creds);
    const res = await fetcher(MIMO_STUDIO_USAGE_URL, {
      method: "GET",
      headers: {
        "User-Agent": MIMO_STUDIO_UA,
        Cookie: cookie,
        Origin: "https://aistudio.xiaomimimo.com",
        Referer: "https://aistudio.xiaomimimo.com/",
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      return {
        source: "mimostudio",
        plan: "MiMo Studio",
        windows: [],
        error: `MiMo Studio usage returned HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as unknown;
    return parseMimoStudioQuota(json);
  } catch (error) {
    return {
      source: "mimostudio",
      plan: "MiMo Studio",
      windows: [],
      error: error instanceof Error ? error.message : "Failed to fetch MiMo Studio quota",
    };
  }
}
