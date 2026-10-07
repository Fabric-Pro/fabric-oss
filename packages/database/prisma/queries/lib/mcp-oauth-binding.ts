/**
 * Pure helpers for MCP OAuth credential bindings: building, reading and
 * comparing a binding, the stored form of a client registration, and the
 * client authentication method. No database access, so the API layer, the
 * MCP provider and tests can use them directly.
 *
 * The writes live in `../mcp-oauth-credentials.ts`.
 */

import { createHash } from "node:crypto";
import type { OAuthClientAuthMethod } from "@repo/utils/oauth-refresh";

// =============================================================================
// Binding
// =============================================================================

/**
 * Where a binding's AS came from: discovery at an AS URL Fabric chose (the
 * protected resource's first authorization server, or the catalog's discovery
 * document), the catalog or known-endpoint table, the migration backfill, or
 * the person's GitLab connection record (the issuer of their credential).
 */
export type McpOAuthBindingSource =
	| "discovery"
	| "catalog"
	| "backfill"
	| "connection";

/**
 * The validated subset of RFC 8414 metadata a binding keeps. Not secret.
 * `token_endpoint` always equals the binding's own `tokenEndpoint`.
 */
export interface McpOAuthAuthorizationServerMetadata {
	issuer?: string;
	authorization_endpoint?: string;
	token_endpoint: string;
	registration_endpoint?: string;
	response_types_supported?: string[];
	code_challenge_methods_supported?: string[];
	token_endpoint_auth_methods_supported?: string[];
	grant_types_supported?: string[];
	scopes_supported?: string[];
}

export interface McpOAuthBinding {
	/** The AS identity credentials are bound to (the SDK's `issuer` stamp). */
	authorizationServerUrl: string;
	/** The only endpoint a refresh token, secret or code is ever sent to. */
	tokenEndpoint: string;
	authorizationServerMetadata: McpOAuthAuthorizationServerMetadata;
	/** RFC 8707 resource indicator, when the protected resource named one. */
	resource?: string;
	source: McpOAuthBindingSource;
	/** ISO-8601 time the binding was written. */
	boundAt: string;
	/**
	 * The fingerprint (`credentialFingerprint`) of the stored credential set
	 * this binding was written with: client id, client secret ciphertext and
	 * refresh token ciphertext. A client secret or refresh token is sent only
	 * while the stored set still matches: any writer that rewrote one of those
	 * columns without this module — the previous app version during a rolling
	 * deploy writes by id alone — leaves a mismatch, and nothing is sent.
	 * Written only by the credential module (and the backfill migration, with
	 * the same encoding).
	 */
	credentialFingerprint?: string;
}

const METADATA_URL_KEYS = [
	"authorization_endpoint",
	"registration_endpoint",
] as const;

const METADATA_LIST_KEYS = [
	"response_types_supported",
	"code_challenge_methods_supported",
	"token_endpoint_auth_methods_supported",
	"grant_types_supported",
	"scopes_supported",
] as const;

const BINDING_SOURCES: ReadonlySet<string> = new Set([
	"discovery",
	"catalog",
	"backfill",
	"connection",
]);

/** An absolute http(s) URL with no embedded credentials, or null. */
function httpUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}
	const trimmed = value.trim();
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return null;
		}
		if (url.username || url.password) {
			return null;
		}
		return trimmed;
	} catch {
		return null;
	}
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter(
		(entry): entry is string =>
			typeof entry === "string" &&
			entry.length > 0 &&
			entry.length <= 512,
	);
	return strings.length > 0 ? strings.slice(0, 100) : undefined;
}

function pickMetadata(
	metadata: Record<string, unknown> | null | undefined,
	tokenEndpoint: string,
): McpOAuthAuthorizationServerMetadata {
	const picked: McpOAuthAuthorizationServerMetadata = {
		token_endpoint: tokenEndpoint,
	};
	if (!metadata) {
		return picked;
	}
	if (typeof metadata.issuer === "string" && metadata.issuer.length > 0) {
		picked.issuer = metadata.issuer.slice(0, 2048);
	}
	for (const key of METADATA_URL_KEYS) {
		const url = httpUrl(metadata[key]);
		if (url) {
			picked[key] = url;
		}
	}
	for (const key of METADATA_LIST_KEYS) {
		const list = stringList(metadata[key]);
		if (list) {
			picked[key] = list;
		}
	}
	return picked;
}

/**
 * Build a binding from an AS identity, its token endpoint and (optionally)
 * its RFC 8414 metadata. Only the allowlisted metadata keys are kept, and the
 * metadata's own `token_endpoint` is replaced by `tokenEndpoint`: the binding
 * field is authoritative. Throws when either URL is not an http(s) URL.
 */
export function buildMcpOAuthBinding(input: {
	authorizationServerUrl: string;
	tokenEndpoint: string;
	metadata?: Record<string, unknown> | null;
	resource?: string | null;
	source: McpOAuthBindingSource;
	boundAt?: Date;
}): McpOAuthBinding {
	const authorizationServerUrl = httpUrl(input.authorizationServerUrl);
	const tokenEndpoint = httpUrl(input.tokenEndpoint);
	if (!authorizationServerUrl || !tokenEndpoint) {
		throw new Error(
			"An OAuth binding needs an http(s) authorization server URL and token endpoint",
		);
	}
	const resource = httpUrl(input.resource);
	return {
		authorizationServerUrl,
		tokenEndpoint,
		authorizationServerMetadata: pickMetadata(
			input.metadata,
			tokenEndpoint,
		),
		...(resource ? { resource } : {}),
		source: input.source,
		boundAt: (input.boundAt ?? new Date()).toISOString(),
	};
}

/**
 * Read a stored binding. Anything malformed reads as unbound (`null`), which
 * fails closed: an unbound config never refreshes.
 */
export function parseMcpOAuthBinding(value: unknown): McpOAuthBinding | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const authorizationServerUrl = httpUrl(raw.authorizationServerUrl);
	const tokenEndpoint = httpUrl(raw.tokenEndpoint);
	if (!authorizationServerUrl || !tokenEndpoint) {
		return null;
	}
	if (typeof raw.source !== "string" || !BINDING_SOURCES.has(raw.source)) {
		return null;
	}
	const metadata =
		raw.authorizationServerMetadata &&
		typeof raw.authorizationServerMetadata === "object" &&
		!Array.isArray(raw.authorizationServerMetadata)
			? (raw.authorizationServerMetadata as Record<string, unknown>)
			: null;
	const resource = httpUrl(raw.resource);
	return {
		authorizationServerUrl,
		tokenEndpoint,
		authorizationServerMetadata: pickMetadata(metadata, tokenEndpoint),
		...(resource ? { resource } : {}),
		source: raw.source as McpOAuthBindingSource,
		boundAt: typeof raw.boundAt === "string" ? raw.boundAt : "",
		...(typeof raw.credentialFingerprint === "string" &&
		raw.credentialFingerprint
			? { credentialFingerprint: raw.credentialFingerprint }
			: {}),
	};
}

/** The stored columns a credential fingerprint covers. */
export type McpOAuthCredentialColumns = {
	oauthClientId: string | null;
	encryptedOauthClientSecret: string | null;
	encryptedRefreshToken: string | null;
};

/**
 * Hex SHA-256 (plain, unkeyed) of the canonical encoding of the stored
 * credential columns: the string `"v1"`, then for each of `oauthClientId`,
 * `encryptedOauthClientSecret`, `encryptedRefreshToken` in that order, `"|"`
 * followed by `"-"` for null or `<UTF-8 byte length>:<value>`. Length
 * prefixes make it unambiguous whatever the values contain; the backfill
 * migration computes the identical string in SQL
 * (`octet_length(x)::text || ':' || x`, `sha256(convert_to(…, 'UTF8'))`).
 *
 * Ciphertexts are hashed, so the fingerprint reveals nothing the database
 * does not already hold, and because encryption is not deterministic any
 * rewrite of a field — even of the same plaintext — changes it.
 *
 * `token_endpoint_auth_method` is left out: it lives in JSON that writers
 * rewrite as a whole, and no writer changes it without also writing the
 * client id and secret, which are covered.
 */
export function credentialFingerprint(
	columns: McpOAuthCredentialColumns,
): string {
	const field = (value: string | null) =>
		value === null || value === undefined
			? "-"
			: `${Buffer.byteLength(value, "utf8")}:${value}`;
	const canonical = `v1|${field(columns.oauthClientId)}|${field(
		columns.encryptedOauthClientSecret,
	)}|${field(columns.encryptedRefreshToken)}`;
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The binding carrying the fingerprint of `columns`. */
export function withCredentialFingerprint(
	binding: McpOAuthBinding,
	columns: McpOAuthCredentialColumns,
): McpOAuthBinding {
	return {
		...binding,
		credentialFingerprint: credentialFingerprint(columns),
	};
}

/**
 * Whether the stored credential columns are the set this binding was written
 * with. A binding without a fingerprint never matches: every binding this
 * code and the backfill write carries one. Covers what Fabric SENDS to the
 * authorization server (client secret, refresh token); presenting an access
 * token to the MCP server is not covered.
 */
export function credentialFingerprintMatches(
	binding: McpOAuthBinding,
	columns: McpOAuthCredentialColumns,
): boolean {
	return (
		!!binding.credentialFingerprint &&
		binding.credentialFingerprint === credentialFingerprint(columns)
	);
}

/**
 * The credential columns a caller read, for a write that keeps the stored
 * client: the write re-fingerprints the binding only when that client was
 * trustworthy as read (`isStoredMcpOAuthClientTrusted`).
 */
export type McpOAuthStoredCredentials = McpOAuthCredentialColumns & {
	oauthBinding: unknown;
};

/**
 * Whether a stored client may be carried under a re-fingerprinted (or newly
 * written) binding.
 *
 * - Bound: only while the binding's fingerprint still matches what is
 *   stored. A client replaced under a binding by a writer outside the
 *   credential module stays untrusted: a write that keeps it must not
 *   launder it into a matching fingerprint.
 * - Unbound (no binding, or a bearer-only marker): only when it holds no
 *   client secret. A public client's id is nothing secret to misdirect; a
 *   secret on an unbound row has no provenance — the previous app version
 *   may have written one issued by another authorization server under the
 *   same client id — so it is never bound or fingerprinted, only replaced.
 */
export function isStoredMcpOAuthClientTrusted(
	stored: McpOAuthStoredCredentials,
): boolean {
	const binding = parseMcpOAuthBinding(stored.oauthBinding);
	return binding
		? credentialFingerprintMatches(binding, stored)
		: stored.encryptedOauthClientSecret === null;
}

/** Whether two token endpoint URLs are the same endpoint. */
function sameEndpoint(a: string, b: string): boolean {
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return a === b;
	}
}

/**
 * Whether a write may keep the stored client and fingerprint it under
 * `destination` — a binding that may name another authorization server than
 * the one the client is bound to now. A client secret may only ever reach the
 * token endpoint of a binding written for it and naming the AS that issued
 * it, so:
 *
 * - no stored client at all: nothing is carried;
 * - bound: only while its binding's fingerprint still matches what is stored
 *   AND `destination` names the same authorization server and the same token
 *   endpoint. A client verified for one AS is never re-pointed at another;
 * - unbound (no binding, or a bearer-only marker): only a public client (no
 *   secret), as `isStoredMcpOAuthClientTrusted`.
 */
export function mayStoredMcpOAuthClientFollow(
	stored: McpOAuthStoredCredentials,
	destination: McpOAuthBinding,
): boolean {
	if (
		stored.oauthClientId === null &&
		stored.encryptedOauthClientSecret === null
	) {
		return true;
	}
	const current = parseMcpOAuthBinding(stored.oauthBinding);
	if (!current) {
		return stored.encryptedOauthClientSecret === null;
	}
	return (
		credentialFingerprintMatches(current, stored) &&
		sameAuthorizationServer(
			current.authorizationServerUrl,
			destination.authorizationServerUrl,
		) &&
		sameEndpoint(current.tokenEndpoint, destination.tokenEndpoint)
	);
}

/**
 * The `oauthBinding` value of a token set imported by hand where no
 * authorization server may be trusted (a custom server's import): explicitly
 * BEARER-ONLY. Its access token is presented until it expires; it is never
 * refreshed and its refresh token and client are never sent anywhere. Kept
 * distinct from a legacy unbound row (`oauthBinding` null), which the
 * backfill sent through reconnect. Not a binding: `parseMcpOAuthBinding`
 * reads it as unbound.
 */
export type McpOAuthBearerOnly = {
	mode: "bearer-only";
	importedAt: string;
};

export function bearerOnlyOAuthMarker(
	at: Date = new Date(),
): McpOAuthBearerOnly {
	return { mode: "bearer-only", importedAt: at.toISOString() };
}

export function isMcpOAuthBearerOnly(value: unknown): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).mode === "bearer-only"
	);
}

/**
 * Whether two AS identifiers name the same server: compared as parsed URLs,
 * tolerating one trailing `/` (the same rule the MCP SDK applies to its
 * `issuer` stamp).
 */
export function sameAuthorizationServer(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	if (!a || !b) {
		return false;
	}
	let [x, y] = [a, b];
	try {
		[x, y] = [new URL(a).href, new URL(b).href];
	} catch {
		// Not two URLs: compared as written.
	}
	return (
		x === y ||
		(x.endsWith("/") && x.slice(0, -1) === y) ||
		(y.endsWith("/") && y.slice(0, -1) === x)
	);
}

/** Whether two bindings send credentials to the same place. */
export function sameMcpOAuthBinding(
	a: McpOAuthBinding | null,
	b: McpOAuthBinding | null,
): boolean {
	return (
		!!a &&
		!!b &&
		a.tokenEndpoint === b.tokenEndpoint &&
		sameAuthorizationServer(
			a.authorizationServerUrl,
			b.authorizationServerUrl,
		)
	);
}

// =============================================================================
// Client registration
// =============================================================================

/**
 * The RFC 7591 registration response fields kept in `dcrClientMetadata`.
 * Never `client_secret`, `registration_access_token` or
 * `registration_client_uri`: nothing uses the latter two, and a secret has its
 * own encrypted column.
 */
export const MCP_DCR_CLIENT_METADATA_KEYS = [
	"client_id_issued_at",
	"client_secret_expires_at",
	"client_secret_issued_at",
	"token_endpoint_auth_method",
	"grant_types",
	"response_types",
	"redirect_uris",
	"scope",
	"client_name",
] as const;

function isSupportedAuthMethod(value: unknown): value is OAuthClientAuthMethod {
	return (
		value === "client_secret_basic" ||
		value === "client_secret_post" ||
		value === "none"
	);
}

/**
 * The stored form of a registration response: the allowlisted keys, plus
 * `issuer` set by Fabric from the AS it registered with (never copied from
 * the response), and the EFFECTIVE `token_endpoint_auth_method`: the
 * response's value when it is one Fabric supports, otherwise the method
 * Fabric requested (RFC 7591 §2: the server registers what was requested
 * when it does not say otherwise).
 */
export function allowlistDcrClientMetadata(
	response: Record<string, unknown> | null | undefined,
	issuer: string | null,
	requestedAuthMethod: OAuthClientAuthMethod,
): Record<string, unknown> {
	const kept: Record<string, unknown> = {};
	if (response) {
		for (const key of MCP_DCR_CLIENT_METADATA_KEYS) {
			if (response[key] !== undefined && response[key] !== null) {
				kept[key] = response[key];
			}
		}
	}
	kept.token_endpoint_auth_method = isSupportedAuthMethod(
		response?.token_endpoint_auth_method,
	)
		? response?.token_endpoint_auth_method
		: requestedAuthMethod;
	if (issuer) {
		kept.issuer = issuer;
	}
	return kept;
}

/**
 * The stored metadata of a client Fabric did not register dynamically (its
 * own pre-registered client, or one entered by hand): just its explicit
 * authentication method, `client_secret_post` — what Fabric has always sent
 * for those clients.
 */
export function explicitClientMetadata(
	method: OAuthClientAuthMethod = "client_secret_post",
): Record<string, unknown> {
	return { token_endpoint_auth_method: method };
}

/**
 * The client authentication method a config's client was registered with:
 * the stored per-client `token_endpoint_auth_method` (written at
 * registration). A row stored before that value was recorded falls back to
 * what it was registered with: `client_secret_basic` for a dynamically
 * registered client (the method Fabric requests, and RFC 7591's default) and
 * `client_secret_post` for Fabric's pre-registered and hand-entered clients
 * (what Fabric always sent for them). A client is public (`none`) only when
 * its registration says so.
 */
export function resolveMcpClientAuthMethod(cfg: {
	dcrClientMetadata?: unknown;
	dcrRegisteredAt?: Date | string | null;
	encryptedOauthClientSecret?: string | null;
}): OAuthClientAuthMethod {
	const metadata = cfg.dcrClientMetadata as Record<string, unknown> | null;
	const method = metadata?.token_endpoint_auth_method;
	if (isSupportedAuthMethod(method)) {
		return method;
	}
	return cfg.dcrRegisteredAt ? "client_secret_basic" : "client_secret_post";
}

/** A public client (`token_endpoint_auth_method: "none"`) sends no secret. */
export function isPublicMcpOAuthClient(cfg: {
	dcrClientMetadata?: unknown;
	encryptedOauthClientSecret?: string | null;
}): boolean {
	const metadata = cfg.dcrClientMetadata as Record<string, unknown> | null;
	return metadata?.token_endpoint_auth_method === "none";
}
