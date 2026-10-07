import { createPublicKey, type JsonWebKey, verify } from "node:crypto";

/**
 * Server half of OpenAI's "Sign in with ChatGPT" (open-source / locally hosted
 * flow, developers.openai.com/siwc). The browser sign-in and the code exchange
 * run on the member's own machine in `fabric connect chatgpt`; the server only
 * verifies the uploaded ID token, refreshes and revokes.
 */
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_REVOKE_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`;
const CHATGPT_JWKS_URL = `${CHATGPT_ISSUER}/.well-known/jwks.json`;
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";

// Keeps a hung exchange well inside the refresh lock's transaction budget.
export const CHATGPT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

const TERMINAL_REFRESH_ERRORS = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

/**
 * What every surface says when a member's plan is turned on but its sign-in
 * no longer works. Fabric never falls back to the organization's API billing
 * on its own; the member reconnects or switches the organization back.
 */
export const CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE =
	"Your ChatGPT connection needs to be reconnected. Reconnect it, or switch this organization to organization API billing.";

export class ChatGptPlanAuthError extends Error {
	constructor(
		message: string,
		readonly code: string,
		/** True when only a new sign-in can recover. */
		readonly reauthRequired: boolean,
	) {
		super(message);
		this.name = "ChatGptPlanAuthError";
	}
}

export interface ChatGptPlanTokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	token_type: string;
	expires_in: number;
	scope?: string;
	earliest_refresh_at?: unknown;
}

async function postForm(
	url: string,
	body: Record<string, string>,
	fetchImpl: typeof fetch,
): Promise<string> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(CHATGPT_TOKEN_REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	if (!response.ok) {
		let code = `http_${response.status}`;
		try {
			const parsed = JSON.parse(text) as { error?: unknown };
			if (typeof parsed.error === "string") {
				code = parsed.error;
			}
		} catch {}
		throw new ChatGptPlanAuthError(
			`ChatGPT token request failed: ${code} (status ${response.status})`,
			code,
			TERMINAL_REFRESH_ERRORS.has(code),
		);
	}
	return text;
}

export async function refreshChatGptPlanTokens(
	params: { clientId: string; refreshToken: string },
	fetchImpl: typeof fetch = fetch,
): Promise<ChatGptPlanTokenResponse> {
	const text = await postForm(
		CHATGPT_TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: params.clientId,
			refresh_token: params.refreshToken,
			resource: CHATGPT_RESOURCE,
		},
		fetchImpl,
	);
	return JSON.parse(text) as ChatGptPlanTokenResponse;
}

export async function revokeChatGptPlanToken(
	params: { clientId: string; refreshToken: string },
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await postForm(
		CHATGPT_REVOKE_URL,
		{
			client_id: params.clientId,
			token: params.refreshToken,
			token_type_hint: "refresh_token",
		},
		fetchImpl,
	);
}

/** Accepts seconds, milliseconds or an ISO string; anything else is null. */
export function parseEarliestRefreshAt(raw: unknown): Date | null {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return new Date(raw < 1e12 ? raw * 1000 : raw);
	}
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		return Number.isNaN(parsed) ? null : new Date(parsed);
	}
	return null;
}

async function getJwksUri(fetchImpl: typeof fetch): Promise<string> {
	try {
		const response = await fetchImpl(
			`${CHATGPT_ISSUER}/.well-known/openid-configuration`,
		);
		if (response.ok) {
			const config = (await response.json()) as { jwks_uri?: string };
			if (config.jwks_uri) {
				return config.jwks_uri;
			}
		}
	} catch {}
	return CHATGPT_JWKS_URL;
}

export interface ChatGptIdTokenClaims {
	iss: string;
	aud: string | string[];
	sub: string;
	exp: number;
	iat: number;
	nonce?: string;
	email?: string;
}

function decodeSegment<T>(segment: string): T {
	return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

/**
 * Verifies an RS256 ID token against OpenAI's JWKS: signature, issuer,
 * audience (the issued client id) and expiry. The nonce is checked only when
 * given — the server never sees it, because the sign-in ran on the member's
 * machine, which checks it there.
 */
export async function verifyChatGptIdToken(
	idToken: string,
	expected: { clientId: string; nonce?: string },
	fetchImpl: typeof fetch = fetch,
): Promise<ChatGptIdTokenClaims> {
	const [headerPart, payloadPart, signaturePart] = idToken.split(".");
	if (!headerPart || !payloadPart || !signaturePart) {
		throw new Error("Malformed ID token");
	}
	const header = decodeSegment<{ alg: string; kid?: string }>(headerPart);
	if (header.alg !== "RS256") {
		throw new Error(`Unexpected ID token algorithm ${header.alg}`);
	}
	const jwksResponse = await fetchImpl(await getJwksUri(fetchImpl));
	if (!jwksResponse.ok) {
		throw new Error(
			`Could not load OpenAI signing keys (${jwksResponse.status})`,
		);
	}
	const jwks = (await jwksResponse.json()) as {
		keys: Array<JsonWebKey & { kid?: string }>;
	};
	const jwk = jwks.keys.find((key) => key.kid === header.kid);
	if (!jwk) {
		throw new Error("ID token signing key not found in JWKS");
	}
	const valid = verify(
		"RSA-SHA256",
		Buffer.from(`${headerPart}.${payloadPart}`),
		createPublicKey({ key: jwk, format: "jwk" }),
		Buffer.from(signaturePart, "base64url"),
	);
	if (!valid) {
		throw new Error("ID token signature is invalid");
	}
	const claims = decodeSegment<ChatGptIdTokenClaims>(payloadPart);
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!claims.sub || typeof claims.iat !== "number") {
		throw new Error("ID token is missing sub or iat");
	}
	if (claims.iss !== CHATGPT_ISSUER) {
		throw new Error("Unexpected ID token issuer");
	}
	if (!audiences.includes(expected.clientId)) {
		throw new Error(
			"ID token audience does not match the issued client ID",
		);
	}
	if (claims.exp + 5 < Math.floor(Date.now() / 1000)) {
		throw new Error("ID token is expired");
	}
	if (expected.nonce !== undefined && claims.nonce !== expected.nonce) {
		throw new Error("ID token nonce did not match");
	}
	return claims;
}
