/**
 * Single-use consumption of integration OAuth state nonces.
 *
 * The signed state proves origin and age; this store is what makes a state
 * unusable a second time. The shape mirrors the rate limiter's: Redis `SET NX`
 * decides, production refuses when Redis cannot answer, and only outside
 * production does an in-memory map stand in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedisClient, mockSet } = vi.hoisted(() => ({
	mockGetRedisClient: vi.fn(),
	mockSet: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../lib/redis-client", () => ({
	getRedisClient: mockGetRedisClient,
}));

import {
	__resetInMemoryOAuthStateStoreForTests,
	consumeOAuthStateNonce,
} from "../../lib/oauth-state-store";

const TTL_MS = 10 * 60 * 1000;
const KEY = "fabric:integrations:oauth-state:nonce-a";

beforeEach(() => {
	vi.clearAllMocks();
	__resetInMemoryOAuthStateStoreForTests();
	mockGetRedisClient.mockReturnValue(null);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("consumeOAuthStateNonce — in-memory (no Redis, outside production)", () => {
	it("accepts the first presentation and refuses the second", async () => {
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"consumed",
		);
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"replayed",
		);
	});

	it("keeps nonces independent of each other", async () => {
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"consumed",
		);
		await expect(consumeOAuthStateNonce("nonce-b")).resolves.toBe(
			"consumed",
		);
	});

	it("forgets a nonce once the state it belongs to could no longer be accepted", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"consumed",
		);
		// Inside the window it is still remembered.
		vi.setSystemTime(new Date("2026-09-13T12:10:30Z"));
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"replayed",
		);
		// Past the state TTL plus the slack, the key has served its purpose.
		vi.setSystemTime(new Date("2026-09-13T12:11:01Z"));
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"consumed",
		);
	});

	it("refuses an empty nonce rather than letting it act as a shared slot", async () => {
		await expect(consumeOAuthStateNonce("")).resolves.toBe("unavailable");
	});
});

describe("consumeOAuthStateNonce — Redis", () => {
	beforeEach(() => {
		mockGetRedisClient.mockReturnValue({ set: mockSet });
	});

	it("uses SET NX with the state TTL plus slack, and reports the first presentation", async () => {
		mockSet.mockResolvedValue("OK");
		await expect(consumeOAuthStateNonce("nonce-a", TTL_MS)).resolves.toBe(
			"consumed",
		);
		expect(mockSet).toHaveBeenCalledWith(KEY, "1", {
			nx: true,
			ex: 11 * 60,
		});
	});

	it("reports a replay when SET NX finds the key already present", async () => {
		mockSet.mockResolvedValue(null);
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"replayed",
		);
	});

	it("fails closed in production when Redis throws", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mockSet.mockRejectedValue(new Error("redis-down"));
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"unavailable",
		);
	});

	it("falls back to the in-memory store outside production when Redis throws", async () => {
		mockSet.mockRejectedValue(new Error("redis-down"));
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"consumed",
		);
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"replayed",
		);
	});
});

describe("consumeOAuthStateNonce — production without Redis", () => {
	it("fails closed instead of using the per-process map", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mockGetRedisClient.mockReturnValue(null);
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"unavailable",
		);
		// And a second call is still refused — nothing was recorded anywhere.
		await expect(consumeOAuthStateNonce("nonce-a")).resolves.toBe(
			"unavailable",
		);
	});
});
