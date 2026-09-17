/**
 * Outbound guard for search provider endpoints.
 *
 * Tavily, Firecrawl and Parallel accept a custom `endpoint` so a tenant can
 * point Fabric at a self-hosted or proxied instance. That endpoint is saved by
 * an ordinary member, and every later search — including ones run by an AI
 * tool with no caller present — POSTs the query to whatever is stored. Left
 * unchecked it is an SSRF primitive: aim it at cloud metadata or an internal
 * admin port and read back the status and error text.
 *
 * The block is unconditional and the exception is explicit, declared by
 * whoever runs the deployment rather than by whoever is making the request:
 *
 *   SEARCH_PROVIDER_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal
 *
 * In production an unset variable means no exceptions. Outside production it
 * falls back to loopback, so a developer running Firecrawl locally works
 * unconfigured while link-local and LAN addresses stay refused.
 *
 * The vendors' default endpoints are public hosts and pass unchanged.
 */

import { createOutboundHostAllowlist } from "@repo/utils/url-security";

export const SEARCH_PROVIDER_ALLOWED_HOSTS_ENV =
	"SEARCH_PROVIDER_ALLOWED_HOSTS";

const searchProviderAllowlist = createOutboundHostAllowlist({
	envVar: SEARCH_PROVIDER_ALLOWED_HOSTS_ENV,
});

/**
 * Why a custom endpoint must not be used, or `null` if it is public or
 * allowlisted. Hostname check only — for the write path, where the request
 * that would reach the address has not been made yet.
 */
export function getSearchEndpointBlockReason(endpoint: string): string | null {
	return searchProviderAllowlist.getUnsafeReason(endpoint);
}

/** Throw unless a custom endpoint may be used. */
export function assertSearchEndpointAllowed(endpoint: string): void {
	searchProviderAllowlist.assert(endpoint);
}

/**
 * Fetch a provider URL, refusing destinations the deployment has not
 * permitted. Providers call this in place of `fetch` for every request, so a
 * stored endpoint cannot later point inside: non-allowlisted hosts are
 * re-checked at DNS-lookup time and redirects are refused.
 */
export function fetchSearchEndpoint(
	input: string | URL,
	init?: RequestInit,
): Promise<Response> {
	return searchProviderAllowlist.fetch(input, init);
}
