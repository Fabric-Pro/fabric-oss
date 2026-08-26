/**
 * Tests for Rate Limiting functionality
 * Covers both in-memory and Redis-based rate limiting
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Redis/Upstash - not available in test environment
vi.mock("@upstash/ratelimit", () => ({
	Ratelimit: vi.fn().mockImplementation(() => ({
		limit: vi.fn().mockResolvedValue({
			success: true,
			remaining: 99,
			reset: Date.now() + 60000,
		}),
	})),
}));

vi.mock("@upstash/redis", () => ({
	Redis: vi.fn().mockImplementation(() => ({
		keys: vi.fn().mockResolvedValue([]),
		del: vi.fn().mockResolvedValue(1),
	})),
}));

describe("Rate Limiting", () => {
	beforeEach(() => {
		vi.resetModules();
		// Clear environment variables
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;
	});

	describe("In-Memory Rate Limiting", () => {
		it("should allow requests within limit", async () => {
			const { checkRateLimitSync } = await import(
				"@repo/api/lib/rate-limit"
			);

			const result = checkRateLimitSync("test-key-1", 10, 60000);

			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(9);
		});

		it("should block requests exceeding limit", async () => {
			const { checkRateLimitSync } = await import(
				"@repo/api/lib/rate-limit"
			);

			// Make 11 requests (limit is 10)
			for (let i = 0; i < 10; i++) {
				checkRateLimitSync("test-key-2", 10, 60000);
			}

			const result = checkRateLimitSync("test-key-2", 10, 60000);

			expect(result.allowed).toBe(false);
			expect(result.remaining).toBe(0);
		});

		it("should track remaining requests correctly", async () => {
			const { checkRateLimitSync } = await import(
				"@repo/api/lib/rate-limit"
			);

			const limit = 5;
			const results: number[] = [];

			for (let i = 0; i < 5; i++) {
				const result = checkRateLimitSync("test-key-3", limit, 60000);
				results.push(result.remaining);
			}

			expect(results).toEqual([4, 3, 2, 1, 0]);
		});

		it("should use different counters for different keys", async () => {
			const { checkRateLimitSync } = await import(
				"@repo/api/lib/rate-limit"
			);

			const result1 = checkRateLimitSync("user:123", 10, 60000);
			const result2 = checkRateLimitSync("user:456", 10, 60000);

			expect(result1.remaining).toBe(9);
			expect(result2.remaining).toBe(9);
		});

		it("should provide reset time in seconds", async () => {
			const { checkRateLimitSync } = await import(
				"@repo/api/lib/rate-limit"
			);

			const result = checkRateLimitSync("test-key-4", 10, 60000);

			expect(result.resetInSeconds).toBeGreaterThan(0);
			expect(result.resetInSeconds).toBeLessThanOrEqual(60);
		});
	});

	describe("Rate Limit Presets", () => {
		it("should have standard preset with 100 requests/minute", async () => {
			const { RATE_LIMIT_PRESETS } = await import(
				"@repo/api/lib/rate-limit"
			);

			expect(RATE_LIMIT_PRESETS.standard.limit).toBe(100);
			expect(RATE_LIMIT_PRESETS.standard.windowMs).toBe(60000);
		});

		it("should have strict preset with 10 requests/minute", async () => {
			const { RATE_LIMIT_PRESETS } = await import(
				"@repo/api/lib/rate-limit"
			);

			expect(RATE_LIMIT_PRESETS.strict.limit).toBe(10);
		});

		it("should have auth preset with 5 requests/minute", async () => {
			const { RATE_LIMIT_PRESETS } = await import(
				"@repo/api/lib/rate-limit"
			);

			expect(RATE_LIMIT_PRESETS.auth.limit).toBe(5);
		});

		it("should have AI preset with 20 requests/minute", async () => {
			const { RATE_LIMIT_PRESETS } = await import(
				"@repo/api/lib/rate-limit"
			);

			expect(RATE_LIMIT_PRESETS.ai.limit).toBe(20);
		});

		it("should have agent preset with 20 requests/minute", async () => {
			const { RATE_LIMIT_PRESETS } = await import(
				"@repo/api/lib/rate-limit"
			);

			expect(RATE_LIMIT_PRESETS.agent.limit).toBe(20);
		});

		it("should have workflow preset with 30 requests/minute", async () => {
			const { RATE_LIMIT_PRESETS } = await import(
				"@repo/api/lib/rate-limit"
			);

			expect(RATE_LIMIT_PRESETS.workflow.limit).toBe(30);
		});

		it("should have webhook preset with 60 requests/minute", async () => {
			const { RATE_LIMIT_PRESETS } = await import(
				"@repo/api/lib/rate-limit"
			);

			expect(RATE_LIMIT_PRESETS.webhook.limit).toBe(60);
		});
	});

	describe("Rate Limit Stats", () => {
		it("should report backend type", async () => {
			const { getRateLimitStats } = await import(
				"@repo/api/lib/rate-limit"
			);

			const stats = getRateLimitStats();

			expect(stats.backend).toBe("memory");
			expect(stats.redisAvailable).toBe(false);
		});

		it("should track memory entries", async () => {
			const { checkRateLimitSync, getRateLimitStats } = await import(
				"@repo/api/lib/rate-limit"
			);

			// Make some requests to create entries
			checkRateLimitSync("stats-test-1", 10, 60000);
			checkRateLimitSync("stats-test-2", 10, 60000);

			const stats = getRateLimitStats();

			expect(stats.memoryEntries).toBeGreaterThan(0);
		});
	});

	describe("Clear Rate Limit", () => {
		it("should clear rate limit for a key", async () => {
			const { checkRateLimitSync, clearRateLimit } = await import(
				"@repo/api/lib/rate-limit"
			);

			// Make several requests
			for (let i = 0; i < 8; i++) {
				checkRateLimitSync("clear-test", 10, 60000);
			}

			// Clear and verify
			await clearRateLimit("clear-test");

			// New request should have full limit
			const result = checkRateLimitSync("clear-test", 10, 60000);
			expect(result.remaining).toBe(9);
		});
	});
});
