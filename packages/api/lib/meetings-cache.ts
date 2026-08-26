/**
 * Per-user cache of the AI Updates "list calendar meetings" result, backed by
 * Upstash Redis.
 *
 * The meetings dropdown in the AI Updates source selector calls Microsoft Graph
 * (`/me/calendarView`, paginated across many pages) on every open. The result
 * barely changes minute to minute, so a short 60-second cache turns repeated and
 * cold opens into instant reads while keeping the list fresh enough. A manual
 * Refresh in the UI bypasses this cache via the procedure's `forceRefresh` flag.
 *
 * Falls back gracefully when Redis isn't configured: gets and sets become
 * no-ops and callers go straight to Microsoft Graph (today's behavior).
 *
 * Keyed PER USER (the calendar belongs to the signed-in user) so cached results
 * are never shared across users — no cross-tenant leakage.
 */

import { logger } from "@repo/logs";
import { Redis } from "@upstash/redis";

const TTL_SECONDS = 60;

export interface CachedMeeting {
	id: string;
	subject: string;
	startTime?: string | null;
	organizer: string;
	joinUrl: string | null;
}

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
			"[meetings-cache] Failed to init Upstash Redis; cache disabled",
		);
		return null;
	}
}

function key(
	userId: string,
	organizationId: string | null,
	daysBack: number,
): string {
	return `backlog:meetings:${userId}:${organizationId ?? "_"}:${daysBack}`;
}

export async function getCachedMeetings(
	userId: string,
	organizationId: string | null,
	daysBack: number,
): Promise<CachedMeeting[] | null> {
	const redis = getRedis();
	if (!redis) {
		return null;
	}
	try {
		const value = await redis.get<CachedMeeting[]>(
			key(userId, organizationId, daysBack),
		);
		return Array.isArray(value) ? value : null;
	} catch (error) {
		logger.warn(
			{ err: error },
			"[meetings-cache] Redis GET failed; falling back to Microsoft Graph",
		);
		return null;
	}
}

export async function setCachedMeetings(
	userId: string,
	organizationId: string | null,
	daysBack: number,
	meetings: CachedMeeting[],
): Promise<void> {
	const redis = getRedis();
	if (!redis) {
		return;
	}
	try {
		await redis.set(key(userId, organizationId, daysBack), meetings, {
			ex: TTL_SECONDS,
		});
	} catch (error) {
		logger.warn({ err: error }, "[meetings-cache] Redis SET failed");
	}
}
