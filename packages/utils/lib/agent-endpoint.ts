/**
 * Outbound guard for agent deployment URLs.
 *
 * Agent discovery, registration, health-checking and message relay all take a
 * URL and make the server fetch it. That is the textbook SSRF shape: an
 * ordinary member, with no elevated privilege, can map an internal network —
 * cloud metadata, an admin port, anything that trusts the network it sits on.
 *
 * `url-security` already answers this for the rest of the codebase. Applying
 * it here is not a straight copy for one reason: elsewhere a private
 * destination is always wrong, while for an agent it is often the point. Local
 * development runs agents on `localhost`, and a self-hosted deployment may
 * legitimately keep them on its own network.
 *
 * So the block is unconditional and the exception is explicit, declared by
 * whoever runs the deployment rather than by whoever is making the request:
 *
 *   AGENT_DISCOVERY_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal
 *
 * In production an unset variable means no exceptions at all. Outside
 * production an unset variable falls back to the loopback set below, so a
 * checkout works with no configuration while still refusing the link-local and
 * LAN addresses that make SSRF interesting.
 *
 * An allowlisted host is fetched with plain `fetch`: `safeFetchOutbound`
 * blocks private addresses at DNS-lookup time, which is exactly what the
 * operator just said to permit. Everything else goes through the shared
 * resolved check and the safe dispatcher, so a public hostname that resolves
 * to a private address — or 3xx-redirects to one — is still refused.
 *
 * This lives in `@repo/utils` rather than beside the oRPC procedures that
 * first needed it because the surfaces that must not be left unguarded span
 * packages that cannot import `@repo/api`: the Temporal activities that relay
 * to a stored `deploymentUrl`, and the web route that relays a caller-supplied
 * one. `@repo/api` keeps the oRPC-flavoured wrapper that throws `ORPCError`.
 */

import { getUnsafeUrlReason, safeFetchOutbound } from "./url-security";

/**
 * Hosts permitted when `AGENT_DISCOVERY_ALLOWED_HOSTS` is unset and the
 * deployment is not production. Loopback only — a developer's own machine is
 * where their agents run, and nothing here reaches another host.
 */
const NON_PRODUCTION_DEFAULT_HOSTS = [
	"localhost",
	"127.0.0.1",
	"::1",
	"host.docker.internal",
];

function allowedHosts(): string[] {
	const configured = process.env.AGENT_DISCOVERY_ALLOWED_HOSTS;

	if (configured !== undefined) {
		return configured
			.split(",")
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean);
	}

	// Read at call time, not at module load: the tests and the Next dev server
	// both set NODE_ENV after this module is first imported.
	return process.env.NODE_ENV === "production"
		? []
		: NON_PRODUCTION_DEFAULT_HOSTS;
}

/**
 * Is this URL's host one the operator explicitly permitted?
 *
 * Compares the hostname only. A port is deliberately not part of the match —
 * an operator who has declared a host reachable is not helped by having to
 * enumerate every port an agent might listen on, and the host is what decides
 * whether the request leaves the trust boundary.
 */
function isAgentHostExplicitlyAllowed(urlString: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(urlString).hostname
			.toLowerCase()
			.replace(/^\[|\]$/g, "")
			.replace(/\.$/, "");
	} catch {
		return false;
	}

	return allowedHosts().includes(hostname);
}

/**
 * The reason this URL must be refused, or `null` when it may be fetched.
 *
 * Returns a message rather than throwing so each caller can fail in its own
 * idiom — `ORPCError` inside a procedure, a 400 inside a route handler, a
 * thrown `Error` inside an activity — while every one of them says the same
 * thing to whoever has to fix it.
 */
export function agentEndpointRefusal(urlString: string): string | null {
	if (isAgentHostExplicitlyAllowed(urlString)) {
		return null;
	}

	const reason = getUnsafeUrlReason(urlString);
	if (!reason) {
		return null;
	}

	return `Agent endpoint rejected: ${reason}. If this address is intended, add its host to AGENT_DISCOVERY_ALLOWED_HOSTS.`;
}

/**
 * Fetch an agent endpoint, refusing destinations the deployment has not
 * permitted.
 *
 * Use this in place of `fetch` for every request whose URL came from a caller
 * OR from a stored record. Guarding the request rather than only the
 * registration matters: a stored `deploymentUrl` can be changed later, and a
 * probe of a stored URL is the same outbound request as a probe of a supplied
 * one.
 */
export async function fetchAgentEndpoint(
	urlString: string,
	init?: RequestInit,
): Promise<Response> {
	if (isAgentHostExplicitlyAllowed(urlString)) {
		return fetch(urlString, init);
	}

	const refusal = agentEndpointRefusal(urlString);
	if (refusal) {
		throw new Error(refusal);
	}

	// Not merely `fetch` after the check above. `safeFetchOutbound` re-checks
	// at DNS-lookup time and refuses to follow redirects, which is what closes
	// the two bypasses a one-time hostname check leaves open: a name that
	// resolves to a private address, and a public host that 302s to one.
	return safeFetchOutbound(urlString, init);
}
