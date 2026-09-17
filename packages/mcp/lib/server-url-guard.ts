/**
 * Outbound guard for MCP server URLs.
 *
 * An MCP server's `baseUrl` is tenant-supplied and persisted: the config
 * procedures accept any URL, and the client later connects to whatever is
 * stored, on paths with no caller present to refuse. That is the same SSRF
 * shape as agent discovery — an ordinary member aims the server at cloud
 * metadata, an admin port, or a service that trusts the network it sits on,
 * and reads back enough (connected / status code / error text) to enumerate.
 *
 * The block is unconditional and the exception is explicit, declared by
 * whoever runs the deployment rather than by whoever is making the request:
 *
 *   MCP_SERVER_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal
 *
 * In production an unset variable means no exceptions. Outside production it
 * falls back to loopback, so a developer's local MCP server works with no
 * configuration while link-local and LAN addresses stay refused.
 *
 * One further exception that is not the request's to widen: Fabric hosts MCP
 * routes of its own under `/api/mcp/*`. A URL for one of those on the
 * deployment's own `NEXT_PUBLIC_SITE_URL` origin resolves to this instance,
 * so loopback there is expected. That is decided from the environment too.
 */

import {
	createOutboundHostAllowlist,
	getBlockedOutboundReason,
} from "@repo/utils/url-security";

export const MCP_SERVER_ALLOWED_HOSTS_ENV = "MCP_SERVER_ALLOWED_HOSTS";

const mcpServerAllowlist = createOutboundHostAllowlist({
	envVar: MCP_SERVER_ALLOWED_HOSTS_ENV,
});

/**
 * Is this a Fabric-hosted MCP route on this deployment's own origin?
 * Compares protocol and host (including port) against `NEXT_PUBLIC_SITE_URL`
 * and requires the `/api/mcp/` path prefix.
 */
export function isFabricHostedMcpUrl(urlString: string): boolean {
	const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
	if (!siteUrl) {
		return false;
	}
	try {
		const url = new URL(urlString);
		const site = new URL(siteUrl);
		return (
			url.pathname.startsWith("/api/mcp/") &&
			url.host === site.host &&
			url.protocol === site.protocol
		);
	} catch {
		return false;
	}
}

/**
 * Why this MCP server URL must not be connected to, or `null` if it is
 * public, allowlisted, or Fabric-hosted. Hostname check only.
 */
export function getMcpServerUrlBlockReason(urlString: string): string | null {
	if (isFabricHostedMcpUrl(urlString)) {
		return null;
	}
	return mcpServerAllowlist.getUnsafeReason(urlString);
}

/** Throw unless the MCP server URL may be connected to. Hostname check only. */
export function assertMcpServerUrlAllowed(urlString: string): void {
	const reason = getMcpServerUrlBlockReason(urlString);
	if (reason) {
		throw new Error(reason);
	}
}

/**
 * Throw unless the MCP server URL may be connected to, resolving the hostname
 * and refusing any DNS answer that contains a private address.
 *
 * A pre-connect check. It is not the guard itself: a name can answer one
 * address here and another to the connection, so every request must still
 * go through `fetchMcpServer`, which validates at lookup time.
 */
export async function assertMcpServerUrlResolved(
	urlString: string,
): Promise<void> {
	if (isFabricHostedMcpUrl(urlString)) {
		return;
	}
	await mcpServerAllowlist.assertResolved(urlString);
}

/**
 * Fetch an MCP server URL, refusing destinations the deployment has not
 * permitted. Pass this as the `fetch` option of the SDK transports so every
 * request they make — initialize, SSE stream, JSON-RPC POSTs, OAuth metadata
 * discovery and token exchange — is checked at DNS-lookup time and refuses
 * redirects. Allowlisted and Fabric-hosted hosts skip the lookup-time block,
 * since blocking them there is precisely what the operator said not to do,
 * but a redirect off them is refused all the same: the exception is the
 * host, not wherever it chooses to point.
 */
export async function fetchMcpServer(
	input: string | URL,
	init?: RequestInit,
): Promise<Response> {
	const urlString = typeof input === "string" ? input : input.toString();
	if (isFabricHostedMcpUrl(urlString)) {
		return fetch(urlString, {
			...init,
			redirect: init?.redirect === "manual" ? "manual" : "error",
		});
	}
	return mcpServerAllowlist.fetch(urlString, init);
}

/**
 * If `error` is the safe dispatcher refusing a destination at DNS time,
 * return a message a caller can act on; otherwise `null`.
 */
export function getMcpServerBlockedReason(error: unknown): string | null {
	const reason = getBlockedOutboundReason(error);
	if (!reason) {
		return null;
	}
	return `${reason}. If this address is intended, add its host to ${MCP_SERVER_ALLOWED_HOSTS_ENV}.`;
}
