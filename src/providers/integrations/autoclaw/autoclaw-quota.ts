import type { ProviderQuotaResult, ProviderQuotaWindow, FetchLike } from "../../quota/quota-contracts";
import { number, record } from "../../quota/quota-contracts";
import { fetchAutoClawUserApi } from "./autoclaw-shared";

const WALLET_PATH = "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw";

/** Fetches the account's absolute AutoClaw credit balance. */
export async function fetchAutoClawQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const data = record(await fetchAutoClawUserApi(WALLET_PATH, credential, { fetcher }));
  const balance = number(data?.["total_balance"]);
  if (balance === null || balance < 0) {
    throw new Error("AutoClaw wallet response did not contain a valid total balance");
  }

  const window: ProviderQuotaWindow = {
    kind: "credits",
    label: "Credits available",
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    used: null,
    limit: balance,
    remaining: balance,
    recurring: false,
  };
  return {
    source: "autoclaw",
    plan: null,
    windows: [window],
    error: null,
  };
}
