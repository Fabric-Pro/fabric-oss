import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAgentsWithEmbeddings: vi.fn() }));
vi.mock("@repo/database", () => ({
	getAgentsWithEmbeddings: mocks.getAgentsWithEmbeddings,
	updateAgentEmbedding: vi.fn(),
}));
vi.mock("../capability-embeddings", () => ({ cosineSimilarity: vi.fn() }));
vi.mock("@repo/ai", () => ({ getSystemEmbeddingRAGProviderConfig: vi.fn() }));
vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(),
}));
vi.mock("../../../../lib/redis-cache", () => ({
	CacheKeys: {},
	CacheTTL: {},
	RedisCache: {},
}));

import { searchAvailableAgents } from "../search-agents";

afterEach(() => vi.restoreAllMocks());

describe("agent search enabled-list diagnostics", () => {
	const twoAgents = [
		{ agentId: "example-agent-a" },
		{ agentId: "example-agent-b" },
	];
	it.each([
		{ agents: twoAgents, enabledAgentIds: [] },
		{ agents: twoAgents, enabledAgentIds: ["example-other-agent"] },
		// Only the self ID is enabled, so the list removed every agent search
		// could have offered.
		{
			agents: [{ agentId: "example-agent" }, { agentId: "fabric-ai" }],
			enabledAgentIds: ["fabric-ai"],
		},
	])(
		"logs when the enabled list allows none of the loaded agents: %j",
		async ({ agents, enabledAgentIds }) => {
			mocks.getAgentsWithEmbeddings.mockResolvedValue(agents);
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const result = await searchAvailableAgents({
				query: "example",
				userId: "example-user",
				enabledAgentIds,
			});
			expect(result.results).toEqual([]);
			expect(
				log.mock.calls.filter(([line]) =>
					String(line).includes("enabled list allowed none"),
				),
			).toEqual([
				[
					`[SearchAgents] Loaded ${agents.length} agents; enabled list allowed none (length: ${enabledAgentIds.length})`,
				],
			]);
		},
	);

	it.each([
		{ agents: [], enabledAgentIds: [] },
		{
			agents: [{ agentId: "fabric-workspace-assistant" }],
			enabledAgentIds: ["fabric-workspace-assistant"],
		},
		{ agents: [{ agentId: "fabric-ai" }], enabledAgentIds: ["fabric-ai"] },
		{ agents: [{ agentId: "fabric-ai" }], enabledAgentIds: [] },
	])(
		"does not blame the enabled list for empty DB or self filtering: %j",
		async ({ agents, enabledAgentIds }) => {
			mocks.getAgentsWithEmbeddings.mockResolvedValue(agents);
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			await searchAvailableAgents({
				query: "example",
				userId: "example-user",
				enabledAgentIds,
			});
			expect(
				log.mock.calls
					.flat()
					.filter((line) =>
						String(line).includes("enabled list allowed none"),
					),
			).toEqual([]);
		},
	);
});
