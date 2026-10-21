/**
 * Runs the real `executeDirectChatActivity` up to its `streamText` call and
 * asserts on the tools the model is given when the interactive chat takes its
 * workflow and frame tools from Fabric MCP:
 *
 *   - the in-process workflow tools (`list_workflows`, `get_workflow_details`,
 *     `execute_workflow`) are gone, and so is the in-process copy of any frame
 *     tool Fabric MCP offers;
 *   - the frame tools are offered on every turn, not only on an artifact or
 *     Workspace page;
 *   - when Fabric MCP cannot be loaded the workflow family is simply absent —
 *     there is no in-process fallback — while the in-process frame tools stay;
 *   - a caller that did not ask for Fabric MCP (a meeting, a mention reply)
 *     keeps the tools it always had and never touches the gateway;
 *   - a call the person approved runs once, first, and the model is told so;
 *   - the Fabric client is closed when the turn ends.
 *
 * Boundaries mocked as in `system-prompt-wiring.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";

const state = vi.hoisted(() => ({
	captured: undefined as unknown,
	builtInTools: {} as Record<string, unknown>,
	builtInOptions: undefined as unknown,
	preparedSources: undefined as unknown,
	fabric: null as null | {
		tools: Record<string, unknown>;
		runApproved: ReturnType<typeof import("vitest").vi.fn>;
		close: ReturnType<typeof import("vitest").vi.fn>;
	},
	loadFabricPlatformTools: undefined as unknown as ReturnType<
		typeof import("vitest").vi.fn
	>,
	modelResolutionError: undefined as Error | undefined,
	closeMcpClientSafe: undefined as unknown as ReturnType<
		typeof import("vitest").vi.fn
	>,
	getMcpClient: undefined as unknown as ReturnType<
		typeof import("vitest").vi.fn
	>,
}));

vi.mock("@repo/agent-core/backend", () => {
	state.closeMcpClientSafe = vi.fn();
	state.getMcpClient = vi.fn();
	return {
		closeMcpClientSafe: state.closeMcpClientSafe,
		getMcpClient: state.getMcpClient,
	};
});
vi.mock("@repo/ai", () => ({
	convertToModelMessages: async (
		messages: Array<{ role: string; parts: Array<{ text: string }> }>,
	) =>
		messages.map((m) => ({
			role: m.role,
			content: m.parts.map((p) => p.text).join(""),
		})),
	enhancePromptWithFabric: async () => ({ fabricUsed: false }),
	getAIModelWithMetadata: async () => {
		if (state.modelResolutionError) {
			throw state.modelResolutionError;
		}
		return {
			model: { id: "test-model" },
			metadata: {
				provider: "OPENAI",
				modelString: "gpt-test",
				canonicalName: "gpt-test",
				contextWindow: 200_000,
				selectionSource: "test",
			},
			trackUsage: vi.fn(),
			recordAggregateUsage: vi.fn(),
		};
	},
	getCurrentDateContext: () => "Today is October 2, 2026.",
	isStepCount: (n: number) => n,
	selectAggregateUsageForLogging: () => undefined,
	streamText: (request: unknown) => {
		state.captured = request;
		return {
			stream: (async function* () {})(),
			usage: Promise.resolve(undefined),
			steps: Promise.resolve([]),
		};
	},
	tool: (definition: unknown) => definition,
}));
vi.mock("@repo/ai/capabilities", () => ({
	DEFAULT_MODEL_CAPABILITIES: {},
	getModelCapabilities: () => ({}),
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: () => ({}) }));
vi.mock("@repo/ai/skills", () => ({
	buildSkillsSystemBlock: () => "",
	createSkillTools: () => ({}),
	listAvailableSkills: async () => [],
}));
vi.mock("@repo/database", () => ({
	ensureSensitiveOperationAuthority: vi.fn(),
	getDefaultRagSettings: () => ({ similarityThreshold: 0.5 }),
	getProjectRagSettings: vi.fn(),
	getWorkflowById: vi.fn(),
	listWorkflows: vi.fn(),
	loadProjectDatabricksKnowledgeBinding: async () => null,
}));
vi.mock("../../../lib/company-context-chat-access", () => ({
	resolveCompanyContextChatAccess: async () => null,
}));
vi.mock("../../../lib/company-context-search", () => ({
	searchCompanyContext: vi.fn(),
}));
vi.mock("../../shared/project-context-block", () => ({
	buildProjectContextBlock: async () => null,
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../built-in-tools", () => ({
	createBuiltInTools: async (options: unknown) => {
		state.builtInOptions = options;
		return { ...state.builtInTools };
	},
}));
vi.mock("../advisor-tools", () => ({
	createAdvisorTools: () => ({ list_recent_sessions: {} }),
}));
vi.mock("../../orchestrator/utils", () => ({ jsonSchemaToZod: vi.fn() }));
vi.mock("../../orchestrator/execution/authority-gate", () => ({
	classifyToolAccessLevel: vi.fn(),
	resolveProviderKey: vi.fn(),
}));
vi.mock("../../shared/agent-tool-runtime", () => ({
	agentToolAbortSignal: () => undefined,
	hasExactAgentToolApproval: vi.fn(),
	observeAgentText: vi.fn(),
	prepareAgentTools: async (_tools: unknown, sources: unknown) => {
		state.preparedSources = sources;
		return undefined;
	},
}));
vi.mock("../../shared/confirmed-workflow", () => ({
	executeApprovedWorkflow: vi.fn(),
}));
vi.mock("../../shared/databricks-knowledge", () => ({
	buildDatabricksKnowledgeToolDefinition: vi.fn(),
	databricksKnowledgeToolName: vi.fn(),
	executeDatabricksKnowledgeSearchSafe: vi.fn(),
	loadAgentDatabricksBindings: async () => [],
	mergeDatabricksBindings: () => [],
}));
vi.mock("../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(),
}));
vi.mock("../../shared/fabric-platform-mcp", () => {
	state.loadFabricPlatformTools = vi.fn(async () => state.fabric);
	return { loadFabricPlatformTools: state.loadFabricPlatformTools };
});

import { executeDirectChatActivity } from "../ai-execution";

type Captured = {
	instructions: unknown;
	messages: Array<{ role: string; content: unknown }>;
	tools?: Record<string, unknown>;
};

function toolNames(): string[] {
	return Object.keys((state.captured as Captured).tools ?? {}).sort();
}

function systemText(): string {
	const request = state.captured as Captured;
	const flatten = (entry: unknown): string => {
		if (typeof entry === "string") {
			return entry;
		}
		if (Array.isArray(entry)) {
			return entry.map(flatten).join("\n");
		}
		if (entry && typeof entry === "object" && "content" in entry) {
			return flatten((entry as { content: unknown }).content);
		}
		return "";
	};
	return [
		flatten(request.instructions),
		...request.messages
			.filter((message) => message.role === "system")
			.map(flatten),
	].join("\n");
}

async function runTurn(overrides: Partial<DirectChatWorkflowInput> = {}) {
	state.captured = undefined;
	await executeDirectChatActivity(
		{
			executionId: "exec-1",
			message: "Hello",
			history: [],
			userId: "user-1",
			organizationId: "org-1",
			reasoningMode: "balanced",
			fabricPlatformTools: true,
			actingGrant: "grant-from-the-web-route",
			...overrides,
		} as DirectChatWorkflowInput,
		[],
		"",
		"",
	);
	expect(state.captured).toBeDefined();
}

const IN_PROCESS_FRAME_TOOL = { description: "in-process frame tool" };
const FABRIC_FRAME_TOOL = { description: "gateway frame tool" };

beforeEach(() => {
	vi.clearAllMocks();
	state.modelResolutionError = undefined;
	state.builtInTools = { fabric_create_frame: IN_PROCESS_FRAME_TOOL };
	state.fabric = {
		tools: {
			fabric_list_workflows: {},
			fabric_create_workflow: {},
			fabric_create_frame: FABRIC_FRAME_TOOL,
		},
		runApproved: vi.fn().mockResolvedValue({ created: true }),
		close: vi.fn().mockResolvedValue(undefined),
	};
});

describe("the interactive chat takes its workflow tools from Fabric MCP", () => {
	it("offers Fabric MCP's tools and none of the in-process workflow tools", async () => {
		await runTurn();

		const names = toolNames();
		expect(names).toContain("fabric_list_workflows");
		expect(names).toContain("fabric_create_workflow");
		expect(names).not.toContain("list_workflows");
		expect(names).not.toContain("get_workflow_details");
		expect(names).not.toContain("execute_workflow");
	});

	it("lets Fabric MCP's tool replace the in-process one of the same name", async () => {
		await runTurn();

		expect((state.captured as Captured).tools?.fabric_create_frame).toBe(
			FABRIC_FRAME_TOOL,
		);
	});

	it("names Fabric's workflow tool, not the in-process one, in the capabilities", async () => {
		await runTurn();

		const text = systemText();
		expect(text).toContain("fabric_list_workflows");
		expect(text).not.toContain("plus list_workflows");
	});

	it("asks for the tools with the page, the person it acts for and the grant that vouches for the turn", async () => {
		await runTurn({
			projectId: "project-1",
			surface: "workspace",
			workspaceId: "workspace-1",
		});

		expect(state.loadFabricPlatformTools).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				actingGrant: "grant-from-the-web-route",
				projectId: "project-1",
				surface: "workspace",
				workspaceId: "workspace-1",
			}),
		);
	});

	it("asks for no portal tools on a chat turn, which holds no project grant", async () => {
		await runTurn({ message: "mark the task done" });

		expect(state.loadFabricPlatformTools).toHaveBeenCalledTimes(1);
		expect(state.loadFabricPlatformTools.mock.calls[0]).toHaveLength(1);
	});

	it("does not offer the portal schemas to a meeting turn that only asks a question", async () => {
		await runTurn({
			fabricPortalTools: true,
			message: "what's the status of F-12?",
		});

		expect(state.loadFabricPlatformTools).toHaveBeenCalledWith(
			expect.anything(),
			{ portal: { offer: false } },
		);
	});

	it("offers them, in that same turn, when the request asks for what they do", async () => {
		await runTurn({
			fabricPortalTools: true,
			message: "move F-12 to in review",
		});

		expect(state.loadFabricPlatformTools).toHaveBeenCalledWith(
			expect.anything(),
			{ portal: { offer: true } },
		);
	});

	it("counts the speaker's previous request, so a bare follow-up still gets them", async () => {
		await runTurn({
			fabricPortalTools: true,
			message: "yes, go ahead",
			history: [
				{ role: "user", content: "mark the task done" },
				{ role: "assistant", content: "Which task?" },
			],
		});

		expect(state.loadFabricPlatformTools).toHaveBeenCalledWith(
			expect.anything(),
			{ portal: { offer: true } },
		);
	});

	it("offers the frame tools on every turn: a page that is not an artifact or a Workspace asks for them just the same", async () => {
		await runTurn({ projectId: undefined, surface: undefined });

		expect(state.loadFabricPlatformTools).toHaveBeenCalledTimes(1);
		expect((state.captured as Captured).tools?.fabric_create_frame).toBe(
			FABRIC_FRAME_TOOL,
		);
	});

	it("carries no Fabric tools into a turn the web route gave no grant", async () => {
		await runTurn({ actingGrant: undefined });

		expect(state.loadFabricPlatformTools).not.toHaveBeenCalled();
		expect(toolNames()).not.toContain("fabric_create_workflow");
	});

	it("closes the Fabric client when the turn ends", async () => {
		await runTurn();

		expect(state.fabric?.close).toHaveBeenCalledTimes(1);
	});

	it("closes the MCP and Fabric clients when model resolution throws", async () => {
		const mcpClient = { tools: async () => ({}) };
		state.getMcpClient.mockResolvedValue({ client: mcpClient });
		state.modelResolutionError = new Error("No provider is configured");

		await expect(
			executeDirectChatActivity(
				{
					executionId: "exec-1",
					message: "Hello",
					history: [],
					userId: "user-1",
					organizationId: "org-1",
					reasoningMode: "balanced",
					fabricPlatformTools: true,
					actingGrant: "grant-from-the-web-route",
					enabledMcpConfigIds: ["config-1"],
				} as DirectChatWorkflowInput,
				[
					{
						configId: "config-1",
						serverName: "example-server",
						configName: "Example",
						tools: [{ name: "search" }],
					},
				],
				"",
				"",
			),
		).rejects.toThrow("No provider is configured");

		expect(state.getMcpClient).toHaveBeenCalledTimes(1);
		expect(state.closeMcpClientSafe).toHaveBeenCalledTimes(1);
		expect(state.closeMcpClientSafe).toHaveBeenCalledWith(mcpClient);
		expect(state.fabric?.close).toHaveBeenCalledTimes(1);
	});
});

describe("when Fabric MCP cannot be loaded", () => {
	beforeEach(() => {
		state.fabric = null;
	});

	it("leaves the workflow family absent, with no in-process fallback, and keeps the in-process frame tools", async () => {
		await runTurn();

		const names = toolNames();
		expect(names.filter((name) => /workflow/.test(name))).toEqual([]);
		expect((state.captured as Captured).tools?.fabric_create_frame).toBe(
			IN_PROCESS_FRAME_TOOL,
		);
	});
});

describe("a runtime that gates tools by their source", () => {
	it("is told Fabric MCP's tools come from the platform source Fabric's own approval is recorded under", async () => {
		await runTurn();

		expect(state.preparedSources).toMatchObject({
			fabric_create_workflow: {
				configId: "fabric-platform",
				originalName: "fabric_create_workflow",
			},
			fabric_list_workflows: {
				configId: "fabric-platform",
				originalName: "fabric_list_workflows",
			},
		});
	});

	it("is told nothing about a tool that did not come from Fabric MCP", async () => {
		await runTurn({ fabricPlatformTools: undefined });

		expect(state.preparedSources).not.toHaveProperty(
			"fabric_create_workflow",
		);
	});

	it("passes the caller's additional Fabric tools to the tool builder", async () => {
		await runTurn({ additionalFabricToolIds: ["fabric_create_story"] });

		expect(state.builtInOptions).toMatchObject({
			additionalFabricToolIds: ["fabric_create_story"],
		});
	});
});

describe("a caller that did not ask for Fabric MCP", () => {
	it("keeps the tools it always had and never touches the gateway", async () => {
		await runTurn({ fabricPlatformTools: undefined });

		const names = toolNames();
		expect(names).toEqual(
			expect.arrayContaining([
				"list_workflows",
				"get_workflow_details",
				"execute_workflow",
			]),
		);
		expect(names).not.toContain("fabric_create_workflow");
		expect(state.loadFabricPlatformTools).toHaveBeenCalledTimes(0);
	});
});

describe("a call the person approved", () => {
	const approvedToolCall = {
		toolName: "fabric_create_workflow",
		args: { preset: { name: "Weekly digest" } },
	};

	it("runs once, with the exact arguments, before the model answers", async () => {
		await runTurn({ approvedToolCall });

		expect(state.fabric?.runApproved).toHaveBeenCalledTimes(1);
		expect(state.fabric?.runApproved).toHaveBeenCalledWith(
			"fabric_create_workflow",
			approvedToolCall.args,
		);
		expect(systemText()).toContain("has already run");
	});

	it("is not run on a turn nobody approved", async () => {
		await runTurn();

		expect(state.fabric?.runApproved).not.toHaveBeenCalled();
	});
});
