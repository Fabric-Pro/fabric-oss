/**
 * Which authorization server (AS) an MCP config's OAuth flow uses.
 *
 * `oauth.start` resolves this ONCE and uses the result for client
 * registration, the authorization URL and — through the OAuth state row — the
 * callback's code exchange. The result becomes the config's binding
 * (`oauthBinding`), the only place credentials are ever sent afterwards.
 *
 * Sources, in order:
 * 1. the catalog: the server row's own `oauthTokenEndpoint` (with its
 *    authorization endpoint), or the known-endpoint table below;
 * 2. discovery (RFC 9728 → RFC 8414) from the server's configured discovery
 *    document, else from the MCP server URL.
 *
 * Fabric's own pre-registered clients (`PINNED_OAUTH_PROVIDERS`) take their AS
 * from the catalog only, never from discovery: an MCP server must not be able
 * to name the AS that receives Fabric's client secret.
 */

import type {
	McpOAuthBinding,
	McpOAuthBindingSource,
} from "@repo/database/prisma/queries/lib/mcp-oauth-binding";
import {
	buildMcpOAuthBinding,
	credentialFingerprint,
	parseMcpOAuthBinding,
	sameAuthorizationServer,
} from "@repo/database/prisma/queries/lib/mcp-oauth-binding";
import {
	assertSafeOutboundUrl,
	safeFetchOutbound,
} from "@repo/utils/url-security";
import { discoverOAuthEndpoints } from "./oauth-discovery";

/**
 * Fabric's pinned OAuth providers: for each, the server key and/or exact MCP
 * hostname that identify it, its authorization server and endpoints (checked
 * against each provider's published metadata on 2026-10-06), and — where
 * Fabric holds a pre-registered client for it — the environment variables of
 * that client. A Fabric client and the AS it is sent to always come from the
 * SAME entry.
 */
const PINNED_OAUTH_PROVIDERS: Array<{
	id: string;
	hostname?: string;
	serverKey?: string;
	authorizationServerUrl: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	clientIdEnvVar?: string;
	clientSecretEnvVar?: string;
}> = [
	{
		id: "github",
		hostname: "api.githubcopilot.com",
		serverKey: "github-remote",
		authorizationServerUrl: "https://github.com/login/oauth",
		authorizationEndpoint: "https://github.com/login/oauth/authorize",
		tokenEndpoint: "https://github.com/login/oauth/access_token",
		clientIdEnvVar: "FABRIC_GITHUB_CLIENT_ID",
		clientSecretEnvVar: "FABRIC_GITHUB_CLIENT_SECRET",
	},
	{
		id: "slack",
		hostname: "mcp.slack.com",
		serverKey: "slack-remote",
		authorizationServerUrl: "https://mcp.slack.com",
		authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
		tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
		clientIdEnvVar: "SLACK_CLIENT_ID",
		clientSecretEnvVar: "SLACK_CLIENT_SECRET",
	},
	{
		id: "google",
		serverKey: "google-drive",
		authorizationServerUrl: "https://accounts.google.com",
		authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenEndpoint: "https://oauth2.googleapis.com/token",
		clientIdEnvVar: "GOOGLE_CLIENT_ID",
		clientSecretEnvVar: "GOOGLE_CLIENT_SECRET",
	},
	{
		id: "gitlab",
		serverKey: "gitlab",
		authorizationServerUrl: "https://gitlab.com",
		authorizationEndpoint: "https://gitlab.com/oauth/authorize",
		tokenEndpoint: "https://gitlab.com/oauth/token",
		clientIdEnvVar: "GITLAB_CLIENT_ID",
		clientSecretEnvVar: "GITLAB_CLIENT_SECRET",
	},
];

type PinnedProvider = (typeof PINNED_OAUTH_PROVIDERS)[number];

/** What identifies a server to the pinned-provider table. */
type PinnedProviderServer = {
	key?: string | null;
	isSystemProvided?: boolean | null;
};

/**
 * The ONE pinned provider a server is identified as, by the exact hostname
 * of its effective URL (never a suffix match) and — for a SYSTEM-PROVIDED
 * catalog row only — by its key. A custom row's key is free-form text its
 * owner chose (it may well be `github-remote`), so it identifies nothing; a
 * custom row whose URL really is a pinned provider's host still resolves to
 * that provider by host.
 * - `{ provider }` when exactly one provider matches (by either or both);
 * - `{ conflict: true }` when the key and the hostname name DIFFERENT
 *   providers — nothing pinned may be used then;
 * - null when none matches.
 */
function resolvePinnedProvider(
	baseUrl: string | null | undefined,
	server: PinnedProviderServer,
): { provider: PinnedProvider } | { conflict: true } | null {
	const serverKey = server.isSystemProvided === true ? server.key : null;
	const byKey = serverKey
		? PINNED_OAUTH_PROVIDERS.find((entry) => entry.serverKey === serverKey)
		: undefined;
	let byHost: PinnedProvider | undefined;
	if (baseUrl) {
		try {
			const hostname = new URL(baseUrl).hostname;
			byHost = PINNED_OAUTH_PROVIDERS.find(
				(entry) => entry.hostname === hostname,
			);
		} catch {
			byHost = undefined;
		}
	}
	if (byKey && byHost && byKey.id !== byHost.id) {
		return { conflict: true };
	}
	const provider = byKey ?? byHost;
	return provider ? { provider } : null;
}

function getKnownOAuthEndpoints(
	baseUrl: string | null | undefined,
	server: PinnedProviderServer,
): PinnedProvider | null {
	const resolved = resolvePinnedProvider(baseUrl, server);
	return resolved && "provider" in resolved ? resolved.provider : null;
}

/** Fabric's own client for a server, with the AS it may be sent to. */
export type FabricOAuthClient =
	| {
			kind: "client";
			clientId: string;
			clientSecret: string;
			/** The AS of the same pinned provider entry. */
			snapshot: AuthorizationServerSnapshot;
	  }
	/** The server's key and URL name different providers: refuse. */
	| { kind: "conflict" };

/**
 * Fabric's own pre-registered OAuth client for a SYSTEM-PROVIDED server, from
 * environment variables, together with its pinned AS — both from one provider
 * entry — or null. Custom servers never get it: their key and URL are chosen
 * by whoever created them. A system server whose key and URL hostname name
 * different providers gets `{ kind: "conflict" }`, never one provider's
 * client sent to the other's AS.
 */
export function getEnvOAuthCredentials(
	baseUrl: string | null | undefined,
	server: { key?: string | null; isSystemProvided?: boolean | null },
): FabricOAuthClient | null {
	if (server.isSystemProvided !== true) {
		return null;
	}
	const resolved = resolvePinnedProvider(baseUrl, server);
	if (!resolved) {
		return null;
	}
	if ("conflict" in resolved) {
		return { kind: "conflict" };
	}
	const { provider } = resolved;
	const clientId = provider.clientIdEnvVar
		? process.env[provider.clientIdEnvVar]
		: undefined;
	const clientSecret = provider.clientSecretEnvVar
		? process.env[provider.clientSecretEnvVar]
		: undefined;
	if (!clientId || !clientSecret) {
		return null;
	}
	const snapshot = snapshotFrom({
		authorizationServerUrl: provider.authorizationServerUrl,
		tokenEndpoint: provider.tokenEndpoint,
		authorizationEndpoint: provider.authorizationEndpoint,
		source: "catalog",
	});
	return snapshot
		? { kind: "client", clientId, clientSecret, snapshot }
		: null;
}

/** The server-row fields that decide where an OAuth flow goes. */
export type OAuthServerFields = {
	key?: string | null;
	/**
	 * Only a system-provided row is Fabric's catalog. A custom row's fields
	 * are editable by its owner and are never a trust anchor.
	 */
	isSystemProvided?: boolean | null;
	defaultUrl?: string | null;
	oauthDiscoveryUrl?: string | null;
	oauthAuthorizationEndpoint?: string | null;
	oauthTokenEndpoint?: string | null;
	dcrRegistrationEndpoint?: string | null;
};

/**
 * What `start` resolved: the binding the grant will carry, plus what the
 * flow itself needs from the same snapshot.
 */
export type AuthorizationServerSnapshot = {
	binding: McpOAuthBinding;
	authorizationEndpoint: string;
	registrationEndpoint: string | null;
	scopesSupported: string[];
};

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

function snapshotFrom(input: {
	authorizationServerUrl: string;
	tokenEndpoint: string;
	authorizationEndpoint: string;
	registrationEndpoint?: string | null;
	metadata?: Record<string, unknown> | null;
	resource?: string | null;
	source: McpOAuthBindingSource;
}): AuthorizationServerSnapshot | null {
	try {
		const binding = buildMcpOAuthBinding({
			authorizationServerUrl: input.authorizationServerUrl,
			tokenEndpoint: input.tokenEndpoint,
			metadata: {
				...(input.metadata ?? {}),
				authorization_endpoint: input.authorizationEndpoint,
				...(input.registrationEndpoint
					? { registration_endpoint: input.registrationEndpoint }
					: {}),
			},
			resource: input.resource,
			source: input.source,
		});
		const authorizationEndpoint =
			binding.authorizationServerMetadata.authorization_endpoint;
		if (!authorizationEndpoint) {
			return null;
		}
		return {
			binding,
			authorizationEndpoint,
			registrationEndpoint:
				binding.authorizationServerMetadata.registration_endpoint ??
				null,
			scopesSupported:
				binding.authorizationServerMetadata.scopes_supported ?? [],
		};
	} catch {
		return null;
	}
}

/**
 * The catalog's AS for a server — its own configured endpoints, else the
 * known-endpoint table — or null. Never contacts anything.
 */
function resolveCatalogAuthorizationServer(
	server: OAuthServerFields,
	baseUrl: string | null,
): AuthorizationServerSnapshot | null {
	const known = getKnownOAuthEndpoints(baseUrl, server);
	if (server.oauthTokenEndpoint) {
		const knownMatches = known?.tokenEndpoint === server.oauthTokenEndpoint;
		const authorizationEndpoint =
			server.oauthAuthorizationEndpoint ??
			(knownMatches ? known?.authorizationEndpoint : undefined);
		const authorizationServerUrl = knownMatches
			? known?.authorizationServerUrl
			: originOf(server.oauthTokenEndpoint);
		if (authorizationEndpoint && authorizationServerUrl) {
			return snapshotFrom({
				authorizationServerUrl,
				tokenEndpoint: server.oauthTokenEndpoint,
				authorizationEndpoint,
				registrationEndpoint: server.dcrRegistrationEndpoint,
				source: "catalog",
			});
		}
	}
	if (known) {
		return snapshotFrom({
			authorizationServerUrl: known.authorizationServerUrl,
			tokenEndpoint: known.tokenEndpoint,
			authorizationEndpoint: known.authorizationEndpoint,
			source: "catalog",
		});
	}
	return null;
}

/**
 * The AS from Fabric's pinned known-endpoint table only — never a catalog
 * row's editable fields. Where Fabric's own client is sent.
 */
function resolveKnownAuthorizationServer(
	server: OAuthServerFields,
	baseUrl: string | null,
): AuthorizationServerSnapshot | null {
	const known = getKnownOAuthEndpoints(baseUrl, server);
	return known
		? snapshotFrom({
				authorizationServerUrl: known.authorizationServerUrl,
				tokenEndpoint: known.tokenEndpoint,
				authorizationEndpoint: known.authorizationEndpoint,
				source: "catalog",
			})
		: null;
}

/**
 * An AS configured independently of both the MCP server and the person who
 * owns the config: a SYSTEM-PROVIDED catalog row's endpoints, or Fabric's
 * known-endpoint table. A custom row's endpoints do not count — their owner
 * can change them. The only AS an unbound credential (a stored client, an
 * imported token) may be bound to.
 */
export function resolveIndependentAuthorizationServer(
	server: OAuthServerFields,
	baseUrl: string | null,
): AuthorizationServerSnapshot | null {
	return server.isSystemProvided === true
		? resolveCatalogAuthorizationServer(server, baseUrl)
		: resolveKnownAuthorizationServer(server, baseUrl);
}

/** The binding of `resolveIndependentAuthorizationServer`, or null. */
export function independentBindingFor(
	server: OAuthServerFields,
	baseUrl: string | null,
): McpOAuthBinding | null {
	return (
		resolveIndependentAuthorizationServer(server, baseUrl)?.binding ?? null
	);
}

/**
 * The binding a client entered by hand is given at the moment it is entered:
 * the independent AS, or — on a custom server — the endpoints the server
 * names right then. A later change to those endpoints removes the client
 * with its binding (`updateCustomMcpServer`), so it is never re-associated
 * with endpoints it was not entered for.
 */
export function enteredClientBindingFor(
	server: OAuthServerFields,
	baseUrl: string | null,
): McpOAuthBinding | null {
	return (
		independentBindingFor(server, baseUrl) ??
		resolveCatalogAuthorizationServer(server, baseUrl)?.binding ??
		null
	);
}

/**
 * The issuer a metadata document fetched from `documentUrl` must declare
 * (RFC 8414 §3 and OpenID Discovery §4): the URL with its well-known segment
 * removed — `https://as/.well-known/oauth-authorization-server/t1` →
 * `https://as/t1`, `https://as/t1/.well-known/openid-configuration` →
 * `https://as/t1`.
 */
function issuerForDiscoveryDocument(documentUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(documentUrl);
	} catch {
		return null;
	}
	const marker = "/.well-known/";
	const at = url.pathname.indexOf(marker);
	if (at < 0) {
		return null;
	}
	const before = url.pathname.slice(0, at);
	const after = url.pathname.slice(at + marker.length);
	const slash = after.indexOf("/");
	const suffix = slash >= 0 ? after.slice(slash) : "";
	return `${url.origin}${before}${suffix}`;
}

/**
 * A document's self-declared `issuer` is acceptable only when it names the AS
 * it was fetched for. A document without one is accepted under that AS's
 * identity (never under one it could choose).
 */
function issuerMatches(declared: unknown, expected: string): boolean {
	if (declared === undefined || declared === null || declared === "") {
		return true;
	}
	return (
		typeof declared === "string" &&
		sameAuthorizationServer(declared, expected)
	);
}

/**
 * The snapshot of a stored binding: its pinned token endpoint and metadata,
 * never endpoints from a newer document. The authorization endpoint (which
 * receives no secret) falls back to `fallbackAuthorizationEndpoint` for a
 * binding written without one.
 */
export function snapshotFromBinding(
	binding: McpOAuthBinding,
	fallback: AuthorizationServerSnapshot | null,
): AuthorizationServerSnapshot | null {
	const metadata = binding.authorizationServerMetadata;
	const authorizationEndpoint =
		metadata.authorization_endpoint ?? fallback?.authorizationEndpoint;
	if (!authorizationEndpoint) {
		return null;
	}
	return {
		binding,
		authorizationEndpoint,
		registrationEndpoint: metadata.registration_endpoint ?? null,
		scopesSupported:
			metadata.scopes_supported ?? fallback?.scopesSupported ?? [],
	};
}

/**
 * The AS recorded on a person's GitLab connection (the issuer of their
 * credential, recorded at connect time): an independent record, so a stored
 * GitLab client may be bound to it.
 */
export function gitlabConnectionAuthorizationServer(
	origin: string,
): AuthorizationServerSnapshot | null {
	return snapshotFrom({
		authorizationServerUrl: origin,
		tokenEndpoint: `${origin}/oauth/token`,
		authorizationEndpoint: `${origin}/oauth/authorize`,
		source: "connection",
	});
}

async function fetchDiscoveryDocument(
	discoveryUrl: string,
): Promise<Record<string, unknown> | null> {
	try {
		assertSafeOutboundUrl(discoveryUrl);
		const res = await safeFetchOutbound(discoveryUrl, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			return null;
		}
		const json = (await res.json()) as unknown;
		return json && typeof json === "object" && !Array.isArray(json)
			? (json as Record<string, unknown>)
			: null;
	} catch (error) {
		console.error(
			`OAuth discovery failed for ${discoveryUrl}:`,
			error instanceof Error ? error.message : error,
		);
		return null;
	}
}

async function discoverAuthorizationServer(
	server: OAuthServerFields,
	baseUrl: string | null,
): Promise<AuthorizationServerSnapshot | null> {
	// A configured discovery document (the catalog names its URL).
	if (server.oauthDiscoveryUrl) {
		let isDocument = false;
		try {
			isDocument = new URL(server.oauthDiscoveryUrl).pathname.includes(
				"/.well-known/",
			);
		} catch {
			return null;
		}
		if (isDocument) {
			const doc = await fetchDiscoveryDocument(server.oauthDiscoveryUrl);
			const tokenEndpoint =
				typeof doc?.token_endpoint === "string"
					? doc.token_endpoint
					: null;
			const authorizationEndpoint =
				server.oauthAuthorizationEndpoint ??
				(typeof doc?.authorization_endpoint === "string"
					? doc.authorization_endpoint
					: null);
			if (!doc || !tokenEndpoint || !authorizationEndpoint) {
				return null;
			}
			// The identity credentials are bound to is the AS URL Fabric chose
			// to fetch metadata from, never what the document says about
			// itself. A document whose `issuer` names another AS is refused
			// (RFC 8414 §3.3): it could otherwise borrow that AS's identity —
			// and its stored client — while naming its own token endpoint.
			const expectedIssuer = issuerForDiscoveryDocument(
				server.oauthDiscoveryUrl,
			);
			if (!expectedIssuer || !issuerMatches(doc.issuer, expectedIssuer)) {
				console.error(
					"[OAuth discovery] Refused a metadata document whose issuer does not match the URL it was fetched from",
					{ discoveryUrl: server.oauthDiscoveryUrl },
				);
				return null;
			}
			return snapshotFrom({
				authorizationServerUrl: expectedIssuer,
				tokenEndpoint,
				authorizationEndpoint,
				registrationEndpoint:
					(typeof doc.registration_endpoint === "string"
						? doc.registration_endpoint
						: null) ?? server.dcrRegistrationEndpoint,
				metadata: doc,
				source: "discovery",
			});
		}
	}

	const discoveryBase = server.oauthDiscoveryUrl ?? baseUrl;
	if (!discoveryBase) {
		return null;
	}
	let origin: string;
	try {
		origin = new URL(discoveryBase).origin;
		assertSafeOutboundUrl(origin);
	} catch {
		return null;
	}
	const result = await discoverOAuthEndpoints(origin);
	const metadata = result.success ? result.metadata : undefined;
	if (
		!metadata?.tokenEndpoint ||
		!metadata.authorizationServerUrl ||
		!(server.oauthAuthorizationEndpoint ?? metadata.authorizationEndpoint)
	) {
		return null;
	}
	// Bound to the AS URL the metadata was fetched from; a document claiming
	// to be another AS is refused (see above).
	if (
		!issuerMatches(
			metadata.authorizationServerMetadata?.issuer,
			metadata.authorizationServerUrl,
		)
	) {
		console.error(
			"[OAuth discovery] Refused a metadata document whose issuer does not match the authorization server it was fetched for",
			{ authorizationServerUrl: metadata.authorizationServerUrl },
		);
		return null;
	}
	return snapshotFrom({
		authorizationServerUrl: metadata.authorizationServerUrl,
		tokenEndpoint: metadata.tokenEndpoint,
		authorizationEndpoint: (server.oauthAuthorizationEndpoint ??
			metadata.authorizationEndpoint) as string,
		registrationEndpoint:
			metadata.registrationEndpoint ?? server.dcrRegistrationEndpoint,
		metadata: {
			...((metadata.authorizationServerMetadata ?? {}) as Record<
				string,
				unknown
			>),
			...(metadata.scopesSupported
				? { scopes_supported: metadata.scopesSupported }
				: {}),
		},
		resource: metadata.resource,
		source: "discovery",
	});
}

/**
 * The AS an OAuth flow for this server uses: the catalog's when it names
 * one, else the discovered one, else the known table. With `catalogOnly`
 * (Fabric's pre-registered clients) discovery is never consulted.
 */
export async function resolveAuthorizationServer(args: {
	server: OAuthServerFields;
	baseUrl: string | null;
	catalogOnly?: boolean;
}): Promise<AuthorizationServerSnapshot | null> {
	const { server, baseUrl } = args;
	if (server.oauthTokenEndpoint || args.catalogOnly) {
		const catalog = resolveCatalogAuthorizationServer(server, baseUrl);
		if (catalog || args.catalogOnly) {
			return catalog;
		}
	}
	const discovered = await discoverAuthorizationServer(server, baseUrl);
	if (discovered) {
		return discovered;
	}
	return resolveCatalogAuthorizationServer(server, baseUrl);
}

// =============================================================================
// OAuth state snapshot (start → callback)
// =============================================================================

/** What the state row carries from `start` to the callback. Not secret. */
export type OAuthFlowSnapshot = {
	binding: McpOAuthBinding;
	/** The client `start` put in the authorization URL. */
	clientId: string;
	/**
	 * `credentialFingerprint` of the client (id and secret ciphertext, no
	 * refresh token) `start` resolved. The callback exchanges the code only
	 * while the stored client still has this fingerprint, so a secret
	 * replaced under the same id in between is never sent. The refresh token
	 * is left out: the callback does not send it, and a refresh rotating it
	 * meanwhile must not break the reconnect.
	 */
	clientFingerprint: string;
};

export function serializeOAuthFlowSnapshot(
	snapshot: OAuthFlowSnapshot,
): Record<string, unknown> {
	return {
		binding: snapshot.binding as unknown as Record<string, unknown>,
		clientId: snapshot.clientId,
		clientFingerprint: snapshot.clientFingerprint,
	};
}

export function parseOAuthFlowSnapshot(
	value: unknown,
): OAuthFlowSnapshot | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const binding = parseMcpOAuthBinding(raw.binding);
	if (
		!binding ||
		typeof raw.clientId !== "string" ||
		!raw.clientId ||
		typeof raw.clientFingerprint !== "string" ||
		!raw.clientFingerprint
	) {
		return null;
	}
	return {
		binding,
		clientId: raw.clientId,
		clientFingerprint: raw.clientFingerprint,
	};
}

/** The fingerprint of a stored client alone (no refresh token). */
export function oauthClientFingerprint(client: {
	oauthClientId: string | null;
	encryptedOauthClientSecret: string | null;
}): string {
	return credentialFingerprint({
		oauthClientId: client.oauthClientId,
		encryptedOauthClientSecret: client.encryptedOauthClientSecret,
		encryptedRefreshToken: null,
	});
}

// =============================================================================
// Dynamic client registration (RFC 7591)
// =============================================================================

export type OAuthClientRegistrationResult =
	| {
			ok: true;
			clientId: string;
			clientSecret: string | null;
			/** The registration response, for `allowlistDcrClientMetadata`. */
			response: Record<string, unknown>;
	  }
	| { ok: false; status: number | null; message: string };

/**
 * Register Fabric as an OAuth client at `registrationEndpoint`, through the
 * guarded outbound fetch (redirects refused). Logs only the client id and the
 * response's key names — never the response body, which carries the client
 * secret and possibly a registration access token.
 */
export async function registerOAuthClient(args: {
	registrationEndpoint: string;
	metadata: Record<string, unknown>;
}): Promise<OAuthClientRegistrationResult> {
	const { classifyOAuthErrorCode, sanitizeOAuthErrorText } = await import(
		"@repo/utils/oauth-refresh"
	);
	let res: Response;
	try {
		res = await safeFetchOutbound(args.registrationEndpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify(args.metadata),
			redirect: "error",
		});
	} catch (error) {
		const message = sanitizeOAuthErrorText(
			error instanceof Error ? error.message : String(error),
		);
		console.error("[OAuth DCR] Registration request failed", {
			endpoint: args.registrationEndpoint,
			error: message,
		});
		return { ok: false, status: null, message };
	}
	const json = (await res.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	const responseKeys =
		json && typeof json === "object" ? Object.keys(json).sort() : [];
	const clientId =
		json && typeof json.client_id === "string" && json.client_id
			? json.client_id
			: null;

	if (!res.ok || !json || !clientId) {
		// The provider's `error` is classified, never repeated: an unknown
		// value becomes `unrecognized_error`.
		const error =
			json && json.error !== undefined && json.error !== null
				? classifyOAuthErrorCode(json.error)
				: null;
		const description =
			typeof json?.error_description === "string"
				? sanitizeOAuthErrorText(json.error_description)
				: null;
		console.error(
			`[OAuth DCR] Registration failed with status ${res.status}`,
			{
				endpoint: args.registrationEndpoint,
				responseKeys,
				error,
				errorDescription: description,
			},
		);
		return {
			ok: false,
			status: res.status,
			message:
				description ||
				error ||
				(res.ok
					? "Dynamic registration response missing client_id"
					: `Dynamic client registration failed (${res.status})`),
		};
	}

	console.log(
		`[OAuth DCR] Registered client at ${args.registrationEndpoint}`,
		{
			clientId,
			responseKeys,
		},
	);
	return {
		ok: true,
		clientId,
		clientSecret:
			typeof json.client_secret === "string" && json.client_secret
				? json.client_secret
				: null,
		response: json,
	};
}
