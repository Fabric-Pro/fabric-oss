/**
 * Shared scaffolding for the live-room JWT route suites
 * (/api/orchestrator/verify, /api/task-agent/verify, /api/collab/verify).
 *
 * Every option here exists to produce a negative case the routes must refuse —
 * a different secret, a sibling audience, no audience at all, an already-expired
 * token, another HMAC algorithm — so keep the defaults matching what the token
 * routes actually mint.
 */

import { SignJWT } from "jose";

export type SignLiveTokenOptions = {
	secret: string;
	/** Omitted or null signs no `aud` claim, as the collab token route does. */
	audience?: string | null;
	/** Relative string ("10m") or an absolute epoch-seconds number. */
	expirationTime?: string | number;
	alg?: string;
};

export async function signLiveToken(
	claims: Record<string, unknown>,
	options: SignLiveTokenOptions,
): Promise<string> {
	const {
		secret,
		audience = null,
		expirationTime = "10m",
		alg = "HS256",
	} = options;

	let jwt = new SignJWT(claims)
		.setProtectedHeader({ alg })
		.setIssuedAt()
		.setExpirationTime(expirationTime);

	if (audience) {
		jwt = jwt.setAudience(audience);
	}

	return jwt.sign(new TextEncoder().encode(secret));
}

/**
 * Builds the request the party workers send: a JSON POST carrying the token in
 * an `Authorization: Bearer` header. A `string` body is sent verbatim so suites
 * can prove the JWT is checked before the body is ever parsed.
 */
export function bearerPost(
	url: string,
	token: string | null,
	body: unknown,
): Request {
	return new Request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}
