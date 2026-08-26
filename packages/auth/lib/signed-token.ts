/**
 * HMAC-signed, self-describing tokens for short-lived security operations.
 *
 * Format: `base64url(json).base64url(hmac-sha256)` — a compact two-part
 * string. The first part is a base64url-encoded JSON body of the form
 * `{ p: <payload>, exp: <unix-seconds> }`. The second part is the
 * base64url-encoded HMAC-SHA256 of the *first part*, keyed on
 * `BETTER_AUTH_SECRET` (the secret Better Auth itself already requires).
 *
 * Threat model:
 *   - The signed payload includes its own expiry (`exp` lives *inside* the
 *     JSON that the HMAC covers), so an attacker cannot extend the lifetime
 *     of a token without also re-signing it. Putting `exp` in a query-string
 *     parameter alongside the token would defeat this.
 *   - Verification uses `crypto.timingSafeEqual` against a recomputed HMAC,
 *     so signature comparison is constant-time.
 *   - Tokens are not encrypted — they're signed. Do not put secrets in the
 *     payload; assume an attacker can read it. Use them to bind an action to
 *     a specific user/email/operation, not as a confidential channel.
 *   - Tokens are stateless: revocation has to be modelled by the caller
 *     (e.g. by binding the token to a record in the DB and invalidating that
 *     record on use). The primitive intentionally does not maintain a
 *     server-side state store.
 *
 * The 32-character minimum on `BETTER_AUTH_SECRET` is enforced at boot, so
 * sign/verify can assume the secret is present and adequately sized; if the
 * env var goes missing or is truncated the helpers throw rather than fall
 * back to a weaker key.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

function getSecret(): string {
	const s = process.env.BETTER_AUTH_SECRET;
	if (!s || s.length < 32) {
		throw new Error("BETTER_AUTH_SECRET missing or too short");
	}
	return s;
}

function b64urlEncode(buf: Buffer): string {
	return buf
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
	const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
	return Buffer.from(
		s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad),
		"base64",
	);
}

export interface SignOptions {
	ttlSec: number;
}

export function signToken<T>(payload: T, opts: SignOptions): string {
	const exp = Math.floor(Date.now() / 1000) + opts.ttlSec;
	const body = JSON.stringify({ p: payload, exp });
	const head = b64urlEncode(Buffer.from(body, "utf8"));
	const sig = createHmac("sha256", getSecret()).update(head).digest();
	return `${head}.${b64urlEncode(sig)}`;
}

export type VerifyResult<T> =
	| { ok: true; payload: T }
	| { ok: false; reason: "format" | "signature" | "expired" | "decode" };

export function verifyToken<T>(token: string): VerifyResult<T> {
	const parts = token.split(".");
	if (parts.length !== 2) {
		return { ok: false, reason: "format" };
	}
	const [head, sigB64] = parts;
	const expectedSig = createHmac("sha256", getSecret()).update(head).digest();
	const givenSig = b64urlDecode(sigB64);
	if (
		givenSig.length !== expectedSig.length ||
		!timingSafeEqual(givenSig, expectedSig)
	) {
		return { ok: false, reason: "signature" };
	}
	let body: { p: T; exp: number };
	try {
		body = JSON.parse(b64urlDecode(head).toString("utf8"));
	} catch {
		return { ok: false, reason: "decode" };
	}
	if (
		typeof body.exp !== "number" ||
		body.exp < Math.floor(Date.now() / 1000)
	) {
		return { ok: false, reason: "expired" };
	}
	return { ok: true, payload: body.p };
}
