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

const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 100;

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
	if (raw.length > MAX_REDIRECT_URI_LENGTH) {
		throw new OAuthRegistrationError(
			"invalid_redirect_uri",
			"redirect_uri is too long",
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

	if (url.protocol === "https:") {
		if (url.username || url.password) {
			throw new OAuthRegistrationError(
				"invalid_redirect_uri",
				"redirect_uri must not contain credentials",
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

	// Any other scheme is a private-use scheme handing control to an installed
	// app (`vscode:`, `cursor:`), which RFC 8252 section 7.1 permits.
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
