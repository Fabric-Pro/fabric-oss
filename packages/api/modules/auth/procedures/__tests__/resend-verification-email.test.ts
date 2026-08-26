/**
 * Tests for resendVerificationEmail procedure.
 * Verifies CAPTCHA, global cap, rate limiting, email normalization,
 * hashed bucket keys, and email enumeration prevention.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock external boundaries
vi.mock("@repo/database", () => ({
	db: {
		user: {
			findFirst: vi.fn(),
		},
	},
}));

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			sendVerificationEmail: vi.fn(),
		},
	},
}));

vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: vi.fn(),
}));

vi.mock("@repo/auth/lib/turnstile", () => ({
	verifyTurnstileToken: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

import { auth } from "@repo/auth";
import { verifyTurnstileToken } from "@repo/auth/lib/turnstile";
import { db } from "@repo/database";
import { z } from "zod";
import { checkRateLimit } from "../../../../lib/rate-limit";
import { resendVerificationEmailHandler } from "../resend-verification-email";

/** The input schema used by the procedure. */
const inputSchema = z.object({
	email: z.string().email(),
	captchaToken: z.string().min(1),
});

/** Helper to build a rate-limit result that allows the request. */
function allowed(resetInSeconds = 58) {
	return { allowed: true, remaining: 5, resetInSeconds };
}

/** Helper to build a rate-limit result that blocks the request. */
function blocked(resetInSeconds = 42) {
	return { allowed: false, remaining: 0, resetInSeconds };
}

/** Build a minimal mock context with headers. */
function makeContext(ip = "127.0.0.1") {
	return {
		headers: new Headers({ "x-real-ip": ip }),
	};
}

/** Default input with captchaToken. */
function makeInput(email = "test@example.com") {
	return { email, captchaToken: "valid-token" };
}

describe("resendVerificationEmail procedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Default: CAPTCHA passes
		vi.mocked(verifyTurnstileToken).mockResolvedValue({ success: true });

		// Default: all rate limits pass (global, IP, email-hr, email-minute)
		vi.mocked(checkRateLimit)
			.mockResolvedValueOnce(allowed()) // global
			.mockResolvedValueOnce(allowed()) // IP
			.mockResolvedValueOnce(allowed()) // email hourly
			.mockResolvedValueOnce(allowed(58)); // email per-minute
	});

	it("sends email for unverified user", async () => {
		vi.mocked(db.user.findFirst).mockResolvedValueOnce({
			emailVerified: false,
		} as any);
		vi.mocked(auth.api.sendVerificationEmail).mockResolvedValueOnce(
			undefined as any,
		);

		const result = await resendVerificationEmailHandler({
			input: makeInput(),
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(result.alreadyVerified).toBe(false);
		expect(result.resetInSeconds).toBe(60);
		expect(auth.api.sendVerificationEmail).toHaveBeenCalledWith({
			body: { email: "test@example.com" },
		});
	});

	it("returns identical response for verified user (no enumeration leak)", async () => {
		vi.mocked(db.user.findFirst).mockResolvedValueOnce({
			emailVerified: true,
		} as any);

		const result = await resendVerificationEmailHandler({
			input: makeInput("verified@example.com"),
			context: makeContext(),
		});

		// Same shape as unverified — attacker can't distinguish
		expect(result.success).toBe(true);
		expect(result.alreadyVerified).toBe(false);
		expect(result.resetInSeconds).toBe(60);
		expect(auth.api.sendVerificationEmail).not.toHaveBeenCalled();
	});

	it("returns identical response for non-existent email (no enumeration leak)", async () => {
		vi.mocked(db.user.findFirst).mockResolvedValueOnce(null);

		const result = await resendVerificationEmailHandler({
			input: makeInput("nobody@example.com"),
			context: makeContext(),
		});

		// Same shape as verified/unverified — no information leakage
		expect(result.success).toBe(true);
		expect(result.alreadyVerified).toBe(false);
		expect(auth.api.sendVerificationEmail).not.toHaveBeenCalled();
	});

	it("rejects when CAPTCHA fails", async () => {
		vi.mocked(verifyTurnstileToken).mockResolvedValueOnce({
			success: false,
		});

		await expect(
			resendVerificationEmailHandler({
				input: makeInput(),
				context: makeContext(),
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Captcha verification failed",
		});

		// No rate-limit checks should run after CAPTCHA failure
		expect(checkRateLimit).not.toHaveBeenCalled();
	});

	it("rejects when global cap exceeded", async () => {
		vi.mocked(checkRateLimit).mockReset();
		vi.mocked(checkRateLimit).mockResolvedValueOnce(blocked(120));

		await expect(
			resendVerificationEmailHandler({
				input: makeInput(),
				context: makeContext(),
			}),
		).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
			message: "Service temporarily unavailable",
		});

		expect(checkRateLimit).toHaveBeenCalledTimes(1);
		expect(checkRateLimit).toHaveBeenCalledWith(
			"verify-resend:global",
			1000,
			3_600_000,
		);
	});

	it("throws TOO_MANY_REQUESTS when per-IP limit is exceeded", async () => {
		vi.mocked(checkRateLimit).mockReset();
		vi.mocked(checkRateLimit)
			.mockResolvedValueOnce(allowed()) // global
			.mockResolvedValueOnce(blocked(120)); // IP

		await expect(
			resendVerificationEmailHandler({
				input: makeInput(),
				context: makeContext(),
			}),
		).rejects.toThrow("Please try again later or contact support.");

		expect(checkRateLimit).toHaveBeenCalledTimes(2);
		expect(checkRateLimit).toHaveBeenNthCalledWith(
			2,
			"verify-resend:ip:127.0.0.1",
			10,
			3_600_000,
		);
	});

	it("throws TOO_MANY_REQUESTS when per-email hourly limit is exceeded", async () => {
		vi.mocked(checkRateLimit).mockReset();
		vi.mocked(checkRateLimit)
			.mockResolvedValueOnce(allowed()) // global
			.mockResolvedValueOnce(allowed()) // IP
			.mockResolvedValueOnce(blocked(300)); // email hourly

		await expect(
			resendVerificationEmailHandler({
				input: makeInput(),
				context: makeContext(),
			}),
		).rejects.toThrow("Please try again later or contact support.");

		expect(checkRateLimit).toHaveBeenCalledTimes(3);
	});

	it("throws TOO_MANY_REQUESTS with isPerMinuteLimit flag when per-email 60s limit is exceeded", async () => {
		vi.mocked(checkRateLimit).mockReset();
		vi.mocked(checkRateLimit)
			.mockResolvedValueOnce(allowed()) // global
			.mockResolvedValueOnce(allowed()) // IP
			.mockResolvedValueOnce(allowed()) // email hourly
			.mockResolvedValueOnce(blocked(45)); // email per-minute

		try {
			await resendVerificationEmailHandler({
				input: makeInput(),
				context: makeContext(),
			});
			expect.fail("Should have thrown");
		} catch (e: any) {
			expect(e.message).toBe(
				"Please try again later or contact support.",
			);
			expect(e.data?.isPerMinuteLimit).toBe(true);
			expect(e.data?.retryAfter).toBe(45);
		}

		expect(checkRateLimit).toHaveBeenCalledTimes(4);
	});

	it("validates email format (invalid email returns validation error)", () => {
		const valid = inputSchema.safeParse({
			email: "good@example.com",
			captchaToken: "tok",
		});
		expect(valid.success).toBe(true);

		const invalid = inputSchema.safeParse({
			email: "not-an-email",
			captchaToken: "tok",
		});
		expect(invalid.success).toBe(false);

		const empty = inputSchema.safeParse({ email: "", captchaToken: "tok" });
		expect(empty.success).toBe(false);

		const missing = inputSchema.safeParse({ captchaToken: "tok" });
		expect(missing.success).toBe(false);

		const missingToken = inputSchema.safeParse({
			email: "good@example.com",
			captchaToken: "",
		});
		expect(missingToken.success).toBe(false);
	});

	it("uses sha256 of email in per-email bucket keys", async () => {
		vi.mocked(db.user.findFirst).mockResolvedValueOnce({
			emailVerified: false,
		} as any);
		vi.mocked(auth.api.sendVerificationEmail).mockResolvedValueOnce(
			undefined as any,
		);

		const fixtureEmail = "user@example.com";
		const emailHash = createHash("sha256")
			.update(fixtureEmail)
			.digest("hex");

		await resendVerificationEmailHandler({
			input: { email: fixtureEmail, captchaToken: "valid-token" },
			context: makeContext(),
		});

		expect(checkRateLimit).toHaveBeenCalledWith(
			`verify-resend:email-hr:${emailHash}`,
			3,
			3_600_000,
		);
		expect(checkRateLimit).toHaveBeenCalledWith(
			`verify-resend:email:${emailHash}`,
			1,
			60_000,
		);
		// Raw email must not appear in any bucket key
		const allKeys = vi
			.mocked(checkRateLimit)
			.mock.calls.map((c) => c[0] as string);
		for (const key of allKeys) {
			expect(key).not.toContain(fixtureEmail);
		}
	});

	it("normalizes email to lowercase before DB query and rate-limit keys", async () => {
		vi.mocked(db.user.findFirst).mockResolvedValueOnce({
			emailVerified: false,
		} as any);
		vi.mocked(auth.api.sendVerificationEmail).mockResolvedValueOnce(
			undefined as any,
		);

		const normalizedEmail = "user@example.com";
		const emailHash = createHash("sha256")
			.update(normalizedEmail)
			.digest("hex");

		await resendVerificationEmailHandler({
			input: { email: "User@Example.COM", captchaToken: "valid-token" },
			context: makeContext(),
		});

		expect(db.user.findFirst).toHaveBeenCalledWith({
			where: { email: normalizedEmail },
			select: { emailVerified: true },
		});

		expect(checkRateLimit).toHaveBeenNthCalledWith(
			3,
			`verify-resend:email-hr:${emailHash}`,
			3,
			3_600_000,
		);
		expect(checkRateLimit).toHaveBeenNthCalledWith(
			4,
			`verify-resend:email:${emailHash}`,
			1,
			60_000,
		);

		expect(auth.api.sendVerificationEmail).toHaveBeenCalledWith({
			body: { email: normalizedEmail },
		});
	});

	it("checks rate limits in the correct order: global, IP, email-hr, email-minute", async () => {
		vi.mocked(db.user.findFirst).mockResolvedValueOnce({
			emailVerified: false,
		} as any);
		vi.mocked(auth.api.sendVerificationEmail).mockResolvedValueOnce(
			undefined as any,
		);

		const fixtureEmail = "test@example.com";
		const emailHash = createHash("sha256")
			.update(fixtureEmail)
			.digest("hex");

		await resendVerificationEmailHandler({
			input: { email: fixtureEmail, captchaToken: "valid-token" },
			context: makeContext("10.0.0.1"),
		});

		expect(checkRateLimit).toHaveBeenCalledTimes(4);
		expect(checkRateLimit).toHaveBeenNthCalledWith(
			1,
			"verify-resend:global",
			1000,
			3_600_000,
		);
		expect(checkRateLimit).toHaveBeenNthCalledWith(
			2,
			"verify-resend:ip:10.0.0.1",
			10,
			3_600_000,
		);
		expect(checkRateLimit).toHaveBeenNthCalledWith(
			3,
			`verify-resend:email-hr:${emailHash}`,
			3,
			3_600_000,
		);
		expect(checkRateLimit).toHaveBeenNthCalledWith(
			4,
			`verify-resend:email:${emailHash}`,
			1,
			60_000,
		);
	});

	it("consumes rate limits even for non-existent emails", async () => {
		vi.mocked(db.user.findFirst).mockResolvedValueOnce(null);

		await resendVerificationEmailHandler({
			input: makeInput("ghost@example.com"),
			context: makeContext(),
		});

		expect(checkRateLimit).toHaveBeenCalledTimes(4);
		expect(db.user.findFirst).toHaveBeenCalled();
	});

	it("uses fingerprint fallback when no IP headers are present", async () => {
		vi.mocked(db.user.findFirst).mockResolvedValueOnce(null);

		await resendVerificationEmailHandler({
			input: makeInput(),
			context: {
				headers: new Headers({ "user-agent": "TestBrowser/1.0" }),
			},
		});

		// IP key should use fingerprint, not "unknown"
		const ipKey = vi.mocked(checkRateLimit).mock.calls[1][0];
		expect(ipKey).toMatch(/^verify-resend:ip:fingerprint:/);
		expect(ipKey).not.toContain("unknown");
	});
});
