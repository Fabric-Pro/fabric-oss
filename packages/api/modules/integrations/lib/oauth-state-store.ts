/**
 * Single-use consumption of integration OAuth state nonces.
 *
 * `oauth-state.ts` signs a random nonce and a timestamp into the state so a
 * callback can prove the state was minted here and is younger than ten
 * minutes. It could not prove the state had not been presented BEFORE: nothing
 * remembered a nonce once it was verified, so within the window one signed
 * state redeemed as many authorization codes as an attacker could obtain for
 * it. This module is that memory.
 *
 * The store is the shared Upstash client that the rate limiter and the AI
 * usage counters already use, with `SET key NX EX ttl` doing the atomic
 * "first presenter wins" — a second `SET NX` on the same key returns null and
 * the callback refuses. The MCP OAuth flow keeps its state in a table
 * (`MCPOAuthState`) because its rows carry a config and server foreign key;
 * the integration flow keeps its payload in the signed token and only needs
 * the nonce remembered, so a Redis key with the state's own TTL is the whole
 * requirement and no new table is warranted.
 *
 * Fail-closed shape mirrors `lib/rate-limit.ts`: in production a missing or
 * failing Redis is a refusal, never a pass, because "unavailable" is exactly
 * when a replay would otherwise go unnoticed. Outside production the in-memory
 * map keeps a fresh checkout working unconfigured; it is per-process, which
 * is correct for a single dev server and would not be for a fleet, which is
 * why production does not get it.
 */

import { logger } from "@repo/logs";
import { getRedisClient } from "../../../lib/redis-client";
import { STATE_MAX_AGE_MS } from "./oauth-state";

export type OAuthStateConsumeResult =
	/** First presentation of this nonce: the callback may proceed. */
	| "consumed"
	/** The nonce was already presented within its TTL: refuse. */
	| "replayed"
	/** The store could not answer and this environment does not fall back. */
	| "unavailable";

const KEY_PREFIX = "fabric:integrations:oauth-state:";

/**
 * Slack added to the signed state's own TTL so a nonce that `decodeOAuthState`
 * would still accept is guaranteed to still be remembered here. The state
 * check compares against the mint timestamp; the key's TTL starts at first
 * presentation, so the key always outlives the state.
 */
const TTL_SLACK_MS = 60 * 1000;

const inMemoryStore = new Map<string, number>();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startInMemoryCleanup(): void {
	if (cleanupInterval) {
		return;
	}
	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, expiresAt] of inMemoryStore) {
			if (expiresAt <= now) {
				inMemoryStore.delete(key);
			}
		}
	}, 60_000);
	cleanupInterval.unref?.();
}

function consumeInMemory(key: string, ttlMs: number): OAuthStateConsumeResult {
	startInMemoryCleanup();
	const now = Date.now();
	const existing = inMemoryStore.get(key);
	if (existing !== undefined && existing > now) {
		return "replayed";
	}
	inMemoryStore.set(key, now + ttlMs);
	return "consumed";
}

function isProduction(): boolean {
	return process.env.NODE_ENV === "production";
}

/**
 * Mark `nonce` as presented, atomically, and report whether this was its
 * first presentation. Call it once per callback, AFTER the signature and age
 * checks (an unsigned or expired state must not occupy a key) and BEFORE the
 * authorization-code exchange (the first side effect).
 */
export async function consumeOAuthStateNonce(
	nonce: string,
	ttlMs: number = STATE_MAX_AGE_MS,
): Promise<OAuthStateConsumeResult> {
	if (!nonce) {
		// A state without a nonce predates the nonce field or was forged; the
		// signature check upstream should have refused it. Never let an empty
		// key act as a shared "already used" slot for every such state.
		return "unavailable";
	}

	const key = `${KEY_PREFIX}${nonce}`;
	const effectiveTtlMs = ttlMs + TTL_SLACK_MS;
	const redis = getRedisClient();

	if (!redis) {
		if (isProduction()) {
			logger.error(
				{
					event: "integrations.oauth-state.store.unavailable",
					reason: "no-client",
				},
				"OAuth state store unavailable in production — failing closed",
			);
			return "unavailable";
		}
		return consumeInMemory(key, effectiveTtlMs);
	}

	try {
		const result = await redis.set(key, "1", {
			nx: true,
			ex: Math.ceil(effectiveTtlMs / 1000),
		});
		return result === null ? "replayed" : "consumed";
	} catch (error) {
		if (isProduction()) {
			logger.error(
				{
					event: "integrations.oauth-state.store.unavailable",
					error: String(error),
				},
				"OAuth state store unavailable in production — failing closed",
			);
			return "unavailable";
		}
		logger.warn(
			{
				event: "integrations.oauth-state.store.fallback",
				error: String(error),
			},
			"OAuth state store error outside production — using in-memory store",
		);
		return consumeInMemory(key, effectiveTtlMs);
	}
}

/**
 * Test-only: forget every in-memory nonce so suites do not see each other's
 * consumptions. Production code must never call this.
 * @internal
 */
export function __resetInMemoryOAuthStateStoreForTests(): void {
	inMemoryStore.clear();
}
