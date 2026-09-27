import type { ValidatedOutboundFetch } from "../provider-registry";

/**
 * Transparent probe fetch wrapper that preserves the validated fetch contract.
 * Upstream receives the provider adapter's native User-Agent when one is configured.
 */
export function createProbeFetch(fetcher: ValidatedOutboundFetch): ValidatedOutboundFetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    return fetcher(input, { ...init, headers });
  };
}
