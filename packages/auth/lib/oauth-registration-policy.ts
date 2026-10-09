/**
 * What an unauthenticated client may register (RFC 7591).
 *
 * Dynamic registration is open on purpose — an agent has no account to
 * register under — so the only things standing between an anonymous caller and
 * a consent screen carrying their words are the rules in this file. The
 * plugin already refuses `skip_consent`, forces a public client with PKCE and
 * rejects scopes outside the allowed list. What it does not decide, and this
 * does, is which redirect targets are acceptable and which client-supplied
 * text and links ever reach a person.
 */

import { APIError } from "better-auth/api";

const ALLOWED_GRANT_TYPES: readonly string[] = [
	"authorization_code",
	"refresh_token",
];

/** Schemes that execute, embed or fetch rather than hand control to an app. */
const REFUSED_SCHEMES: readonly string[] = [
	"javascript:",
	"data:",
	"file:",
	"vbscript:",
	"blob:",
	"about:",
	"ftp:",
	"ws:",
	"wss:",
	"chrome:",
	"chrome-extension:",
];

const LOOPBACK_HOSTNAMES: readonly string[] = [
	"127.0.0.1",
	"localhost",
	"[::1]",
];

/**
 * Native callbacks that predate RFC 8252's reverse-domain naming. Matched
 * exactly: these are public PKCE clients, open registration already permits
 * arbitrary https redirects, so an exact match adds no new capability. The
 * same list is patched into `@better-auth/oauth-provider` (patches/), whose
 * own registration check would otherwise refuse them, and is written into the
 * database's client trigger; `oauth-redirect-allowlist-parity.test.ts` fails
 * when any copy differs.
 */
export const PRE_RFC8252_NATIVE_REDIRECT_URIS: readonly string[] = [
	"cursor://anysphere.cursor-mcp/oauth/callback",
];

const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 100;
const PRIVATE_USE_SCHEME =
	/^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Fields a client may send that Fabric never shows or follows. Dropped rather
 * than stored: a logo or policy link on a consent screen is a place for an
 * attacker to put an image or a lookalike link.
 */
const DROPPED_METADATA_FIELDS = [
	"client_uri",
	"logo_uri",
	"tos_uri",
	"policy_uri",
	"software_statement",
	"contacts",
	"post_logout_redirect_uris",
	"backchannel_logout_uri",
	"backchannel_logout_session_required",
	"jwks",
	"jwks_uri",
] as const;

/**
 * The before-hook body for `/oauth2/register`: the policy above, with a refusal
 * answered as the RFC 7591 error body rather than an unhandled exception.
 */
export function enforceRegistrationPolicy(body: unknown): void {
	try {
		applyRegistrationPolicy(isRecord(body) ? body : {});
	} catch (error) {
		if (error instanceof OAuthRegistrationError) {
			throw new APIError("BAD_REQUEST", {
				error: error.code,
				error_description: error.message,
			});
		}
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class OAuthRegistrationError extends Error {
	constructor(
		readonly code: "invalid_redirect_uri" | "invalid_client_metadata",
		message: string,
	) {
		super(message);
		this.name = "OAuthRegistrationError";
	}
}

export function assertAllowedRedirectUri(raw: string): void {
	if (PRE_RFC8252_NATIVE_REDIRECT_URIS.includes(raw)) {
		return;
	}
	if (raw.length > MAX_REDIRECT_URI_LENGTH) {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			"redirect_uri is too long",
		);
	}
	// Store absolute URI text, rather than WHATWG's lenient reinterpretation
	// of whitespace or backslashes. Callers can percent-encode query spaces.
	if (/[\s\\]/u.test(raw)) {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			"redirect_uri must encode whitespace and must not contain backslashes",
		);
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			"redirect_uri is not a valid URL",
		);
	}

	if (url.hash) {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			"redirect_uri must not contain a fragment",
		);
	}
	if (REFUSED_SCHEMES.includes(url.protocol)) {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			`redirect_uri scheme ${url.protocol} is not allowed`,
		);
	}
	if (url.username || url.password) {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			"redirect_uri must not contain credentials",
		);
	}

	if (url.protocol === "https:") {
		if (LOOPBACK_HOSTNAMES.includes(url.hostname)) {
			throw new OAuthRegistrationError(
				"invalid_redirect_uri",
				"loopback redirect_uri must use http",
			);
		}
		return;
	}

	if (url.protocol === "http:") {
		if (!LOOPBACK_HOSTNAMES.includes(url.hostname)) {
			throw new OAuthRegistrationError(
				"invalid_redirect_uri",
				"http redirect_uri is only allowed for a loopback address",
			);
		}
		return;
	}

	// Native private-use callbacks follow RFC 8252's reverse-domain scheme and
	// have no naming authority. This matches the provider's registration check.
	const schemeSpecificPart = url.href.slice(url.protocol.length);
	if (
		!PRIVATE_USE_SCHEME.test(url.protocol.slice(0, -1)) ||
		url.host ||
		!schemeSpecificPart.startsWith("/") ||
		schemeSpecificPart.startsWith("//")
	) {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			"private-use redirect_uri must use an authority-free reverse-domain scheme",
		);
	}
}

/**
 * Check a registration request and strip what must not be stored. Mutates the
 * body in place, because that is the object the plugin goes on to read.
 */
export function applyRegistrationPolicy(body: Record<string, unknown>): void {
	const redirectUris = body.redirect_uris;
	if (
		!Array.isArray(redirectUris) ||
		redirectUris.length === 0 ||
		redirectUris.length > MAX_REDIRECT_URIS
	) {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			`between 1 and ${MAX_REDIRECT_URIS} redirect_uris are required`,
		);
	}
	for (const uri of redirectUris) {
		if (typeof uri !== "string") {
			throw new OAuthRegistrationError(
				"invalid_redirect_uri",
				"redirect_uris must be strings",
			);
		}
		assertAllowedRedirectUri(uri);
	}
	// Old CLI versions send `type`, which 1.7's endpoint parser drops. Infer
	// from the validated callbacks instead so those versions can still register.
	if (body.application_type === undefined) {
		body.application_type = redirectUris.some(
			(uri) => new URL(uri as string).protocol !== "https:",
		)
			? "native"
			: "web";
	}
	if (body.dpop_bound_access_tokens === true) {
		throw new OAuthRegistrationError(
			"invalid_client_metadata",
			"DPoP is not supported by the protected endpoints",
		);
	}
	body.dpop_bound_access_tokens = false;

	if (
		body.token_endpoint_auth_method !== undefined &&
		body.token_endpoint_auth_method !== "none"
	) {
		throw new OAuthRegistrationError(
			"invalid_client_metadata",
			"only public clients (token_endpoint_auth_method none) can register",
		);
	}
	body.token_endpoint_auth_method = "none";

	if (body.grant_types !== undefined) {
		if (
			!Array.isArray(body.grant_types) ||
			!body.grant_types.every(
				(grant) =>
					typeof grant === "string" &&
					ALLOWED_GRANT_TYPES.includes(grant),
			)
		) {
			throw new OAuthRegistrationError(
				"invalid_client_metadata",
				"grant_types may only be authorization_code and refresh_token",
			);
		}
	}

	if (typeof body.client_name === "string") {
		// Control characters and bidi overrides would let a name pose as other
		// text on the consent screen.
		const cleaned = body.client_name
			.replace(/[\p{Cc}\p{Cf}]/gu, "")
			.trim()
			.slice(0, MAX_CLIENT_NAME_LENGTH);
		body.client_name = cleaned.length > 0 ? cleaned : undefined;
	}

	for (const field of DROPPED_METADATA_FIELDS) {
		delete body[field];
	}
}
