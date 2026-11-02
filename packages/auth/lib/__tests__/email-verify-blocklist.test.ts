import { createEmailVerificationToken } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	client: null as { get: ReturnType<typeof vi.fn> } | null,
	warn: vi.fn(),
}));

vi.mock("../redis-client", () => ({
	getAuthRedisClient: () => mocks.client,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		warn: mocks.warn,
	},
}));

import {
	getEmailChangeRevocationStatus,
	getEmailVerifyJWTBlockStatus,
} from "../email-verify-blocklist";
import { assertEmailVerifyNotRevoked } from "../email-verify-revocation";

const SECRET = "email-blocklist-test-secret-long-enough-for-hs256";

beforeEach(() => {
	mocks.client = null;
	mocks.warn.mockReset();
	vi.stubEnv("UPSTASH_REDIS_REST_URL", undefined);
	vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("email verification revocation reads", () => {
	it("reports both checks clear when Redis is not configured", async () => {
		await expect(getEmailVerifyJWTBlockStatus("signed.jwt")).resolves.toBe(
			"clear",
		);
		await expect(
			getEmailChangeRevocationStatus(
				"old@example.com",
				"new@example.com",
			),
		).resolves.toBe("clear");
	});

	it("allows an email-change JWT when Redis is not configured", async () => {
		const token = await createEmailVerificationToken(
			SECRET,
			"old@example.com",
			"new@example.com",
			3600,
			{ requestType: "change-email-verification" },
		);

		await expect(
			assertEmailVerifyNotRevoked(token, SECRET),
		).resolves.toBeUndefined();
	});

	it("reports the exact-token check unavailable when the Redis read throws", async () => {
		mocks.client = {
			get: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
		};

		await expect(getEmailVerifyJWTBlockStatus("signed.jwt")).resolves.toBe(
			"unavailable",
		);
	});

	it("reports checks unavailable when Redis is configured but no client can be created", async () => {
		vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
		vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "example-token");

		await expect(getEmailVerifyJWTBlockStatus("signed.jwt")).resolves.toBe(
			"unavailable",
		);
		await expect(
			getEmailChangeRevocationStatus(
				"old@example.com",
				"new@example.com",
			),
		).resolves.toBe("unavailable");
	});

	it("reports a partial Redis configuration as unavailable", async () => {
		vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");

		await expect(getEmailVerifyJWTBlockStatus("signed.jwt")).resolves.toBe(
			"unavailable",
		);
	});

	it("reports the tuple check unavailable when the Redis read throws", async () => {
		mocks.client = {
			get: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
		};

		await expect(
			getEmailChangeRevocationStatus(
				"old@example.com",
				"new@example.com",
			),
		).resolves.toBe("unavailable");
	});

	it("distinguishes a stored marker from a clear read", async () => {
		mocks.client = {
			get: vi.fn().mockResolvedValueOnce(1).mockResolvedValue(null),
		};

		await expect(getEmailVerifyJWTBlockStatus("signed.jwt")).resolves.toBe(
			"revoked",
		);
		await expect(
			getEmailChangeRevocationStatus(
				"old@example.com",
				"new@example.com",
			),
		).resolves.toBe("clear");
	});
});
