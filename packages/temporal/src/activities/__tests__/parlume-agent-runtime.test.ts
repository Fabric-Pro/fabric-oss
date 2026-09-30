import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeAgent, loadParlumeAgent } from "../parlume-agent";

const mocks = vi.hoisted(() => ({
	preferences: vi.fn(),
	defaults: vi.fn(),
	instance: vi.fn(),
	workspaces: vi.fn(),
	context: vi.fn(),
	knowledge: vi.fn(),
	custom: vi.fn(),
	builtin: vi.fn(),
	mcp: vi.fn(),
	memory: vi.fn(),
	workspaceKnowledge: vi.fn(),
	connections: vi.fn(),
	integrations: vi.fn(),
}));
vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: mocks.defaults,
}));
vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: { findFirst: mocks.instance },
		mCPConfig: { findMany: mocks.connections },
		workflowIntegration: { findMany: mocks.integrations },
	},
	getOrchestratorPreferences: mocks.preferences,
	filterWorkspaceIdsForTenant: mocks.workspaces,
	getBuiltInToolConfig: (tools: Record<string, unknown>, key: string) =>
		tools[key],
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

const session = {
	id: "session",
	agentKind: "FABRIC_AGENT" as const,
	agentInstanceSId: null,
	projectId: "project",
	organizationId: "org",
	userId: "user",
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.defaults.mockResolvedValue(["default-server"]);
	mocks.preferences.mockResolvedValue(null);
	mocks.workspaces.mockResolvedValue({ allowed: [], dropped: [] });
	mocks.connections.mockResolvedValue([]);
	mocks.integrations.mockResolvedValue([]);
	mocks.mcp.mockResolvedValue({ mcpToolInfo: [] });
	mocks.builtin.mockResolvedValue({ success: true, responseText: "Answer" });
	mocks.memory.mockResolvedValue({ context: "Agent memory" });
	mocks.workspaceKnowledge.mockResolvedValue({
		context: "Workspace knowledge",
	});
});
describe("Parlume canonical agent adapters", () => {
	it("invalidates a proposal when the same connection points at a different destination", async () => {
		mocks.preferences.mockResolvedValue({
			enabledMcpConfigIds: ["server"],
			enabledWorkspaceIds: [],
		});
		mocks.connections.mockResolvedValue([
			{ id: "server", baseUrl: "https://first.example" },
		]);
		const before = await loadParlumeAgent(session);
		mocks.connections.mockResolvedValue([
			{ id: "server", baseUrl: "https://second.example" },
		]);
		const after = await loadParlumeAgent(session);
		expect(after.revision).not.toBe(before.revision);
		expect(mocks.connections).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: { in: ["server", "default-server"] },
					userId: "user",
					organizationId: "org",
				},
			}),
		);
	});
	it.each(["deep", "planner"])(
		"honors saved %s reasoning and connected workspace preferences",
		async (reasoningMode) => {
			mocks.preferences.mockResolvedValue({
				reasoningMode,
				enabledMcpConfigIds: ["selected-server"],
				enabledWorkspaceIds: ["workspace", "other-tenant"],
			});
			mocks.workspaces.mockResolvedValue({
				allowed: ["workspace"],
				dropped: ["other-tenant"],
			});
			const agent = await loadParlumeAgent(session);
			expect(agent).toMatchObject({
				reasoningMode: "pro",
				enabledMcpConfigIds: ["selected-server", "default-server"],
				workspaceIds: ["workspace"],
			});
			await executeParlumeAgent({
				agent,
				session,
				turnId: "turn",
				message: "Question",
				voiceInstructions: "Voice",
				knowledgeContext: "Project",
				history: [],
				confirmation: false,
			});
			expect(mocks.builtin).toHaveBeenCalledWith(
				expect.objectContaining({
					reasoningMode: "pro",
					workspaceIds: ["workspace"],
					ragContext: "Project\n\nWorkspace knowledge",
				}),
				[],
				"Agent memory",
				"",
			);
		},
	);
	it("preserves the canonical empty tool preference instead of enabling arbitrary servers", async () => {
		expect(await loadParlumeAgent(session)).toMatchObject({
			enabledMcpConfigIds: [],
			reasoningMode: "balanced",
		});
	});
	it("loads no knowledge or memory for an exact confirmation", async () => {
		const agent = await loadParlumeAgent(session);
		await executeParlumeAgent({
			agent,
			session,
			turnId: "turn",
			message: "confirm",
			voiceInstructions: "",
			knowledgeContext: "",
			history: [],
			confirmation: true,
		});
		expect(mocks.memory).not.toHaveBeenCalled();
		expect(mocks.workspaceKnowledge).not.toHaveBeenCalled();
	});
	it("reloads the current active custom version and forwards its complete canonical tool configuration", async () => {
		const customSession = {
			...session,
			agentKind: "TEMPLATE_INSTANCE" as const,
			agentInstanceSId: "stable-agent",
		};
		mocks.instance.mockResolvedValue({
			id: "current-version",
			name: "Current",
			description: "Current instructions",
			template: { id: "template" },
			customInstructions: {},
			modelOverride: "selected-model",
			modelConfig: {},
			toolConnections: { "project-context": { projectId: "project" } },
			workspaceIds: [],
			mcpServerConfigurations: [{ mcpConfigId: "server" }],
			integrationConfigurations: [
				{
					integrationId: "integration",
					integrationType: "github",
					allowedResources: [],
				},
			],
		});
		mocks.context.mockResolvedValue({
			projectId: "project",
			agentInstanceId: "current-version",
			systemPrompt: "Current instructions",
			mcpConfigIds: ["server"],
			integrationConfigurations: [{ integrationId: "integration" }],
			builtInToolNames: ["future-builtin"],
			model: "selected-model",
		});
		mocks.knowledge.mockResolvedValue({ chunks: [] });
		mocks.custom.mockResolvedValue({ success: true, response: "Done" });
		const agent = await loadParlumeAgent(customSession);
		await executeParlumeAgent({
			agent,
			session: customSession,
			turnId: "turn",
			message: "Question",
			voiceInstructions: "Voice",
			knowledgeContext: "Project",
			history: [],
			confirmation: false,
		});
		expect(mocks.instance).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					sId: "stable-agent",
					userId: "user",
					organizationId: "org",
					status: "ACTIVE",
				},
				orderBy: { version: "desc" },
			}),
		);
		expect(mocks.custom).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigIds: ["server"],
				integrationConfigurations: [{ integrationId: "integration" }],
				builtInToolNames: ["future-builtin"],
				model: "selected-model",
				systemPrompt: "Current instructions\n\nVoice",
			}),
		);
	});
});
