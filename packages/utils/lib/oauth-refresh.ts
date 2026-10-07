/**
 * RFC 6749 §6 refresh-token grant against an OAuth 2.0 token endpoint.
 *
 * Routes through `safeFetchOutbound` for SSRF protection, with redirects
 * refused. Sends `accept: application/json` (GitHub silently returns
 * form-encoded responses without it). Authenticates the client with the
 * method it was registered with (`clientAuthMethod`): HTTP Basic, the request
 * body, or `client_id` alone for a public client.
 *
 * Error messages are built from the classified error code and a bounded,
 * redacted `error_description`, never from a raw response body, so they are
 * safe to log and to persist.
 *
 * Never throws — returns a discriminated `OAuthRefreshResult`.
 */

import * as urlSecurity from "./url-security";

/**
 * RFC 7591 `token_endpoint_auth_method` values this client supports:
 * `client_secret_basic` sends the credentials in an HTTP Basic
 * `Authorization` header, `client_secret_post` in the form body, and `none`
 * (a public client) sends `client_id` alone.
 */
export type OAuthClientAuthMethod =
	| "client_secret_basic"
	| "client_secret_post"
	| "none";

export type OAuthRefreshRequest = {
	/** Resolved token endpoint URL. Caller handles discovery / fallbacks. */
	tokenEndpoint: string;
	/** Plaintext refresh token. Caller handles decryption. */
	refreshToken: string;
	clientId: string;
	/** Undefined => public client (`token_endpoint_auth_method: "none"`). */
	clientSecret?: string;
	/**
	 * How the client authenticates at the token endpoint. Omitted, a client
	 * with a secret uses `client_secret_post` and one without uses `none`
	 * (the behaviour before this option existed). `none` never sends a
	 * secret, even when one is passed; `client_secret_basic` without a
	 * secret fails without contacting the endpoint.
	 */
	clientAuthMethod?: OAuthClientAuthMethod;
	/** Some providers require echoing scope on refresh. */
	scope?: string;
	/**
	 * One deadline for the whole exchange (connection, headers and body).
	 * Set it whenever the exchange runs inside a bounded budget, such as a
	 * lock transaction whose timeout rolls back regardless of the request.
	 * Omitted, the request has no deadline of its own.
	 */
	timeoutMs?: number;
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
	 *   - A known OAuth error code (e.g. `invalid_grant`, `invalid_client`;
	 *     see `classifyOAuthErrorCode`), or `unrecognized_error` for any other
	 *     provider `error` value, which is never repeated.
	 *   - `network_error` — fetch threw (network/SSRF/abort).
	 *   - `invalid_response` — server returned 2xx but the body was missing
	 *     `access_token` or could not be parsed as JSON.
	 *   - `http_<status>` — server returned a non-2xx status without a
	 *     parseable JSON `error` field.
	 */
	errorCode: string;
	/**
	 * Human-readable message safe to log and to store in `lastRefreshError`
	 * columns: the classified code or a redacted, bounded `error_description`,
	 * never a raw response body.
	 */
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

const MAX_ERROR_TEXT_LENGTH = 200;

/**
 * The OAuth error codes Fabric passes through as `errorCode`. A provider's
 * `error` member is attacker-influenced text (it has been seen carrying the
 * very refresh token that was sent), so only a code from this list is ever
 * repeated; anything else becomes `unrecognized_error`.
 */
const KNOWN_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
	// RFC 6749 §5.2 (token endpoint) and §4.1.2.1 (authorization endpoint)
	"invalid_request",
	"invalid_client",
	"invalid_grant",
	"unauthorized_client",
	"unsupported_grant_type",
	"invalid_scope",
	"access_denied",
	"unsupported_response_type",
	"server_error",
	"temporarily_unavailable",
	// RFC 6750 §3.1
	"invalid_token",
	"insufficient_scope",
	// RFC 7591 §3.2.2
	"invalid_redirect_uri",
	"invalid_client_metadata",
	"invalid_software_statement",
	"unapproved_software_statement",
	// RFC 8628 §3.5
	"authorization_pending",
	"slow_down",
	"expired_token",
	// GitHub's token endpoint (documented codes; repo-token-refresh-fault
	// classifies `bad_refresh_token`).
	"bad_refresh_token",
	"bad_verification_code",
	"incorrect_client_credentials",
	"redirect_uri_mismatch",
	"unverified_user_email",
]);

/** The code Fabric reports for a provider `error` it does not recognise. */
export const UNRECOGNIZED_OAUTH_ERROR_CODE = "unrecognized_error";

/**
 * Classify a provider's `error` member: the code itself when it is a known
 * OAuth error code, otherwise `unrecognized_error`. The raw value is never
 * returned, so it is never logged or persisted.
 */
export function classifyOAuthErrorCode(value: unknown): string {
	return typeof value === "string" && KNOWN_OAUTH_ERROR_CODES.has(value)
		? value
		: UNRECOGNIZED_OAUTH_ERROR_CODE;
}

/** Parameter names whose values are credentials wherever they appear. */
const SECRET_PARAMETER_PATTERN =
	/\b(access_token|refresh_token|id_token|client_secret|code_verifier|code|assertion|password|registration_access_token)(\s*["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi;

/**
 * Make provider-supplied error text safe to log and persist.
 *
 * Removes every exact `secrets` value, credential-named parameters
 * (`refresh_token=…`, `"client_secret": "…"`), bearer values, JWTs and any
 * other long token-shaped run, strips control characters, collapses
 * whitespace and bounds the result to 200 characters.
 */
export function sanitizeOAuthErrorText(
	text: string,
	secrets: ReadonlyArray<string | null | undefined> = [],
): string {
	let out = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 4) {
			out = out.split(secret).join("[redacted]");
		}
	}
	out = out
		.replace(SECRET_PARAMETER_PATTERN, "$1$2[redacted]")
		.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
		.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted]")
		.replace(/[A-Za-z0-9._~+/=-]{24,}/g, (run) =>
			// URLs are not credentials; a long run inside one is a path.
			run.includes("/") && !run.includes("=") ? run : "[redacted]",
		)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u001F\u007F]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (out.length <= MAX_ERROR_TEXT_LENGTH) {
		return out;
	}
	return `${out.slice(0, MAX_ERROR_TEXT_LENGTH)}…`;
}

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

/**
 * The `error` code of a non-JSON error body, when the body is a form-encoded
 * OAuth error (`error=bad_verification_code&…`, as GitHub sends). Only a
 * well-formed RFC 6749 code is returned; nothing else from the body is used.
 */
function formEncodedErrorCode(rawBody: string): string | null {
	try {
		const code = new URLSearchParams(rawBody.trim()).get("error");
		return code ? classifyOAuthErrorCode(code) : null;
	} catch {
		return null;
	}
}

function buildHttpFailure(
	status: number,
	rawBody: string,
): OAuthRefreshFailure {
	const code = `http_${status}`;
	const formError = rawBody ? formEncodedErrorCode(rawBody) : null;
	return {
		ok: false,
		errorCode: code,
		errorMessage: formError
			? `HTTP ${status} from token endpoint (error: ${formError})`
			: `HTTP ${status} from token endpoint`,
	};
}

function providerFailure(
	parsed: TokenResponseBody,
	providerError: string,
	secrets: ReadonlyArray<string | undefined>,
): OAuthRefreshFailure {
	const errorCode = classifyOAuthErrorCode(providerError);
	const description = asString(parsed.error_description);
	return {
		ok: false,
		errorCode,
		errorMessage: description
			? sanitizeOAuthErrorText(description, secrets) || errorCode
			: errorCode,
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

	const refreshToken = sanitizeCredential(request.refreshToken);
	const secrets = [refreshToken, clientSecret];
	const authMethod: OAuthClientAuthMethod =
		request.clientAuthMethod ??
		(clientSecret !== undefined ? "client_secret_post" : "none");

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	};

	if (authMethod === "client_secret_basic") {
		if (clientSecret === undefined || clientSecret.length === 0) {
			return {
				ok: false,
				errorCode: "missing_client_secret",
				errorMessage:
					"client_secret_basic authentication requires a client secret",
			};
		}
		headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
	} else {
		body.set("client_id", clientId);
		if (authMethod === "client_secret_post" && clientSecret !== undefined) {
			body.set("client_secret", clientSecret);
		}
	}

	if (request.scope !== undefined && request.scope.length > 0) {
		body.set("scope", request.scope);
	}

	let response: Response;
	try {
		response = await urlSecurity.safeFetchOutbound(request.tokenEndpoint, {
			method: "POST",
			headers,
			body,
			redirect: "error",
			...(request.timeoutMs === undefined
				? {}
				: { signal: AbortSignal.timeout(request.timeoutMs) }),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			errorCode: "network_error",
			errorMessage: sanitizeOAuthErrorText(message, secrets),
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
		if (parsed && providerError) {
			return providerFailure(parsed, providerError, secrets);
		}
		return buildHttpFailure(response.status, rawBody);
	}

	if (!parsed) {
		return {
			ok: false,
			errorCode: "invalid_response",
			errorMessage: rawBody
				? "Token endpoint returned a non-JSON body"
				: "Token endpoint returned an empty body",
		};
	}

	// Some providers (notably GitHub on a misconfigured app) reply 200 OK
	// with `{ "error": "..." }` instead of an HTTP error status. Treat that
	// as a failure too.
	const providerError = asString(parsed.error);
	if (providerError) {
		return providerFailure(parsed, providerError, secrets);
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
