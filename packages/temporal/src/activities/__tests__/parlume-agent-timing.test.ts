import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeAgent } from "../parlume-agent";
import { TurnTimings, withTurnTimings } from "../shared/turn-timing";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	knowledge: vi.fn(),
	custom: vi.fn(),
	builtin: vi.fn(),
	mcp: vi.fn(),
	memory: vi.fn(),
	workspaceKnowledge: vi.fn(),
}));
vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {},
	getOrchestratorPreferences: vi.fn(),
	filterWorkspaceIdsForTenant: vi.fn(),
	getBuiltInToolConfig: vi.fn(),
}));
vi.mock("../agent-execution-core", () => ({
	executeAgentTurn: mocks.custom,
	buildKnowledgeContextPrompt: () => "Configured knowledge",
}));
vi.mock("../deployment-execution", () => ({
	buildExecutionContext: mocks.context,
	fetchKnowledge: mocks.knowledge,
}));
vi.mock("../direct-chat/ai-execution", () => ({
	executeDirectChatActivity: mocks.builtin,
}));
vi.mock("../direct-chat/mcp-tools", () => ({
	collectMcpToolsActivity: mocks.mcp,
}));
vi.mock("../direct-chat/memory-context", () => ({
	generateMemoryContextActivity: mocks.memory,
}));
vi.mock("../direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: mocks.workspaceKnowledge,
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const session = {
	id: "session",
	agentKind: "FABRIC_AGENT" as const,
	agentInstanceSId: null,
	projectId: "project",
	organizationId: "org",
	userId: "user",
};
const builtIn = {
	kind: "FABRIC_AGENT" as const,
	revision: "revision",
	enabledMcpConfigIds: [],
	reasoningMode: "balanced" as const,
	workspaceIds: [],
};
const input = {
	session,
	turnId: "turn",
	message: "Question",
	voiceInstructions: "Voice",
	knowledgeContext: "Project",
	history: [],
};

async function measure(run: () => Promise<unknown>) {
	const timings = new TurnTimings();
	await withTurnTimings(timings, run);
	return timings.snapshot().values;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.mcp.mockImplementation(async () => {
		await sleep(40);
		return { mcpToolInfo: [] };
	});
	mocks.memory.mockImplementation(async () => {
		await sleep(10);
		return { context: "Memory" };
	});
	mocks.workspaceKnowledge.mockImplementation(async () => {
		await sleep(10);
		return { context: "Workspace" };
	});
	mocks.builtin.mockResolvedValue({ success: true, responseText: "Answer" });
	mocks.custom.mockResolvedValue({ success: true, response: "Answer" });
});

describe("Parlume agent timing", () => {
	it("times the built-in agent's MCP collection, memory and workspace lookups and their total", async () => {
		const values = await measure(() =>
			executeParlumeAgent({
				...input,
				agent: builtIn,
			}),
		);
		expect(Object.keys(values).sort()).toEqual([
			"agent.gatherMs",
			"agent.mcpCollectMs",
			"agent.memoryMs",
			"agent.workspaceMs",
		]);
		expect(values["agent.mcpCollectMs"]).toBeGreaterThanOrEqual(35);
		expect(values["agent.gatherMs"]).toBeGreaterThanOrEqual(
			values["agent.mcpCollectMs"] - 2,
		);
		expect(values["agent.gatherMs"]).toBeLessThan(
			values["agent.mcpCollectMs"] +
				values["agent.memoryMs"] +
				values["agent.workspaceMs"],
		);
	});

	it("times a custom agent's context and knowledge lookups", async () => {
		mocks.context.mockImplementation(async () => {
			await sleep(10);
			return {
				projectId: "project",
				systemPrompt: "Agent",
				mcpConfigIds: [],
				integrationConfigurations: [],
				builtInToolNames: [],
			};
		});
		mocks.knowledge.mockResolvedValue({ chunks: [] });
		const values = await measure(() =>
			executeParlumeAgent({
				...input,
				agent: {
					kind: "TEMPLATE_INSTANCE",
					revision: "revision",
					config: { workspaceIds: [] },
				} as never,
			}),
		);
		expect(Object.keys(values).sort()).toEqual([
			"agent.buildContextMs",
			"agent.knowledgeMs",
		]);
	});

	it("runs unchanged when no turn is collecting timings", async () => {
		await expect(
			executeParlumeAgent({
				...input,
				agent: builtIn,
			}),
		).resolves.toEqual({
			success: true,
			response: "Answer",
			error: undefined,
		});
	});
});
