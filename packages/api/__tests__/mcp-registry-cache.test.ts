/**
 * Unit tests for the MCP registry cache.
 *
 * These pin the version-stamping behavior introduced by the
 * `mcp_registry_version` Postgres trigger (migration 20260523000200):
 *   - The Redis cache key always reflects the current DB version, so a
 *     write to `mcp_server` produces a cache miss on the next read.
 *   - When the version row is missing (pre-migration deployment) the cache
 *     falls back to a static `:legacy` key instead of crashing.
 *   - `invalidateSystemServersCache()` SCANs the entire
 *     `mcp:registry:system-servers:*` family so the gitlab-oauth disconnect
 *     path (and any operator-driven flush) wipes every version.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockRedis } = vi.hoisted(() => ({
	mockDb: {
		getMcpRegistryVersion: vi.fn<() => Promise<bigint | null>>(),
	},
	mockRedis: {
		get: vi.fn(),
		set: vi.fn(),
		scan: vi.fn(),
		del: vi.fn(),
		quit: vi.fn(),
		connect: vi.fn(),
		on: vi.fn(),
		disconnect: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	getMcpRegistryVersion: mockDb.getMcpRegistryVersion,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("ioredis", () => ({
	// Vitest 4 invokes mock implementations with `new`, so the stub must be a
	// real (constructable) function — an arrow throws
	// "() => mockRedis is not a constructor". `new Redis()` returns mockRedis.
	// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Redis()`
	default: vi.fn(function () {
		return mockRedis;
	}),
}));

import {
	getCachedSystemServers,
	invalidateSystemServersCache,
	setCachedSystemServers,
} from "../lib/mcp-registry-cache";

describe("mcp-registry-cache", () => {
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		vi.clearAllMocks();
		// A minimal Redis URL so getRedis() returns the mocked client.
		process.env.REDIS_URL = "redis://localhost:6379";
		delete process.env.CACHE_HOST;
		delete process.env.CACHE_PORT;
		delete process.env.CACHE_PASSWORD;
		delete process.env.REDIS_PASSWORD;
		mockRedis.connect.mockResolvedValue(undefined);
		mockRedis.quit.mockResolvedValue("OK");
		mockRedis.on.mockReturnValue(mockRedis as never);
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	describe("getCachedSystemServers", () => {
		it("reads from a key suffixed with the current DB version", async () => {
			mockDb.getMcpRegistryVersion.mockResolvedValue(42n);
			mockRedis.get.mockResolvedValue(
				JSON.stringify([{ id: "s1", isSystemProvided: true }]),
			);

			const result = await getCachedSystemServers();

			expect(mockDb.getMcpRegistryVersion).toHaveBeenCalledOnce();
			expect(mockRedis.get).toHaveBeenCalledWith(
				"mcp:registry:system-servers:v42",
			);
			expect(result).toEqual([{ id: "s1", isSystemProvided: true }]);
		});

		it("returns null on cache miss and uses the version-stamped key", async () => {
			mockDb.getMcpRegistryVersion.mockResolvedValue(7n);
			mockRedis.get.mockResolvedValue(null);

			const result = await getCachedSystemServers();

			expect(mockRedis.get).toHaveBeenCalledWith(
				"mcp:registry:system-servers:v7",
			);
			expect(result).toBeNull();
		});

		it("falls back to the legacy key when the DB version is unavailable", async () => {
			mockDb.getMcpRegistryVersion.mockResolvedValue(null);
			mockRedis.get.mockResolvedValue(null);

			await getCachedSystemServers();

			expect(mockRedis.get).toHaveBeenCalledWith(
				"mcp:registry:system-servers:legacy",
			);
		});

		it("returns null (degrades to DB) when Redis is not configured", async () => {
			delete process.env.REDIS_URL;
			mockDb.getMcpRegistryVersion.mockResolvedValue(1n);

			const result = await getCachedSystemServers();

			expect(result).toBeNull();
			expect(mockRedis.get).not.toHaveBeenCalled();
		});

		it("survives a Redis GET error without throwing", async () => {
			mockDb.getMcpRegistryVersion.mockResolvedValue(1n);
			mockRedis.get.mockRejectedValue(new Error("boom"));

			const result = await getCachedSystemServers();

			expect(result).toBeNull();
		});
	});

	describe("setCachedSystemServers", () => {
		it("writes to the version-stamped key with a short-TTL safety net", async () => {
			mockDb.getMcpRegistryVersion.mockResolvedValue(123n);
			mockRedis.set.mockResolvedValue("OK");

			await setCachedSystemServers([
				{ id: "s1", isSystemProvided: true },
			]);

			expect(mockRedis.set).toHaveBeenCalledTimes(1);
			const firstCall = mockRedis.set.mock.calls[0];
			expect(firstCall).toBeDefined();
			const [key, payload, mode, ttl] = firstCall as [
				string,
				string,
				string,
				number,
			];
			expect(key).toBe("mcp:registry:system-servers:v123");
			expect(JSON.parse(payload as string)).toEqual([
				{ id: "s1", isSystemProvided: true },
			]);
			expect(mode).toBe("EX");
			// Belt: TTL must be short enough that orphaned old-version keys
			// expire on their own well under the historic 7-day window.
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(60 * 60);
		});

		it("is a no-op when Redis is not configured", async () => {
			delete process.env.REDIS_URL;
			mockDb.getMcpRegistryVersion.mockResolvedValue(1n);

			await setCachedSystemServers([{ id: "s1" }]);

			expect(mockRedis.set).not.toHaveBeenCalled();
		});

		it("swallows Redis SET errors (cache write is fire-and-forget)", async () => {
			mockDb.getMcpRegistryVersion.mockResolvedValue(1n);
			mockRedis.set.mockRejectedValue(new Error("network"));

			await expect(
				setCachedSystemServers([{ id: "s1" }]),
			).resolves.toBeUndefined();
		});
	});

	describe("invalidateSystemServersCache", () => {
		it("SCANs the whole family and DELs every matching key", async () => {
			mockRedis.scan
				.mockResolvedValueOnce([
					"42",
					[
						"mcp:registry:system-servers:v1",
						"mcp:registry:system-servers:v2",
					],
				])
				.mockResolvedValueOnce([
					"0",
					["mcp:registry:system-servers:v3"],
				]);
			mockRedis.del.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

			await invalidateSystemServersCache();

			expect(mockRedis.scan).toHaveBeenNthCalledWith(
				1,
				"0",
				"MATCH",
				"mcp:registry:system-servers:*",
				"COUNT",
				100,
			);
			expect(mockRedis.scan).toHaveBeenNthCalledWith(
				2,
				"42",
				"MATCH",
				"mcp:registry:system-servers:*",
				"COUNT",
				100,
			);
			expect(mockRedis.del).toHaveBeenNthCalledWith(
				1,
				"mcp:registry:system-servers:v1",
				"mcp:registry:system-servers:v2",
			);
			expect(mockRedis.del).toHaveBeenNthCalledWith(
				2,
				"mcp:registry:system-servers:v3",
			);
		});

		it("handles an empty registry family (no matching keys)", async () => {
			mockRedis.scan.mockResolvedValueOnce(["0", []]);

			await invalidateSystemServersCache();

			expect(mockRedis.del).not.toHaveBeenCalled();
		});

		it("is a no-op when Redis is not configured", async () => {
			delete process.env.REDIS_URL;

			await invalidateSystemServersCache();

			expect(mockRedis.scan).not.toHaveBeenCalled();
		});
	});

	describe("end-to-end version flow", () => {
		it("a version bump between two reads yields different cache keys", async () => {
			// First read at version N
			mockDb.getMcpRegistryVersion.mockResolvedValueOnce(10n);
			mockRedis.get.mockResolvedValueOnce(JSON.stringify([{ v: 10 }]));
			await getCachedSystemServers();
			expect(mockRedis.get).toHaveBeenLastCalledWith(
				"mcp:registry:system-servers:v10",
			);

			// Migration runs in Postgres → trigger bumps version to N+1.
			// The cache module always re-reads the version on every lookup
			// (no in-process memoization) so a freshly-bumped version is
			// observed immediately — that's AC1's instant-invalidation
			// guarantee.

			// Second read sees the new version → cache miss on a fresh key
			mockDb.getMcpRegistryVersion.mockResolvedValueOnce(11n);
			mockRedis.get.mockResolvedValueOnce(null);
			const second = await getCachedSystemServers();

			expect(mockRedis.get).toHaveBeenLastCalledWith(
				"mcp:registry:system-servers:v11",
			);
			expect(second).toBeNull(); // cache miss → caller will repopulate
		});
	});

	describe("freshness guarantee", () => {
		it("re-reads the DB version on every cache lookup (no in-process memoization)", async () => {
			mockDb.getMcpRegistryVersion.mockResolvedValue(50n);
			mockRedis.get.mockResolvedValue(JSON.stringify([{ x: 1 }]));

			await getCachedSystemServers();
			await getCachedSystemServers();
			await getCachedSystemServers();

			// Each cache lookup must consult the DB so a write made between
			// requests is observed instantly — the whole point of AC1.
			expect(mockDb.getMcpRegistryVersion).toHaveBeenCalledTimes(3);
		});

		it("a SET followed by a GET both see the current DB version", async () => {
			mockDb.getMcpRegistryVersion.mockResolvedValue(77n);
			mockRedis.get.mockResolvedValue(null);
			mockRedis.set.mockResolvedValue("OK");

			await setCachedSystemServers([{ id: "a" }]);
			await getCachedSystemServers();

			// Two operations, two reads of the version — same number.
			expect(mockDb.getMcpRegistryVersion).toHaveBeenCalledTimes(2);
		});
	});
});
