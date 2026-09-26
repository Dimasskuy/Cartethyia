import type { ProviderResponse } from "./contracts";

/** Whether the route-level User-Agent control applies to this provider detail. */
export function providerCanConfigureUserAgent(
  provider: Pick<ProviderResponse, "isBuiltIn" | "requiresAccount" | "oauthFlows">,
): boolean {
  return provider.isBuiltIn && provider.requiresAccount && provider.oauthFlows === undefined;
}
