/**
 * A Redis hit must not slide the shared TTL (Fix 2) — otherwise a card that
 * is read at least once per TTL never expires and a redeploy's card change
 * can stay invisible indefinitely. A future-dated L2 timestamp must also
 * fall through to a live fetch rather than being treated as fresh (Fix 1c).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	getRegisteredAgentByAgentIdMock,
	resolveVisibleRegisteredAgentMock,
	endpointFromRegisteredAgentMock,
	updateAgentCardCacheMock,
	getAgentCardMock,
	fetchAgentEndpointMock,
	redisGetMock,
	redisSetMock,
} = vi.hoisted(() => ({
	getRegisteredAgentByAgentIdMock: vi.fn(),
	resolveVisibleRegisteredAgentMock: vi.fn(),
	endpointFromRegisteredAgentMock: vi.fn(),
	updateAgentCardCacheMock: vi.fn(),
	getAgentCardMock: vi.fn(),
	fetchAgentEndpointMock: vi.fn(),
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
		constructor(private options: { fetch?: unknown } = {}) {}
		getAgentCard(...args: unknown[]) {
			return getAgentCardMock(this.options.fetch, ...args);
		}
	},
}));

vi.mock("@repo/utils/agent-endpoint", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	fetchAgentEndpoint: fetchAgentEndpointMock,
}));
vi.mock("../resolve-endpoint", () => ({
	resolveVisibleRegisteredAgent: (...args: unknown[]) =>
		resolveVisibleRegisteredAgentMock(...args),
	endpointFromRegisteredAgent: (...args: unknown[]) =>
		endpointFromRegisteredAgentMock(...args),
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
	resolveVisibleRegisteredAgentMock
		.mockReset()
		.mockResolvedValue({ agentId: "agent-1", metadata: {} });
	endpointFromRegisteredAgentMock.mockReset().mockReturnValue({
		deploymentUrl: "https://agent.example.com",
		isExternal: false,
	} as never);
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
		// Visibility resolution precedes the Redis read; no unscoped lookup is needed.
		expect(getRegisteredAgentByAgentIdMock).not.toHaveBeenCalled();
		expect(getAgentCardMock).not.toHaveBeenCalled();
	});

	it("takes the live-fetch path when the stored L2 timestamp is in the future", async () => {
		redisGetMock.mockResolvedValue(null);
		resolveVisibleRegisteredAgentMock.mockResolvedValue({
			agentId: "agent-1",
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

it.each([true, false])(
	"capability fetch uses guarded transport for isExternal=%s",
	async (isExternal) => {
		redisGetMock.mockResolvedValue(null);
		getRegisteredAgentByAgentIdMock.mockResolvedValue(null);
		getAgentCardMock.mockResolvedValue({ name: "Live" });
		endpointFromRegisteredAgentMock.mockReturnValue({
			deploymentUrl: "https://agent.example.com",
			isExternal,
		} as never);
		const result = await getAgentCapabilities("agent-1", "user-1");
		expect(result).not.toBeNull();
		expect(getAgentCardMock).toHaveBeenCalledWith(
			isExternal ? fetchAgentEndpointMock : undefined,
			"https://agent.example.com",
		);
	},
);

afterEach(() => vi.unstubAllEnvs());

it("returns null without fetching or caching a card when the stored endpoint is refused", async () => {
	vi.stubEnv("AGENT_DISCOVERY_ALLOWED_HOSTS", "");
	redisGetMock.mockResolvedValue(null);
	resolveVisibleRegisteredAgentMock.mockResolvedValue({
		agentId: "agent-1",
		deploymentUrl: "http://169.254.169.254/",
	});
	endpointFromRegisteredAgentMock.mockReturnValue({
		deploymentUrl: "http://169.254.169.254/",
		isExternal: true,
	} as never);
	// Make the unguarded path succeed so null cannot come from a mock failure.
	getAgentCardMock.mockResolvedValue({ name: "Refused endpoint" });

	const result = await getAgentCapabilities("agent-1", "user-1");

	expect.soft(result).toBeNull();
	expect.soft(getAgentCardMock).not.toHaveBeenCalled();
	expect.soft(updateAgentCardCacheMock).not.toHaveBeenCalled();
	expect.soft(redisSetMock).not.toHaveBeenCalled();
});

describe("resolved registration cache identity", () => {
	it("isolates same-name stored cards across tenants and L1 hits", async () => {
		const cardA = { tags: ["org-a-card"] };
		const cardB = { tags: ["org-b-card"] };
		const row = (organizationId: string) => ({
			agentId: `agent-${organizationId}`,
			name: "agent-x",
			metadata: {
				agentCard: organizationId === "org-a" ? cardA : cardB,
				agentCardCachedAt: new Date().toISOString(),
			},
		});
		resolveVisibleRegisteredAgentMock.mockImplementation(
			async (_key, _user, org) => row(org),
		);
		getRegisteredAgentByAgentIdMock.mockImplementation(async () =>
			row("org-a"),
		);
		redisGetMock.mockResolvedValue(null);
		const a = await getAgentCapabilities("agent-x", "user-a", "org-a");
		const b = await getAgentCapabilities("agent-x", "user-b", "org-b");
		expect.soft(a?.tags).toEqual(cardA.tags);
		expect.soft(b?.tags).toEqual(cardB.tags);
		expect
			.soft(
				(await getAgentCapabilities("agent-x", "user-a", "org-a"))
					?.tags,
			)
			.toEqual(cardA.tags);
		expect
			.soft(
				(await getAgentCapabilities("agent-x", "user-b", "org-b"))
					?.tags,
			)
			.toEqual(cardB.tags);
		expect
			.soft(redisGetMock.mock.calls)
			.toEqual([["agentcard:agent-org-a"], ["agentcard:agent-org-b"]]);
		expect
			.soft(redisSetMock.mock.calls.map(([key]) => key))
			.toEqual(["agentcard:agent-org-a", "agentcard:agent-org-b"]);
		expect.soft(getRegisteredAgentByAgentIdMock).not.toHaveBeenCalled();
	});

	it("rejects an invisible agentId before reading any card cache", async () => {
		resolveVisibleRegisteredAgentMock.mockResolvedValue(null);
		redisGetMock.mockResolvedValue({ tags: ["private-card"] });
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: {
				agentCard: { tags: ["private-card"] },
				agentCardCachedAt: new Date().toISOString(),
			},
		});
		expect
			.soft(await getAgentCapabilities("agent-hidden", "user-a", "org-a"))
			.toBeNull();
		expect.soft(redisGetMock).not.toHaveBeenCalled();
		expect.soft(getRegisteredAgentByAgentIdMock).not.toHaveBeenCalled();
		expect.soft(getAgentCardMock).not.toHaveBeenCalled();
	});

	it("writes a live card under the resolved agentId rather than the lookup name", async () => {
		resolveVisibleRegisteredAgentMock.mockResolvedValue({
			agentId: "agent-resolved",
			metadata: {},
		});
		redisGetMock.mockResolvedValue(null);
		getAgentCardMock.mockResolvedValue({ name: "Live" });
		expect(
			await getAgentCapabilities("agent-x", "user-a", "org-a"),
		).not.toBeNull();
		expect(updateAgentCardCacheMock).toHaveBeenCalledWith(
			"agent-resolved",
			{ name: "Live" },
			expect.any(Date),
		);
	});
});

it.each(["redis", "database"])(
	"returns a fresh %s card for a visible registration with no endpoint",
	async (layer) => {
		resolveVisibleRegisteredAgentMock.mockResolvedValue({
			agentId: "agent-1",
			status: "INACTIVE",
			deploymentUrl: null,
			metadata: {
				agentCard: { tags: ["cached"] },
				agentCardCachedAt: new Date().toISOString(),
			},
		});
		endpointFromRegisteredAgentMock.mockReturnValue(null);
		redisGetMock.mockResolvedValue(
			layer === "redis" ? { tags: ["cached"] } : null,
		);
		expect(
			(await getAgentCapabilities("agent-x", "user-a", "org-a"))?.tags,
		).toEqual(["cached"]);
		expect(endpointFromRegisteredAgentMock).not.toHaveBeenCalled();
		expect(getAgentCardMock).not.toHaveBeenCalled();
	},
);

it("rechecks visibility before serving an L1 card", async () => {
	redisGetMock.mockResolvedValue({ tags: ["cached"] });
	expect(
		await getAgentCapabilities("agent-x", "user-a", "org-a"),
	).not.toBeNull();
	resolveVisibleRegisteredAgentMock.mockResolvedValue(null);
	expect(await getAgentCapabilities("agent-x", "user-a", "org-a")).toBeNull();
	expect(redisGetMock).toHaveBeenCalledTimes(1);
});

it("returns null when a visible registration has neither a fresh card nor an endpoint", async () => {
	redisGetMock.mockResolvedValue(null);
	endpointFromRegisteredAgentMock.mockReturnValue(null);
	expect(await getAgentCapabilities("agent-x", "user-a", "org-a")).toBeNull();
	expect(getAgentCardMock).not.toHaveBeenCalled();
});
