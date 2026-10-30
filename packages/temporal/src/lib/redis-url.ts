/**
 * Where the worker's ioredis clients connect, and whether they may.
 *
 * Shared by the execution-event publisher (`redis-publisher.ts`) and the
 * durable AG-UI run stream (`agui-run-stream.ts`), which the web app reads
 * through the same Redis.
 */

/**
 * Build a Redis URL from environment variables.
 * Prefers Aspire-injected CACHE_HOST/CACHE_PORT (dynamic port) over static
 * REDIS_URL which may reference a stale port after container restarts.
 */
export function getRedisUrl(): string | null {
	// Prefer Aspire-injected vars (dynamic port assigned at container start)
	const cacheHost = process.env.CACHE_HOST;
	if (cacheHost) {
		const cachePort = process.env.CACHE_PORT || "6379";
		const password =
			process.env.CACHE_PASSWORD || process.env.REDIS_PASSWORD;
		if (password) {
			return `redis://:${encodeURIComponent(password)}@${cacheHost}:${cachePort}`;
		}
		return `redis://${cacheHost}:${cachePort}`;
	}

	const rawUrl = process.env.REDIS_URL;
	if (rawUrl) {
		try {
			const parsed = new URL(rawUrl);
			if (parsed.password) {
				return rawUrl;
			}
			const password =
				process.env.REDIS_PASSWORD || process.env.CACHE_PASSWORD;
			if (password) {
				parsed.password = password;
				return parsed.toString();
			}
			return rawUrl;
		} catch {
			return rawUrl;
		}
	}

	return null;
}

/**
 * Transport fail-closed (SOC 2 CC6.7): plaintext `redis://` is refused in
 * production — mirrors the Postgres/Temporal TLS guards. Real prod uses
 * `rediss://` (TLS), so this only trips on misconfiguration; escape hatch
 * `FABRIC_ALLOW_INSECURE_REDIS=true`. Local dev (non-production) is exempt.
 */
export function isPlaintextRedisRefused(redisUrl: string): boolean {
	return (
		process.env.NODE_ENV === "production" &&
		redisUrl.startsWith("redis://") &&
		process.env.FABRIC_ALLOW_INSECURE_REDIS !== "true"
	);
}
