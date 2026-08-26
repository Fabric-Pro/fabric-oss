/**
 * Per-user unread-count cache backed by Upstash Redis.
 *
 * The unread count is hot — every active session polls it every 30 s and
 * the value barely changes between writes. A 5-second cache absorbs the
 * noise without making the badge feel stale; writes invalidate the key
 * so user-perceived freshness is unaffected.
 *
 * Falls back gracefully when Redis isn't configured: misses, sets, and
 * invalidations all become no-ops, and callers go straight to the DB.
 */

import { logger } from "@repo/logs";
import { Redis } from "@upstash/redis";

const TTL_SECONDS = 5;

let redisClient: Redis | null = null;
let initialized = false;

function getRedis(): Redis | null {
	if (initialized) {
		return redisClient;
	}
	initialized = true;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		return null;
	}
	try {
		redisClient = new Redis({ url, token });
		return redisClient;
	} catch (error) {
		logger.warn(
			{ err: error },
			"[notification-cache] Failed to init Upstash Redis; cache disabled",
		);
		return null;
	}
}

function key(userId: string, organizationId: string | null): string {
	return `notif:unread:${userId}:${organizationId ?? "_"}`;
}

export async function getCachedUnreadCount(
	userId: string,
	organizationId: string | null,
): Promise<number | null> {
	const redis = getRedis();
	if (!redis) {
		return null;
	}
	try {
		const value = await redis.get<number>(key(userId, organizationId));
		return typeof value === "number" ? value : null;
	} catch (error) {
		logger.warn(
			{ err: error },
			"[notification-cache] Redis GET failed; falling back to DB",
		);
		return null;
	}
}

export async function setCachedUnreadCount(
	userId: string,
	organizationId: string | null,
	count: number,
): Promise<void> {
	const redis = getRedis();
	if (!redis) {
		return;
	}
	try {
		await redis.set(key(userId, organizationId), count, {
			ex: TTL_SECONDS,
		});
	} catch (error) {
		logger.warn({ err: error }, "[notification-cache] Redis SET failed");
	}
}

export async function invalidateUnreadCount(
	userId: string,
	organizationId: string | null,
): Promise<void> {
	const redis = getRedis();
	if (!redis) {
		return;
	}
	try {
		await redis.del(key(userId, organizationId));
	} catch (error) {
		logger.warn({ err: error }, "[notification-cache] Redis DEL failed");
	}
}
