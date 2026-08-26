/**
 * Server-side revocation for Better Auth's stateless email-change JWTs.
 *
 * Better Auth 1.4.9 issues two JWTs during a change-email flow, both with
 * payload `{email: OLD, updateTo: NEW}` and differing only in `requestType`:
 *   1. `change-email-confirmation` — sent to OLD address; click spawns JWT 2
 *   2. `change-email-verification` — sent to NEW address; click commits the
 *      email update and creates a fresh session
 *
 * We never see JWT 2 (Better Auth mints it server-side on JWT 1 click), so
 * blocklisting JWT 1 alone leaves JWT 2 valid in the new-address inbox. The
 * tuple-based `markEmailChangeRevoked(old, new)` covers both, since the
 * before-hook decodes the verify-email JWT and matches against the tuple.
 *
 * Two layers, both stored as SHA-256 digests so a Redis dump leaks neither
 * tokens nor email pairs:
 *   - `blockEmailVerifyJWT(jwt)` — exact-token check (defense-in-depth)
 *   - `markEmailChangeRevoked(oldEmail, newEmail)` — tuple check (covers
 *     JWT 2 which we don't have a hash for)
 *
 * TTL is 2 h, comfortably beyond Better Auth's default 1 h JWT expiry.
 *
 * Read paths fail open: if Redis is unavailable when checking the markers,
 * the verify-email request is allowed to proceed. The blast radius is bounded
 * by the JWT expiry, and breaking all email verification when Redis is down
 * is worse than briefly accepting verifications during an outage.
 *
 * Write paths fail closed: `markEmailChangeRevoked` throws if the marker
 * cannot be persisted. The revoke handler must not return success when the
 * primary control against JWT 2 (which we never see) was not actually
 * recorded — that would lie to the user about whether the takeover was
 * stopped.
 */

import { createHash } from "node:crypto";
import { logger } from "@repo/logs";
import { getAuthRedisClient } from "./redis-client";

const JWT_KEY_PREFIX = "email-verify-block:";
const TUPLE_KEY_PREFIX = "email-change-revoked:";
const TTL_SEC = 7200;

function jwtKey(jwt: string): string {
	return JWT_KEY_PREFIX + createHash("sha256").update(jwt).digest("hex");
}

// Both JWT 1 (change-email-confirmation) and JWT 2 (change-email-verification)
// in Better Auth 1.4.9 carry the same `{email: OLD, updateTo: NEW}` payload —
// only `requestType` differs. A single tuple marker covers both, including
// JWT 2 which we never see directly (Better Auth mints it on JWT 1 click).
function tupleKey(oldEmail: string, newEmail: string): string {
	const normalized = `${oldEmail.trim().toLowerCase()}|${newEmail.trim().toLowerCase()}`;
	return (
		TUPLE_KEY_PREFIX + createHash("sha256").update(normalized).digest("hex")
	);
}

export async function blockEmailVerifyJWT(jwt: string): Promise<void> {
	const redis = getAuthRedisClient();
	if (!redis) {
		return;
	}
	try {
		await redis.set(jwtKey(jwt), 1, { ex: TTL_SEC });
	} catch (err) {
		logger.warn({ event: "email_verify_blocklist.write_error", err });
	}
}

export async function isEmailVerifyJWTBlocked(jwt: string): Promise<boolean> {
	const redis = getAuthRedisClient();
	if (!redis) {
		return false;
	}
	try {
		const hit = await redis.get(jwtKey(jwt));
		return hit !== null;
	} catch (err) {
		logger.warn({ event: "email_verify_blocklist.read_error", err });
		return false;
	}
}

export async function markEmailChangeRevoked(
	oldEmail: string,
	newEmail: string,
): Promise<void> {
	const redis = getAuthRedisClient();
	if (!redis) {
		throw new Error(
			"Email-change revocation requires Redis; UPSTASH_REDIS_REST_URL/TOKEN are not configured",
		);
	}
	try {
		await redis.set(tupleKey(oldEmail, newEmail), 1, { ex: TTL_SEC });
	} catch (err) {
		logger.error({ event: "email_change_revoked.write_error", err });
		throw err;
	}
}

export async function isEmailChangeRevoked(
	email: string,
	updateTo: string,
): Promise<boolean> {
	const redis = getAuthRedisClient();
	if (!redis) {
		return false;
	}
	try {
		const hit = await redis.get(tupleKey(email, updateTo));
		return hit !== null;
	} catch (err) {
		logger.warn({ event: "email_change_revoked.read_error", err });
		return false;
	}
}
