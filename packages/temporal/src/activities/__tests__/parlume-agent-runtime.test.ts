import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeAgent, loadParlumeAgent } from "../parlume-agent";

const mocks = vi.hoisted(() => ({
	preferences: vi.fn(),
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
	it("never gives the Fabric Agent the inviter's external servers or workspaces in a meeting", async () => {
		mocks.preferences.mockResolvedValue({
			enabledMcpConfigIds: ["selected-server"],
			enabledWorkspaceIds: ["workspace"],
		});

		const agent = await loadParlumeAgent(session);
		await executeParlumeAgent({
			agent,
			session,
			turnId: "turn",
			message: "Question",
			voiceInstructions: "Voice",
			knowledgeContext: "Project",
			history: [],
		});

		expect(agent).toMatchObject({
			enabledMcpConfigIds: [],
			workspaceIds: [],
		});
		expect(mocks.workspaces).not.toHaveBeenCalled();
		expect(mocks.connections).not.toHaveBeenCalled();
		expect(mocks.mcp).toHaveBeenCalledWith("user", "org", []);
		expect(mocks.builtin).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledMcpConfigIds: [],
				workspaceIds: [],
			}),
			[],
			"",
			"",
		);
	});
	it.each(["deep", "planner"])(
		"honors saved %s reasoning",
		async (reasoningMode) => {
			mocks.preferences.mockResolvedValue({ reasoningMode });

			const agent = await loadParlumeAgent(session);

			expect(agent).toMatchObject({ reasoningMode: "pro" });
		},
	);
	it.each([
		["no saved preferences", null],
		["an empty saved selection", { enabledMcpConfigIds: [] }],
	])(
		"reaches no external MCP server with %s, as the chat does for that user",
		async (_name, saved) => {
			mocks.preferences.mockResolvedValue(saved);

			const agent = await loadParlumeAgent(session);

			expect(agent).toMatchObject({
				enabledMcpConfigIds: [],
				reasoningMode: "balanced",
			});
		},
	);
	it("recalls no memory for a meeting turn", async () => {
		const agent = await loadParlumeAgent(session);

		await executeParlumeAgent({
			agent,
			session,
			turnId: "turn",
			message: "Question",
			voiceInstructions: "",
			knowledgeContext: "",
			history: [],
		});

		expect(mocks.memory).not.toHaveBeenCalled();
		expect(mocks.builtin.mock.calls[0]?.[2]).toBe("");
	});
	it("hands an explicit empty server list, not an unset one, to the chat engine", async () => {
		const agent = await loadParlumeAgent(session);
		await executeParlumeAgent({
			agent,
			session,
			turnId: "turn",
			message: "Question",
			voiceInstructions: "",
			knowledgeContext: "",
			history: [],
		});
		expect(mocks.mcp).toHaveBeenCalledWith("user", "org", []);
		expect(mocks.builtin).toHaveBeenCalledWith(
			expect.objectContaining({ enabledMcpConfigIds: [] }),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});
	it("gives the Fabric Agent turn Fabric's platform tools as the inviter, with the turn's grant", async () => {
		const agent = await loadParlumeAgent(session);
		await executeParlumeAgent({
			agent,
			session,
			turnId: "turn",
			message: "Create a work item",
			voiceInstructions: "",
			knowledgeContext: "",
			history: [],
			actingGrant: "grant-for-this-turn",
		});
		expect(mocks.builtin).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user",
				organizationId: "org",
				projectId: "project",
				fabricPlatformTools: true,
				actingGrant: "grant-for-this-turn",
				additionalFabricToolIds: ["fabric_create_story"],
			}),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		expect(mocks.builtin.mock.calls[0]?.[0]).not.toHaveProperty(
			"enabledFabricToolIds",
		);
	});
	it("gives a project agent that has not opted in no external servers, integrations or workspaces in a meeting", async () => {
		const customSession = {
			...session,
			agentKind: "TEMPLATE_INSTANCE" as const,
			agentInstanceSId: "stable-agent",
		};
		const instance = {
			id: "current-version",
			name: "Current",
			description: "Current instructions",
			template: { id: "template" },
			customInstructions: {},
			modelOverride: null,
			modelConfig: {},
			toolConnections: { "project-context": { projectId: "project" } },
			workspaceIds: ["workspace"],
			mcpServerConfigurations: [{ mcpConfigId: "server" }],
			integrationConfigurations: [
				{
					integrationId: "integration",
					integrationType: "github",
					allowedResources: [],
				},
			],
		};
		mocks.instance.mockResolvedValue({
			...instance,
			meetingExternalTools: false,
		});
		mocks.workspaces.mockResolvedValue({
			allowed: ["workspace"],
			dropped: [],
		});
		// What the built context finds in the agent's legacy tool connections.
		mocks.context.mockResolvedValue({
			projectId: "project",
			agentInstanceId: "current-version",
			systemPrompt: "Current instructions",
			mcpConfigIds: ["legacy-server"],
			integrationConfigurations: [{ integrationId: "integration" }],
			builtInToolNames: [],
			model: "model",
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
		});

		expect(mocks.workspaces).not.toHaveBeenCalled();
		expect(mocks.context).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({
					mcpConfigIds: [],
					integrationConfigurations: [],
					workspaceIds: [],
				}),
			}),
		);
		expect(mocks.custom).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigIds: [],
				integrationConfigurations: [],
				workspaceIds: [],
			}),
		);

		mocks.instance.mockResolvedValue({
			...instance,
			meetingExternalTools: true,
		});
		const optedIn = await loadParlumeAgent(customSession);
		expect(optedIn.revision).not.toBe(agent.revision);
		expect(optedIn).toMatchObject({
			config: { mcpConfigIds: ["server"], workspaceIds: ["workspace"] },
		});
	});
	it("reloads the current active custom version and forwards its complete canonical tool configuration when it opts in", async () => {
		const customSession = {
			...session,
			agentKind: "TEMPLATE_INSTANCE" as const,
			agentInstanceSId: "stable-agent",
		};
		mocks.instance.mockResolvedValue({
			meetingExternalTools: true,
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
			builtInToolNames: ["future-builtin", "agent-memory"],
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
		// The agent's memory is neither loaded into the prompt nor offered as a
		// tool on a meeting turn.
		expect(mocks.context).toHaveBeenCalledWith(
			expect.objectContaining({ loadAgentMemory: false }),
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

it.each([
	{ kind: "harness_finite" },
	{ kind: "harness_persistent" },
	{ kind: "unknown" },
	{ kind: "native", artifact: { digest: "invalid" } },
])(
	"does not run an unavailable implementation natively through a project-bound Parlume session: %j",
	async (portableImplementation) => {
		mocks.instance.mockResolvedValue({
			id: "example-version",
			toolConnections: {
				"project-context": { projectId: session.projectId },
			},
			customInstructions: { portableImplementation },
		});
		await expect(
			loadParlumeAgent({
				...session,
				agentKind: "TEMPLATE_INSTANCE",
				agentInstanceSId: "example-stable-agent",
			}),
		).rejects.toThrow("implementation is unavailable");
		expect(mocks.workspaces).not.toHaveBeenCalled();
		expect(mocks.custom).not.toHaveBeenCalled();
		expect(mocks.builtin).not.toHaveBeenCalled();
	},
);
