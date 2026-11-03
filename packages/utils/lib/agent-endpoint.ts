/**
 * Outbound guard for agent deployment URLs.
 *
 * Agent discovery, registration and health checks accept deployment URLs, and
 * delegation fetches registered endpoints. That is the textbook SSRF shape: an
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
 * to a stored `deploymentUrl`, and the web relay that resolves an ACTIVE SYSTEM
 * registration before sending an AI token. `@repo/api` keeps the oRPC-flavoured
 * wrapper that throws `ORPCError`.
 */

import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import {
	createSafeOutboundLookup,
	getUnsafeUrlReason,
	safeFetchOutbound,
} from "./url-security";

const AGENT_EXTENDED_TIMEOUT_MS = 15 * 60 * 1000;

const allowlistedExtendedTimeoutAgent = new UndiciAgent({
	headersTimeout: AGENT_EXTENDED_TIMEOUT_MS,
	bodyTimeout: AGENT_EXTENDED_TIMEOUT_MS,
});

const safeExtendedTimeoutAgent = new UndiciAgent({
	headersTimeout: AGENT_EXTENDED_TIMEOUT_MS,
	bodyTimeout: AGENT_EXTENDED_TIMEOUT_MS,
	connect: {
		lookup: createSafeOutboundLookup(),
	},
});

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
export function isAgentHostExplicitlyAllowed(urlString: string): boolean {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return false;
	}
	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");

	return allowedHosts().includes(hostname);
}

/**
 * Authoritative URL validator for custom/remote OpenAI-compatible AI provider
 * endpoints (`provider === "CUSTOM"`). Used at save time, connection-test time,
 * and runtime model invocation.
 */
export function validateCustomProviderUrl(urlString: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(urlString);
	} catch {
		return "Invalid URL format";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `Protocol ${parsed.protocol} is not allowed`;
	}
	if (parsed.username || parsed.password) {
		return "Credentials in the endpoint URL are not allowed";
	}
	if (parsed.search || parsed.hash) {
		return "Query strings and URL fragments are not allowed in a base endpoint URL";
	}
	const allowlisted = isAgentHostExplicitlyAllowed(parsed.href);
	if (parsed.protocol !== "https:" && !allowlisted) {
		return "HTTPS is required for custom provider endpoints unless the host is in AGENT_DISCOVERY_ALLOWED_HOSTS";
	}
	return agentEndpointRefusal(parsed.href);
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
 * Use this in place of `fetch` for caller URLs and non-SYSTEM registered
 * endpoints; SYSTEM agents, which only operators register, keep plain fetch.
 * Guarding the request rather than only the registration matters: a stored
 * `deploymentUrl` can be changed later, and a probe of a stored URL is the
 * same outbound request as a probe of a supplied one.
 */
export async function fetchAgentEndpoint(
	urlString: string,
	init?: RequestInit,
): Promise<Response> {
	if (isAgentHostExplicitlyAllowed(urlString)) {
		return fetch(urlString, {
			...init,
			redirect: init?.redirect === "manual" ? "manual" : "error",
		});
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

/**
 * Guarded 15-minute timeout fetch for custom/remote OpenAI-compatible AI
 * provider calls (`model-factory.ts` and `langchain-models.ts`).
 */
export async function fetchAgentEndpointExtendedTimeout(
	url: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const targetUrl =
		url instanceof Request
			? url.url
			: typeof url === "string"
				? url
				: url.toString();
	const refusal = validateCustomProviderUrl(targetUrl);
	if (refusal) {
		throw new Error(refusal);
	}
	const base =
		url instanceof Request
			? {
					method: url.method,
					headers: url.headers,
					body: url.body,
					duplex: url.body ? "half" : undefined,
					signal: url.signal,
					mode: url.mode,
					credentials: url.credentials,
					cache: url.cache,
					redirect: url.redirect,
					referrer: url.referrer,
					referrerPolicy: url.referrerPolicy,
					integrity: url.integrity,
					keepalive: url.keepalive,
				}
			: undefined;
	const overrides =
		base && init
			? Object.fromEntries(
					Object.entries(init).filter(
						([, value]) => value !== undefined,
					),
				)
			: init;
	const dispatcher = isAgentHostExplicitlyAllowed(targetUrl)
		? allowlistedExtendedTimeoutAgent
		: safeExtendedTimeoutAgent;
	return (await undiciFetch(
		targetUrl as never,
		{
			...base,
			...overrides,
			redirect: "error",
			dispatcher,
		} as never,
	)) as unknown as Response;
}
