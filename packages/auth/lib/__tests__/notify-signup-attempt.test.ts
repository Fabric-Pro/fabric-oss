import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any module imports
// ---------------------------------------------------------------------------

const mockSet = vi.fn();
const mockRedisClient = { set: mockSet };
let redisEnabled = true;

vi.mock("../redis-client", () => ({
	getAuthRedisClient: () => (redisEnabled ? mockRedisClient : null),
}));

vi.mock("@repo/mail", () => ({
	sendEmail: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "http://localhost:3000",
}));

// ---------------------------------------------------------------------------
// Imports — AFTER mocks are set up
// ---------------------------------------------------------------------------

import { sendEmail } from "@repo/mail";
import { notifySignupAttempt } from "../notify-signup-attempt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256BucketKey(email: string): string {
	const h = createHash("sha256")
		.update(email.trim().toLowerCase())
		.digest("hex");
	return `signup-notice:${h}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notifySignupAttempt", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		redisEnabled = true;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("sends an email on first call", () => {
		it("calls sendEmail with the right to address and templateId", async () => {
			mockSet.mockResolvedValueOnce("OK");

			await notifySignupAttempt("user@example.com");

			expect(sendEmail).toHaveBeenCalledOnce();
			expect(sendEmail).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "user@example.com",
					templateId: "signupAttemptNotice",
					context: expect.objectContaining({
						loginUrl: "http://localhost:3000/auth/login",
						resetUrl: "http://localhost:3000/auth/forgot-password",
					}),
				}),
			);
		});

		it("acquires the throttle bucket atomically with SET NX EX", async () => {
			// Documents the atomic-acquire contract: a single round-trip that
			// both creates the key and binds the TTL, so no orphan key can
			// persist if a follow-up EXPIRE call would have failed.
			mockSet.mockResolvedValueOnce("OK");

			await notifySignupAttempt("user@example.com");

			expect(mockSet).toHaveBeenCalledOnce();
			expect(mockSet).toHaveBeenCalledWith(
				sha256BucketKey("user@example.com"),
				1,
				{ ex: 3600, nx: true },
			);
		});
	});

	describe("throttles on second call within the window", () => {
		it("does not call sendEmail on the second call", async () => {
			// First call — NX succeeds, key created
			mockSet.mockResolvedValueOnce("OK");
			await notifySignupAttempt("user@example.com");

			// Second call — NX fails because key already exists, returns null
			mockSet.mockResolvedValueOnce(null);
			await notifySignupAttempt("user@example.com");

			expect(sendEmail).toHaveBeenCalledOnce();
		});
	});

	describe("uses sha256 of normalized email as bucket key", () => {
		it("treats differently-cased variants of the same address as the same bucket", async () => {
			// First call acquires the bucket; second call sees the same key
			// already held (NX→null) and short-circuits. Both calls hit the
			// same Redis key — that's what we're asserting.
			mockSet.mockResolvedValueOnce("OK");
			mockSet.mockResolvedValueOnce(null);

			await notifySignupAttempt("Foo@Example.com");
			await notifySignupAttempt("foo@example.com");

			const expectedKey = sha256BucketKey("foo@example.com");
			const allSetKeys = mockSet.mock.calls.map((c) => c[0]);
			expect(allSetKeys).toEqual([expectedKey, expectedKey]);
		});
	});

	describe("fail-open behavior when Redis throws", () => {
		it("still sends the email if Redis set throws", async () => {
			mockSet.mockRejectedValueOnce(new Error("Connection refused"));

			await notifySignupAttempt("user@example.com");

			expect(sendEmail).toHaveBeenCalledOnce();
			expect(sendEmail).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "user@example.com",
					templateId: "signupAttemptNotice",
				}),
			);
		});

		it("still sends when Redis is unavailable (null client)", async () => {
			redisEnabled = false;

			await notifySignupAttempt("user@example.com");

			expect(sendEmail).toHaveBeenCalledOnce();
			expect(sendEmail).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "user@example.com",
					templateId: "signupAttemptNotice",
				}),
			);
		});
	});
});
