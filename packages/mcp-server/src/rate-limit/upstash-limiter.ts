/**
 * Upstash Rate Limiter
 *
 * Rate limiting using Upstash Redis with sliding window algorithm.
 * Limit: 100 requests per user per minute.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const REQUESTS_PER_MINUTE = 100;

export interface RateLimitResult {
	success: boolean;
	limit: number;
	remaining: number;
	reset: number;
}

export class McpRateLimiter {
	private ratelimit: Ratelimit;

	constructor(redis?: Redis) {
		const redisInstance = redis ?? Redis.fromEnv();
		this.ratelimit = new Ratelimit({
			redis: redisInstance,
			limiter: Ratelimit.slidingWindow(REQUESTS_PER_MINUTE, "1 m"),
			prefix: "fabric-mcp-ratelimit",
			analytics: true,
		});
	}

	/**
	 * Check rate limit for a user
	 * @param userId User ID to check rate limit for
	 * @returns Rate limit result with success status and metadata
	 */
	async check(userId: string): Promise<RateLimitResult> {
		const result = await this.ratelimit.limit(`user:${userId}`);
		return {
			success: result.success,
			limit: result.limit,
			remaining: result.remaining,
			reset: result.reset,
		};
	}

	/**
	 * Get remaining requests for a user without consuming a request
	 */
	async getRemaining(userId: string): Promise<number> {
		const result = await this.ratelimit.getRemaining(`user:${userId}`);
		return result.remaining;
	}
}

// Singleton instance
let defaultLimiter: McpRateLimiter | null = null;

export function getRateLimiter(): McpRateLimiter {
	if (!defaultLimiter) {
		defaultLimiter = new McpRateLimiter();
	}
	return defaultLimiter;
}

/**
 * Rate limit error for JSON-RPC response
 */
export class RateLimitError extends Error {
	code = -32000;
	data: {
		limit: number;
		remaining: number;
		resetAt: number;
	};

	constructor(result: RateLimitResult) {
		super(
			`Rate limit exceeded. Limit: ${result.limit}/minute. Resets at: ${new Date(result.reset).toISOString()}`,
		);
		this.name = "RateLimitError";
		this.data = {
			limit: result.limit,
			remaining: result.remaining,
			resetAt: result.reset,
		};
	}
}
