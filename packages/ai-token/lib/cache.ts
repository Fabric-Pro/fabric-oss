/**
 * AI Token Cache
 *
 * In-memory cache for exchanged API keys with TTL.
 * Reduces round-trips to the exchange endpoint.
 */

import type { CachedKeyEntry, ExchangeResult } from "./types";

/**
 * In-memory cache for exchanged API keys
 * Key: token hash (we don't store actual tokens)
 * Value: cached result with expiry
 */
const cache = new Map<string, CachedKeyEntry>();

/**
 * Cleanup interval ID for garbage collection
 */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Hash a token for use as cache key
 * We hash tokens to avoid storing them in memory
 */
async function hashToken(token: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Get a cached key entry if it exists and is not expired
 *
 * @param token - The AI token
 * @returns Cached result or null if not found/expired
 */
export async function getCachedKey(
	token: string,
): Promise<ExchangeResult | null> {
	const key = await hashToken(token);
	const entry = cache.get(key);

	if (!entry) {
		return null;
	}

	// Check if expired
	if (Date.now() >= entry.expiresAt) {
		cache.delete(key);
		return null;
	}

	// Update expiresIn to reflect remaining time
	const remainingMs = entry.expiresAt - Date.now();
	return {
		...entry.result,
		expiresIn: Math.floor(remainingMs / 1000),
	};
}

/**
 * Cache an exchanged key result
 *
 * @param token - The AI token (will be hashed)
 * @param result - The exchange result to cache
 * @param ttlSeconds - Time to live in seconds (defaults to result.expiresIn)
 */
export async function setCachedKey(
	token: string,
	result: ExchangeResult,
	ttlSeconds?: number,
): Promise<void> {
	const key = await hashToken(token);
	const ttl = ttlSeconds ?? result.expiresIn;

	// Apply a safety margin of 30 seconds to account for clock skew
	// and network latency
	const safetyMarginSeconds = 30;
	const effectiveTtl = Math.max(0, ttl - safetyMarginSeconds);

	if (effectiveTtl <= 0) {
		// Don't cache if TTL is too short
		return;
	}

	const entry: CachedKeyEntry = {
		result,
		expiresAt: Date.now() + effectiveTtl * 1000,
	};

	cache.set(key, entry);
}

/**
 * Clear a specific cached entry
 *
 * @param token - The AI token to clear from cache
 */
export async function clearCachedKey(token: string): Promise<void> {
	const key = await hashToken(token);
	cache.delete(key);
}

/**
 * Clear all cached entries
 */
export function clearAllCachedKeys(): void {
	cache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; validEntries: number } {
	const now = Date.now();
	let validEntries = 0;

	for (const entry of cache.values()) {
		if (now < entry.expiresAt) {
			validEntries++;
		}
	}

	return {
		size: cache.size,
		validEntries,
	};
}

/**
 * Clean up expired entries from cache
 * Called periodically to prevent memory leaks
 */
export function cleanupExpiredEntries(): number {
	const now = Date.now();
	let cleaned = 0;

	for (const [key, entry] of cache.entries()) {
		if (now >= entry.expiresAt) {
			cache.delete(key);
			cleaned++;
		}
	}

	return cleaned;
}

/**
 * Start automatic cleanup of expired entries
 * Default interval is 60 seconds
 *
 * @param intervalMs - Cleanup interval in milliseconds
 */
export function startCacheCleanup(intervalMs = 60000): void {
	if (cleanupInterval) {
		return; // Already running
	}

	cleanupInterval = setInterval(() => {
		const cleaned = cleanupExpiredEntries();
		if (cleaned > 0) {
			console.debug(
				`[AI Token Cache] Cleaned ${cleaned} expired entries`,
			);
		}
	}, intervalMs);

	// Don't prevent Node.js from exiting
	if (cleanupInterval.unref) {
		cleanupInterval.unref();
	}
}

/**
 * Stop automatic cleanup
 */
export function stopCacheCleanup(): void {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
}
