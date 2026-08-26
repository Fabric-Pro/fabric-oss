/**
 * Unit tests for rate-limit fail-closed behavior in production.
 *
 * Verifies that:
 * 1. When Redis throws in production, checkRateLimit returns { allowed: false, statusCode: 503, reason: "ratelimit-unavailable" }
 * 2. When no limiter is available (missing creds) in production, same fail-closed result
 * 3. In development/test, Redis errors fall back to the in-memory store (allow first request)
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/auth/lib/boot-validate", () => ({
	validateRateLimitBootEnv: vi.fn(),
}));

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: vi.fn(() => "unknown"),
}));

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
	vi.restoreAllMocks();
	vi.resetModules();
});

describe("rate-limit fail-closed in production", () => {
	it("returns 503 statusCode when Redis throws in production", async () => {
		process.env = {
			...originalEnv,
			NODE_ENV: "production",
			UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
			UPSTASH_REDIS_REST_TOKEN: "tok",
		};
		vi.doMock("@upstash/ratelimit", () => ({
			Ratelimit: class {
				static slidingWindow() {
					return {};
				}
				async limit(): Promise<never> {
					throw new Error("redis-down");
				}
			},
		}));
		vi.doMock("@upstash/redis", () => ({
			Redis: class {
				/* stub */
			},
		}));

		const { checkRateLimit } = await import("../rate-limit");
		const { logger } = await import("@repo/logs");

		const res = await checkRateLimit("test:prod:k", 10, 60_000);
		expect(res.allowed).toBe(false);
		expect(res.statusCode).toBe(503);
		expect(res.reason).toBe("ratelimit-unavailable");
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "ratelimit.redis.unavailable" }),
			expect.any(String),
		);
	});

	it("falls back to in-memory in development when Redis throws", async () => {
		process.env = {
			...originalEnv,
			NODE_ENV: "development",
			UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
			UPSTASH_REDIS_REST_TOKEN: "tok",
		};
		vi.doMock("@upstash/ratelimit", () => ({
			Ratelimit: class {
				static slidingWindow() {
					return {};
				}
				async limit(): Promise<never> {
					throw new Error("redis-down");
				}
			},
		}));
		vi.doMock("@upstash/redis", () => ({
			Redis: class {
				/* stub */
			},
		}));

		const { checkRateLimit } = await import("../rate-limit");
		const res = await checkRateLimit("test:dev:k", 10, 60_000);
		// In-memory fallback should allow the first request
		expect(res.allowed).toBe(true);
		expect(res.statusCode).toBeUndefined();
		expect(res.reason).toBeUndefined();
	});

	it("returns 503 when no limiter available in production (missing creds)", async () => {
		process.env = {
			...originalEnv,
			NODE_ENV: "production",
			// Missing UPSTASH creds — boot guard is mocked to no-op
			UPSTASH_REDIS_REST_URL: undefined,
			UPSTASH_REDIS_REST_TOKEN: undefined,
		};
		vi.doMock("@upstash/redis", () => ({
			Redis: class {
				/* unused */
			},
		}));
		vi.doMock("@upstash/ratelimit", () => ({
			Ratelimit: class {
				static slidingWindow() {
					return {};
				}
				async limit() {
					return {
						success: true,
						remaining: 10,
						reset: Date.now() + 60_000,
					};
				}
			},
		}));

		const { checkRateLimit } = await import("../rate-limit");
		const { logger } = await import("@repo/logs");

		const res = await checkRateLimit("test:prod:k2", 10, 60_000);
		expect(res.allowed).toBe(false);
		expect(res.statusCode).toBe(503);
		expect(res.reason).toBe("ratelimit-unavailable");
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "ratelimit.redis.unavailable" }),
			expect.any(String),
		);
	});

	it("falls back to in-memory in development when creds missing", async () => {
		process.env = {
			...originalEnv,
			NODE_ENV: "development",
			UPSTASH_REDIS_REST_URL: undefined,
			UPSTASH_REDIS_REST_TOKEN: undefined,
		};
		vi.doMock("@upstash/redis", () => ({
			Redis: class {
				/* unused */
			},
		}));
		vi.doMock("@upstash/ratelimit", () => ({
			Ratelimit: class {
				static slidingWindow() {
					return {};
				}
				async limit() {
					return {
						success: true,
						remaining: 10,
						reset: Date.now() + 60_000,
					};
				}
			},
		}));

		const { checkRateLimit } = await import("../rate-limit");
		const res = await checkRateLimit("test:dev:k2", 10, 60_000);
		// In-memory fallback should allow the first request
		expect(res.allowed).toBe(true);
		expect(res.statusCode).toBeUndefined();
	});
});
