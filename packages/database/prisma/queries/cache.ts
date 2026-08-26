/**
 * Simple TTL Cache for Database Queries
 *
 * Used for caching static data that rarely changes (e.g., AI model catalog).
 * This reduces database load for frequently accessed, rarely modified data.
 *
 * See: server-cache-lru rule from Vercel React Best Practices
 */

interface CacheEntry {
	data: unknown;
	expiresAt: number;
}

/**
 * Simple in-memory cache with TTL support.
 * Uses generic methods for type-safe retrieval while storing heterogeneous data.
 */
class TTLCache {
	private cache = new Map<string, CacheEntry>();
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor(private defaultTtlMs: number = 60 * 60 * 1000) {
		// Default TTL: 1 hour
	}

	/**
	 * Get a value from cache if it exists and is not expired
	 */
	get<T>(key: string): T | null {
		const entry = this.cache.get(key);
		if (!entry) {
			return null;
		}

		if (Date.now() >= entry.expiresAt) {
			this.cache.delete(key);
			return null;
		}

		return entry.data as T;
	}

	/**
	 * Set a value in cache with optional custom TTL
	 */
	set<T>(key: string, data: T, ttlMs?: number): void {
		const ttl = ttlMs ?? this.defaultTtlMs;
		this.cache.set(key, {
			data,
			expiresAt: Date.now() + ttl,
		});
	}

	/**
	 * Delete a specific key from cache
	 */
	delete(key: string): void {
		this.cache.delete(key);
	}

	/**
	 * Clear all entries from cache
	 */
	clear(): void {
		this.cache.clear();
	}

	/**
	 * Get or set a value - fetch from cache or compute and cache.
	 * Type is inferred from the fetcher function return type.
	 */
	async getOrSet<T>(
		key: string,
		fetcher: () => Promise<T>,
		ttlMs?: number,
	): Promise<T> {
		const cached = this.get<T>(key);
		if (cached !== null) {
			return cached;
		}

		const data = await fetcher();
		this.set(key, data, ttlMs);
		return data;
	}

	/**
	 * Get cache statistics
	 */
	getStats(): { size: number; validEntries: number } {
		const now = Date.now();
		let validEntries = 0;

		for (const entry of this.cache.values()) {
			if (now < entry.expiresAt) {
				validEntries++;
			}
		}

		return { size: this.cache.size, validEntries };
	}

	/**
	 * Clean up expired entries
	 */
	cleanup(): number {
		const now = Date.now();
		let cleaned = 0;

		for (const [key, entry] of this.cache.entries()) {
			if (now >= entry.expiresAt) {
				this.cache.delete(key);
				cleaned++;
			}
		}

		return cleaned;
	}

	/**
	 * Start automatic cleanup interval
	 */
	startCleanup(intervalMs = 60000): void {
		if (this.cleanupInterval) {
			return;
		}

		this.cleanupInterval = setInterval(() => {
			this.cleanup();
		}, intervalMs);

		// Don't prevent Node.js from exiting
		if (this.cleanupInterval.unref) {
			this.cleanupInterval.unref();
		}
	}

	/**
	 * Stop automatic cleanup
	 */
	stopCleanup(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
	}
}

// Cache for AI model catalog queries (1 hour TTL)
export const aiModelCatalogCache = new TTLCache(60 * 60 * 1000);

// Cache for AI task defaults (1 hour TTL)
export const aiTaskDefaultsCache = new TTLCache(60 * 60 * 1000);
