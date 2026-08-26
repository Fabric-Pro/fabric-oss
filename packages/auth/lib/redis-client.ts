import { Redis } from "@upstash/redis";

let client: Redis | null = null;
let unavailable = false;

/**
 * Singleton Upstash Redis client for the auth package.
 * Returns null in dev when creds are missing.
 */
export function getAuthRedisClient(): Redis | null {
	if (unavailable) {
		return null;
	}
	if (client) {
		return client;
	}

	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		unavailable = true;
		return null;
	}

	try {
		client = new Redis({ url, token });
		return client;
	} catch {
		unavailable = true;
		return null;
	}
}
