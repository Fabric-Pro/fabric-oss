/**
 * Finding the authorization server for a Fabric deployment.
 *
 * The gateway publishes protected-resource metadata (RFC 9728) naming the
 * authorization server, and that server publishes its own metadata (RFC 8414,
 * path-inserted when the issuer has a path). Two things are checked rather than
 * trusted: the issuer in the server's metadata must equal the one the resource
 * named, and every endpoint must live on the issuer's origin, so a response
 * cannot send the browser or the tokens somewhere the deployment did not.
 */

export interface AuthorizationServerMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint: string;
	revocation_endpoint?: string;
}

const GATEWAY_RESOURCE_METADATA_PATH =
	"/.well-known/oauth-protected-resource/api/mcp-gateway";

export class OAuthDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthDiscoveryError";
	}
}

type FetchLike = (
	input: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

async function getJson(
	fetchImpl: FetchLike,
	url: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { Accept: "application/json" },
			signal,
		});
	} catch {
		throw new OAuthDiscoveryError(
			`Could not reach ${new URL(url).origin}.`,
		);
	}
	if (!response.ok) {
		throw new OAuthDiscoveryError(
			`${new URL(url).origin} does not offer sign-in (HTTP ${response.status}).`,
		);
	}
	const body: unknown = await response.json().catch(() => null);
	if (!body || typeof body !== "object") {
		throw new OAuthDiscoveryError(
			`${new URL(url).origin} returned an unreadable sign-in document.`,
		);
	}
	return body as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new OAuthDiscoveryError(
			`The sign-in document is missing ${field}.`,
		);
	}
	return value;
}

function sameOriginEndpoint(
	value: unknown,
	field: string,
	issuer: URL,
): string {
	const endpoint = text(value, field);
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new OAuthDiscoveryError(
			`The sign-in document has an invalid ${field}.`,
		);
	}
	if (url.origin !== issuer.origin) {
		throw new OAuthDiscoveryError(
			`The sign-in document points ${field} at another origin.`,
		);
	}
	return endpoint;
}

/** RFC 8414 section 3.1: the well-known segment goes between host and path. */
export function authorizationServerMetadataUrl(issuer: string): string {
	const url = new URL(issuer);
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

export async function discoverAuthorizationServer(
	baseUrl: string,
	options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<AuthorizationServerMetadata> {
	const fetchImpl: FetchLike =
		options.fetch ?? ((input, init) => fetch(input, init));
	const origin = new URL(baseUrl).origin;

	const resource = await getJson(
		fetchImpl,
		`${origin}${GATEWAY_RESOURCE_METADATA_PATH}`,
		options.signal,
	);
	const servers = resource.authorization_servers;
	if (!Array.isArray(servers) || servers.length === 0) {
		throw new OAuthDiscoveryError(
			"The deployment does not name an authorization server.",
		);
	}
	const issuer = text(servers[0], "authorization_servers[0]");

	const metadata = await getJson(
		fetchImpl,
		authorizationServerMetadataUrl(issuer),
		options.signal,
	);
	if (metadata.issuer !== issuer) {
		throw new OAuthDiscoveryError(
			"The authorization server's issuer does not match the one the deployment named.",
		);
	}

	const issuerUrl = new URL(issuer);
	return {
		issuer,
		authorization_endpoint: sameOriginEndpoint(
			metadata.authorization_endpoint,
			"authorization_endpoint",
			issuerUrl,
		),
		token_endpoint: sameOriginEndpoint(
			metadata.token_endpoint,
			"token_endpoint",
			issuerUrl,
		),
		registration_endpoint: sameOriginEndpoint(
			metadata.registration_endpoint,
			"registration_endpoint",
			issuerUrl,
		),
		revocation_endpoint:
			metadata.revocation_endpoint === undefined
				? undefined
				: sameOriginEndpoint(
						metadata.revocation_endpoint,
						"revocation_endpoint",
						issuerUrl,
					),
	};
}
