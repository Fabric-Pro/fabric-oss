/**
 * A Redis hit must not slide the shared TTL (Fix 2) — otherwise a card that
 * is read at least once per TTL never expires and a redeploy's card change
 * can stay invisible indefinitely. A future-dated L2 timestamp must also
 * fall through to a live fetch rather than being treated as fresh (Fix 1c).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getRegisteredAgentByAgentIdMock,
	updateAgentCardCacheMock,
	getAgentCardMock,
	redisGetMock,
	redisSetMock,
} = vi.hoisted(() => ({
	getRegisteredAgentByAgentIdMock: vi.fn(),
	updateAgentCardCacheMock: vi.fn(),
	getAgentCardMock: vi.fn(),
	redisGetMock: vi.fn(),
	redisSetMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/database", () => ({
	getRegisteredAgentByAgentId: (...args: unknown[]) =>
		getRegisteredAgentByAgentIdMock(...args),
	updateAgentCardCache: (...args: unknown[]) =>
		updateAgentCardCacheMock(...args),
}));

vi.mock("@repo/agent-core", () => ({
	A2AClient: class {
		getAgentCard(...args: unknown[]) {
			return getAgentCardMock(...args);
		}
	},
}));

vi.mock("../resolve-endpoint", () => ({
	resolveAgentEndpoint: vi.fn().mockResolvedValue({
		deploymentUrl: "http://localhost:8124",
	}),
}));

vi.mock("../../../../lib/redis-cache", () => ({
	RedisCache: {
		get: (...args: unknown[]) => redisGetMock(...args),
		set: (...args: unknown[]) => redisSetMock(...args),
	},
	CacheKeys: {
		agentCard: (agentId: string) => `agentcard:${agentId}`,
	},
	CacheTTL: { agentCard: 1800 },
}));

import {
	clearCapabilityCache,
	getAgentCapabilities,
} from "../agent-capabilities";

beforeEach(() => {
	getRegisteredAgentByAgentIdMock.mockReset();
	// Production chains `.catch` on this call's return value, so a bare
	// mockReset() (returning undefined) would throw inside the live path and
	// be swallowed into a null result — hiding whether that path completed.
	updateAgentCardCacheMock.mockReset().mockResolvedValue(undefined);
	getAgentCardMock.mockReset();
	redisGetMock.mockReset();
	redisSetMock.mockClear();
	// The module's L1 in-memory cache is a singleton Map shared across tests
	// in this file — clear it so an earlier test's entry can't mask the
	// Redis/DB path this test is exercising.
	clearCapabilityCache();
});

describe("getAgentCapabilities cache layering", () => {
	it("does not slide the Redis TTL on a Redis hit", async () => {
		redisGetMock.mockResolvedValue({ name: "Cached" });

		const result = await getAgentCapabilities("agent-1", "user-1");

		expect(result).not.toBeNull();
		expect(redisGetMock).toHaveBeenCalledWith("agentcard:agent-1");
		expect(redisSetMock).not.toHaveBeenCalled();
		// A Redis hit must be served from Redis alone — no DB read, no live fetch.
		expect(getRegisteredAgentByAgentIdMock).not.toHaveBeenCalled();
		expect(getAgentCardMock).not.toHaveBeenCalled();
	});

	it("takes the live-fetch path when the stored L2 timestamp is in the future", async () => {
		redisGetMock.mockResolvedValue(null);
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: {
				agentCard: { name: "Stored" },
				agentCardCachedAt: new Date(
					Date.now() + 10 * 60_000,
				).toISOString(),
			},
		});
		getAgentCardMock.mockResolvedValue({ name: "Live" });

		const result = await getAgentCapabilities("agent-1", "user-1");

		expect(getAgentCardMock).toHaveBeenCalledTimes(1);
		// The live path must complete: a non-null result and the fresh card
		// persisted to L2, not a swallowed error.
		expect(result).not.toBeNull();
		expect(updateAgentCardCacheMock).toHaveBeenCalledWith(
			"agent-1",
			{ name: "Live" },
			expect.any(Date),
		);
	});
});
