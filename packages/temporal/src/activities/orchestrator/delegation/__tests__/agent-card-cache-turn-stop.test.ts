/**
 * Inside an Advisor chat turn that stops while an agent's card is being
 * fetched, the card is not written to the database cache afterwards.
 *
 * `getAgentCapabilities` runs for real with the real `updateAgentCardCache`
 * query helper (and the metadata merge under it); only the Prisma client,
 * the A2A fetch, the endpoint lookup and Redis are faked. The turn's stop
 * latches while the card GET is in flight, after every caller-side check.
 * The check that holds is the query helper's own, synchronously before its
 * `$executeRaw`. The cache write is fire-and-forget, so its rejection is
 * logged and nothing is written.
 */

import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	stopped: false,
	executeRaw: vi.fn(),
	getAgentCard: vi.fn(),
	getRegisteredAgentByAgentId: vi.fn(),
}));

vi.mock("../../../../../../database/prisma/client", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../../../../database/prisma/client")
		>();
	return { ...actual, db: { $executeRaw: h.executeRaw } };
});

vi.mock("@repo/database", async () => {
	const queries = await import(
		"../../../../../../database/prisma/queries/registered-agents"
	);
	return {
		getRegisteredAgentByAgentId: h.getRegisteredAgentByAgentId,
		updateAgentCardCache: queries.updateAgentCardCache,
	};
});

vi.mock("@repo/agent-core", () => ({
	A2AClient: class {
		getAgentCard(...args: unknown[]) {
			return h.getAgentCard(...args);
		}
	},
}));

vi.mock("../resolve-endpoint", () => ({
	resolveAgentEndpoint: vi.fn().mockResolvedValue({
		deploymentUrl: "https://agent.example.com",
	}),
}));

vi.mock("../../../../lib/redis-cache", () => ({
	RedisCache: {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
	},
	CacheKeys: { agentCard: (agentId: string) => `agentcard:${agentId}` },
	CacheTTL: { agentCard: 1800 },
}));

const { clearCapabilityCache, getAgentCapabilities } = await import(
	"../agent-capabilities"
);

const STOP = new Error("the chat turn stopped");

const guard: DispatchGuard = {
	key: "turn-example-1",
	assertDispatchable: async () => undefined,
	abortSignal: () => undefined,
	rethrowIfStopped: (error) => {
		if (error === STOP) {
			throw error;
		}
	},
	throwIfStopped: () => {
		if (h.stopped) {
			throw STOP;
		}
	},
};

/** Lets the fire-and-forget cache write run to where it sends or refuses. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	h.stopped = false;
	h.executeRaw.mockReset().mockResolvedValue(1);
	h.getRegisteredAgentByAgentId.mockReset().mockResolvedValue(null);
	h.getAgentCard.mockReset().mockImplementation(async () => {
		await Promise.resolve();
		return { name: "Example agent", capabilities: {} };
	});
	clearCapabilityCache();
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the agent-card database cache inside a chat turn", () => {
	it("writes the fetched card when nothing stops the turn", async () => {
		const result = await runWithDispatchGuard(guard, () =>
			getAgentCapabilities("agent-example-1", "user-example-1"),
		);
		await settle();
		expect(result).not.toBeNull();
		expect(h.executeRaw).toHaveBeenCalledTimes(1);
	});

	it("issues no UPDATE when the turn stops while the card is fetched", async () => {
		h.getAgentCard.mockImplementation(async () => {
			await Promise.resolve();
			h.stopped = true;
			return { name: "Example agent", capabilities: {} };
		});
		await runWithDispatchGuard(guard, () =>
			getAgentCapabilities("agent-example-1", "user-example-1"),
		);
		await settle();
		expect(h.executeRaw).not.toHaveBeenCalled();
	});

	it("writes as before outside any chat turn", async () => {
		h.stopped = true; // no guard is active, so nothing consults this
		await getAgentCapabilities("agent-example-1", "user-example-1");
		await settle();
		expect(h.executeRaw).toHaveBeenCalledTimes(1);
	});
});
