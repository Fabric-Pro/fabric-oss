/**
 * Unit tests for the auth rate limiting middleware.
 *
 * Tests endpoint-specific rate limits, 429 responses, header correctness,
 * non-auth route isolation, and distinct Redis keys per endpoint.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock checkRateLimit from the rate-limit module
const mockCheckRateLimit = vi.fn();
vi.mock("../rate-limit", () => ({
	checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// Mock @repo/logs logger
vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	},
}));

import { AUTH_RATE_LIMITS, authRateLimitMiddleware } from "../auth-rate-limit";

/**
 * Helper: creates a minimal Hono app with the auth rate limit middleware
 * and a catch-all handler so non-blocked requests get a 200.
 */
function createTestApp() {
	const app = new Hono();

	// Apply auth rate limit middleware to all auth routes
	app.use("/api/auth/*", authRateLimitMiddleware());

	// Catch-all downstream handler for auth routes
	app.all("/api/auth/*", (c) => c.json({ ok: true }, 200));

	// Non-auth route
	app.get("/api/projects", (c) => c.json({ projects: [] }, 200));

	return app;
}

function makeRequest(
	app: Hono,
	path: string,
	options?: { method?: string; ip?: string },
) {
	const method = options?.method ?? "POST";
	const ip = options?.ip ?? "192.168.1.1";
	return app.request(path, {
		method,
		// Use a platform-trusted header so getTrustedClientIp returns the
		// supplied IP directly. Single-hop x-forwarded-for is treated as
		// untrusted by default (TRUSTED_PROXY_HOP_COUNT=1) and would fall
		// back to the user-agent fingerprint, collapsing per-IP buckets.
		headers: {
			"x-vercel-forwarded-for": ip,
		},
	});
}

describe("authRateLimitMiddleware", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Default: allow all requests with standard remaining/reset values
		mockCheckRateLimit.mockResolvedValue({
			allowed: true,
			remaining: 5,
			resetInSeconds: 30,
		});
	});

	// ---------------------------------------------------------------
	// Test 1: applies correct limit per endpoint
	// ---------------------------------------------------------------
	describe("applies correct limit per endpoint", () => {
		it("sign-in uses limit 20 per 60s", async () => {
			const app = createTestApp();
			await makeRequest(app, "/api/auth/sign-in/email");

			expect(mockCheckRateLimit).toHaveBeenCalledWith(
				expect.stringContaining("auth:signin:"),
				20,
				60_000,
			);
		});

		it("sign-up uses limit 20 per 60s", async () => {
			const app = createTestApp();
			await makeRequest(app, "/api/auth/sign-up/email");

			expect(mockCheckRateLimit).toHaveBeenCalledWith(
				expect.stringContaining("auth:signup:"),
				20,
				60_000,
			);
		});

		it("request-password-reset uses limit 20 per 60s", async () => {
			const app = createTestApp();
			await makeRequest(app, "/api/auth/request-password-reset");

			expect(mockCheckRateLimit).toHaveBeenCalledWith(
				expect.stringContaining("auth:forgot:"),
				20,
				60_000,
			);
		});

		it("magic-link uses limit 20 per 60s", async () => {
			const app = createTestApp();
			await makeRequest(app, "/api/auth/magic-link");

			expect(mockCheckRateLimit).toHaveBeenCalledWith(
				expect.stringContaining("auth:magic:"),
				20,
				60_000,
			);
		});

		it("two-factor uses limit 20 per 60s", async () => {
			const app = createTestApp();
			await makeRequest(app, "/api/auth/two-factor");

			expect(mockCheckRateLimit).toHaveBeenCalledWith(
				expect.stringContaining("auth:2fa:"),
				20,
				60_000,
			);
		});

		it("exports AUTH_RATE_LIMITS with all expected endpoints", () => {
			expect(AUTH_RATE_LIMITS).toHaveProperty("/sign-in/email");
			expect(AUTH_RATE_LIMITS).toHaveProperty("/sign-up/email");
			expect(AUTH_RATE_LIMITS).toHaveProperty("/request-password-reset");
			expect(AUTH_RATE_LIMITS).toHaveProperty("/magic-link");
			expect(AUTH_RATE_LIMITS).toHaveProperty("/two-factor");
		});
	});

	// ---------------------------------------------------------------
	// Test 2: returns 429 when limit exceeded
	// ---------------------------------------------------------------
	describe("returns 429 when limit exceeded", () => {
		it("returns HTTP 429 with correct JSON body", async () => {
			mockCheckRateLimit.mockResolvedValue({
				allowed: false,
				remaining: 0,
				resetInSeconds: 45,
			});

			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/sign-in/email");

			expect(res.status).toBe(429);

			const body = await res.json();
			expect(body).toMatchObject({
				error: "Too many requests",
				retryAfter: 45,
			});
			expect(body.message).toContain("45");
		});

		it("does not call downstream handler when rate limited", async () => {
			mockCheckRateLimit.mockResolvedValue({
				allowed: false,
				remaining: 0,
				resetInSeconds: 10,
			});

			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/sign-in/email");

			expect(res.status).toBe(429);
			// Body should NOT be { ok: true }
			const body = await res.json();
			expect(body.ok).toBeUndefined();
		});
	});

	// ---------------------------------------------------------------
	// Test 3: does not rate-limit non-auth routes
	// ---------------------------------------------------------------
	describe("does not rate-limit non-auth routes", () => {
		it("non-auth routes are unaffected and checkRateLimit is not called", async () => {
			const app = createTestApp();
			const res = await app.request("/api/projects", {
				method: "GET",
				headers: { "x-forwarded-for": "10.0.0.1" },
			});

			expect(res.status).toBe(200);
			expect(mockCheckRateLimit).not.toHaveBeenCalled();
		});

		it("auth routes without specific config pass through without rate limiting", async () => {
			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/session");

			expect(res.status).toBe(200);
			// checkRateLimit should not be called for unmatched auth endpoints
			expect(mockCheckRateLimit).not.toHaveBeenCalled();
		});
	});

	// ---------------------------------------------------------------
	// Test 4: sets rate limit headers on all responses
	// ---------------------------------------------------------------
	describe("sets rate limit headers on all responses", () => {
		it("includes X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset on allowed requests", async () => {
			mockCheckRateLimit.mockResolvedValue({
				allowed: true,
				remaining: 7,
				resetInSeconds: 42,
			});

			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/sign-in/email");

			expect(res.status).toBe(200);
			expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
			expect(res.headers.get("X-RateLimit-Remaining")).toBe("7");
			expect(res.headers.get("X-RateLimit-Reset")).toBe("42");
		});

		it("includes rate limit headers on 429 responses as well", async () => {
			mockCheckRateLimit.mockResolvedValue({
				allowed: false,
				remaining: 0,
				resetInSeconds: 55,
			});

			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/sign-up/email");

			expect(res.status).toBe(429);
			expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
			expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
			expect(res.headers.get("X-RateLimit-Reset")).toBe("55");
		});
	});

	// ---------------------------------------------------------------
	// Test 5: includes Retry-After header on 429
	// ---------------------------------------------------------------
	describe("includes Retry-After header on 429", () => {
		it("sets Retry-After header when limit is exceeded", async () => {
			mockCheckRateLimit.mockResolvedValue({
				allowed: false,
				remaining: 0,
				resetInSeconds: 30,
			});

			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/sign-in/email");

			expect(res.status).toBe(429);
			expect(res.headers.get("Retry-After")).toBe("30");
		});

		it("does NOT set Retry-After header when request is allowed", async () => {
			mockCheckRateLimit.mockResolvedValue({
				allowed: true,
				remaining: 8,
				resetInSeconds: 50,
			});

			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/sign-in/email");

			expect(res.status).toBe(200);
			expect(res.headers.get("Retry-After")).toBeNull();
		});
	});

	// ---------------------------------------------------------------
	// Test 6: uses distinct Redis keys per endpoint
	// ---------------------------------------------------------------
	describe("uses distinct Redis keys per endpoint", () => {
		it("sign-in and sign-up produce different key prefixes for the same IP", async () => {
			const app = createTestApp();
			const ip = "10.0.0.50";

			await makeRequest(app, "/api/auth/sign-in/email", { ip });
			await makeRequest(app, "/api/auth/sign-up/email", { ip });

			expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);

			const [signInKey] = mockCheckRateLimit.mock.calls[0];
			const [signUpKey] = mockCheckRateLimit.mock.calls[1];

			// Keys must start with different prefixes
			expect(signInKey).toContain("auth:signin:");
			expect(signUpKey).toContain("auth:signup:");

			// Keys must differ
			expect(signInKey).not.toBe(signUpKey);

			// Both should contain the same IP
			expect(signInKey).toContain(ip);
			expect(signUpKey).toContain(ip);
		});

		it("same endpoint with different IPs produces different keys", async () => {
			const app = createTestApp();

			await makeRequest(app, "/api/auth/sign-in/email", {
				ip: "1.1.1.1",
			});
			await makeRequest(app, "/api/auth/sign-in/email", {
				ip: "2.2.2.2",
			});

			expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);

			const [key1] = mockCheckRateLimit.mock.calls[0];
			const [key2] = mockCheckRateLimit.mock.calls[1];

			// Same prefix, different IP suffix
			expect(key1).toContain("auth:signin:");
			expect(key2).toContain("auth:signin:");
			expect(key1).not.toBe(key2);
		});
	});

	// ---------------------------------------------------------------
	// Test 7: surfaces 503 when rate-limit service is unavailable
	// ---------------------------------------------------------------
	describe("surfaces 503 when rate-limit service is unavailable", () => {
		it("returns HTTP 503 with Service Unavailable body when checkRateLimit returns statusCode 503", async () => {
			mockCheckRateLimit.mockResolvedValue({
				allowed: false,
				remaining: 0,
				resetInSeconds: 60,
				statusCode: 503,
				reason: "ratelimit-unavailable",
			});

			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/sign-in/email");

			expect(res.status).toBe(503);

			const body = await res.json();
			expect(body).toMatchObject({
				error: "Service Unavailable",
				retryAfter: 60,
			});
			expect(body.message).toContain("unavailable");
		});

		it("does not set X-RateLimit-* headers on 503 responses", async () => {
			mockCheckRateLimit.mockResolvedValue({
				allowed: false,
				remaining: 0,
				resetInSeconds: 60,
				statusCode: 503,
				reason: "ratelimit-unavailable",
			});

			const app = createTestApp();
			const res = await makeRequest(app, "/api/auth/sign-in/email");

			expect(res.status).toBe(503);
			expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
			expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
			expect(res.headers.get("X-RateLimit-Reset")).toBeNull();
			// Retry-After is still set so clients know when to retry
			expect(res.headers.get("Retry-After")).toBe("60");
		});
	});
});
