/**
 * RFC 6749 §6 refresh-token grant against an OAuth 2.0 token endpoint.
 *
 * Routes through `safeFetchOutbound` for SSRF protection. Sends
 * `accept: application/json` (GitHub silently returns form-encoded
 * responses without it). Omits `client_secret` for public clients
 * (`token_endpoint_auth_method: "none"`).
 *
 * Never throws — returns a discriminated `OAuthRefreshResult`.
 */

import * as urlSecurity from "./url-security";

export type OAuthRefreshRequest = {
	/** Resolved token endpoint URL. Caller handles discovery / fallbacks. */
	tokenEndpoint: string;
	/** Plaintext refresh token. Caller handles decryption. */
	refreshToken: string;
	clientId: string;
	/** Undefined => public client (`token_endpoint_auth_method: "none"`). */
	clientSecret?: string;
	/** Some providers require echoing scope on refresh. */
	scope?: string;
};

export type OAuthRefreshSuccess = {
	ok: true;
	accessToken: string;
	/** Null when the provider did not rotate the refresh token. */
	refreshToken: string | null;
	/** Seconds until expiry. Null when the provider did not send `expires_in`. */
	expiresIn: number | null;
	tokenType: string | null;
	scope: string | null;
};

export type OAuthRefreshFailure = {
	ok: false;
	/**
	 * Stable error code for caller logic. One of:
	 *   - An RFC 6749 error code (e.g. `invalid_grant`, `invalid_client`).
	 *   - `network_error` — fetch threw (network/SSRF/abort).
	 *   - `invalid_response` — server returned 2xx but the body was missing
	 *     `access_token` or could not be parsed as JSON.
	 *   - `http_<status>` — server returned a non-2xx status without a
	 *     parseable JSON `error` field.
	 */
	errorCode: string;
	/** Human-readable message safe to store in `lastRefreshError` columns. */
	errorMessage: string;
};

export type OAuthRefreshResult = OAuthRefreshSuccess | OAuthRefreshFailure;

type TokenResponseBody = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	token_type?: unknown;
	scope?: unknown;
	error?: unknown;
	error_description?: unknown;
};

const MAX_BODY_SNIPPET_LENGTH = 200;

/**
 * Strip a leading UTF-8 BOM and surrounding whitespace from a credential.
 *
 * Secrets reach us through pipelines that are careless with encoding: a
 * PowerShell `Out-File`/`>` redirect writes UTF-8 **with BOM** by default, and
 * `az keyvault secret set --file <f>` stores those bytes verbatim. The BOM then
 * rides along inside the container-app env var and is silently sent as part of
 * `client_id`, which the provider cannot match — GitHub answers HTTP 404
 * `{"error":"Not Found"}`, indistinguishable at a glance from an expired user
 * token. Fabric shipped exactly that on staging for seven weeks: every GitHub
 * repository-integration refresh failed, and no user could have fixed it by
 * reconnecting.
 *
 * A credential is never legitimately surrounded by whitespace, so trimming is
 * always safe and turns a silent outage into a non-event.
 */
export function sanitizeCredential(value: string): string {
	return value.replace(/^﻿/, "").trim();
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function truncateForError(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_BODY_SNIPPET_LENGTH) {
		return trimmed;
	}
	return `${trimmed.slice(0, MAX_BODY_SNIPPET_LENGTH)}…`;
}

function buildHttpFailure(
	status: number,
	bodySnippet: string,
): OAuthRefreshFailure {
	const code = `http_${status}`;
	const snippet = bodySnippet ? truncateForError(bodySnippet) : "";
	return {
		ok: false,
		errorCode: code,
		errorMessage: snippet
			? `HTTP ${status} from token endpoint: ${snippet}`
			: `HTTP ${status} from token endpoint`,
	};
}

/**
 * Exchange a refresh token for a new access token at an OAuth 2.0 token
 * endpoint. Never throws — always returns a discriminated result.
 */
export async function refreshOAuthToken(
	request: OAuthRefreshRequest,
): Promise<OAuthRefreshResult> {
	// Sanitize at the chokepoint every OAuth refresh in the codebase passes
	// through, so a BOM/whitespace-corrupted credential from ANY source (env
	// var, Key Vault reference, DB-stored app record) cannot silently break
	// refresh for every integration at once.
	const clientId = sanitizeCredential(request.clientId);
	const clientSecret =
		request.clientSecret === undefined
			? undefined
			: sanitizeCredential(request.clientSecret);

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: sanitizeCredential(request.refreshToken),
		client_id: clientId,
	});

	if (clientSecret !== undefined) {
		body.set("client_secret", clientSecret);
	}

	if (request.scope !== undefined && request.scope.length > 0) {
		body.set("scope", request.scope);
	}

	let response: Response;
	try {
		response = await urlSecurity.safeFetchOutbound(request.tokenEndpoint, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			},
			body,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			errorCode: "network_error",
			errorMessage: message,
		};
	}

	// Read body as text first; some providers (notably GitHub) reply
	// form-encoded even when asked for JSON.
	let rawBody = "";
	try {
		rawBody = await response.text();
	} catch {
		rawBody = "";
	}

	let parsed: TokenResponseBody | null = null;
	if (rawBody.length > 0) {
		try {
			parsed = JSON.parse(rawBody) as TokenResponseBody;
		} catch {
			parsed = null;
		}
	}

	if (!response.ok) {
		const providerError = parsed ? asString(parsed.error) : null;
		if (providerError) {
			const description =
				asString(parsed?.error_description) ?? providerError;
			return {
				ok: false,
				errorCode: providerError,
				errorMessage: description,
			};
		}
		return buildHttpFailure(response.status, rawBody);
	}

	if (!parsed) {
		return {
			ok: false,
			errorCode: "invalid_response",
			errorMessage: rawBody
				? `Token endpoint returned non-JSON body: ${truncateForError(rawBody)}`
				: "Token endpoint returned an empty body",
		};
	}

	// Some providers (notably GitHub on a misconfigured app) reply 200 OK
	// with `{ "error": "..." }` instead of an HTTP error status. Treat that
	// as a failure too.
	const providerError = asString(parsed.error);
	if (providerError) {
		const description = asString(parsed.error_description) ?? providerError;
		return {
			ok: false,
			errorCode: providerError,
			errorMessage: description,
		};
	}

	const accessToken = asString(parsed.access_token);
	if (!accessToken) {
		return {
			ok: false,
			errorCode: "invalid_response",
			errorMessage: "Token endpoint response missing access_token",
		};
	}

	return {
		ok: true,
		accessToken,
		refreshToken: asString(parsed.refresh_token),
		expiresIn: asNumber(parsed.expires_in),
		tokenType: asString(parsed.token_type),
		scope: asString(parsed.scope),
	};
}
