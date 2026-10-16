/**
 * A tool the Parlume runtime adds (`AgentToolRuntime.tools`) reaches the
 * model on the built-in agent's engine, and its calls go through the runtime.
 * The real agent-tool-runtime is used here; the other boundaries are mocked as
 * in `voice-turn-wiring.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";
import { withAgentToolRuntime } from "../../shared/agent-tool-runtime";

const state = vi.hoisted(() => ({
	captured: undefined as unknown,
	provider: "VERCEL_GATEWAY",
	modelString: "openai/gpt-6-luna",
	enhance: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: vi.fn(),
	getMcpClient: vi.fn(),
}));
vi.mock("@repo/ai", () => {
	state.enhance = vi.fn(async () => ({ fabricUsed: false }));
	return {
		convertToModelMessages: async (
			messages: Array<{ role: string; parts: Array<{ text: string }> }>,
		) =>
			messages.map((m) => ({
				role: m.role,
				content: m.parts.map((p) => p.text).join(""),
			})),
		enhancePromptWithFabric: state.enhance,
		getAIModelWithMetadata: async () => ({
			model: { id: "test-model" },
			metadata: {
				provider: state.provider,
				modelString: state.modelString,
				canonicalName: state.modelString,
				contextWindow: 200_000,
				selectionSource: "test",
			},
			trackUsage: vi.fn(),
			recordAggregateUsage: vi.fn(),
		}),
		getCurrentDateContext: () => "Today is October 2, 2026.",
		isStepCount: (n: number) => n,
		selectAggregateUsageForLogging: () => undefined,
		streamText: (request: unknown) => {
			state.captured = request;
			return {
				stream: (async function* () {
					yield { type: "text-delta", text: "Hello" };
				})(),
				usage: Promise.resolve({
					inputTokens: 9_000,
					outputTokens: 40,
					totalTokens: 9_040,
					inputTokenDetails: { cacheReadTokens: 8_000 },
					outputTokenDetails: { reasoningTokens: 12 },
				}),
				steps: Promise.resolve([]),
			};
		},
		tool: (definition: unknown) => definition,
	};
});
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
vi.mock("../built-in-tools", () => ({ createBuiltInTools: async () => ({}) }));
vi.mock("../advisor-tools", () => ({
	createAdvisorTools: () => ({ list_recent_sessions: {} }),
}));
vi.mock("../../orchestrator/utils", () => ({ jsonSchemaToZod: vi.fn() }));
vi.mock("../../orchestrator/execution/authority-gate", () => ({
	classifyToolAccessLevel: vi.fn(),
	resolveProviderKey: vi.fn(),
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

import { executeDirectChatActivity } from "../ai-execution";

type Tools = Record<
	string,
	{ description?: string; execute: (args: unknown) => Promise<unknown> }
>;

async function runTurn(runtime?: Parameters<typeof withAgentToolRuntime>[0]) {
	state.captured = undefined;
	const run = () =>
		executeDirectChatActivity(
			{
				executionId: "exec-1",
				message: "Post the link",
				history: [],
				userId: "user-1",
				organizationId: "org-1",
				reasoningMode: "balanced",
				featureKey: "parlume",
			} as DirectChatWorkflowInput,
			[],
			"",
			"",
		);
	await (runtime ? withAgentToolRuntime(runtime, run) : run());
	return (state.captured as { tools?: Tools }).tools;
}

beforeEach(() => {
	state.provider = "VERCEL_GATEWAY";
	state.modelString = "openai/gpt-6-luna";
});

describe("direct chat: a tool the runtime adds", () => {
	it("is offered to the model, and its calls go through the runtime under the runtime's source", async () => {
		const invoke = vi.fn(async () => ({ posted: true }));

		const tools = await runTurn({
			invoke,
			tools: {
				post_to_meeting_chat: {
					description: "Post to the chat",
					inputSchema: {},
					execute: vi.fn(),
				},
			},
		});

		expect(Object.keys(tools ?? {})).toContain("post_to_meeting_chat");
		await expect(
			tools?.post_to_meeting_chat.execute({ text: "Hello" }),
		).resolves.toEqual({ posted: true });
		expect(invoke).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "post_to_meeting_chat",
				args: { text: "Hello" },
				source: {
					configId: "parlume",
					originalName: "post_to_meeting_chat",
				},
			}),
		);
	});

	it("keeps the agent's own tools, wrapped as before", async () => {
		const invoke = vi.fn(async () => ({}));

		const tools = await runTurn({
			invoke,
			tools: {
				post_to_meeting_chat: { inputSchema: {}, execute: vi.fn() },
			},
		});

		expect(Object.keys(tools ?? {})).toEqual(
			expect.arrayContaining(["post_to_meeting_chat", "list_workflows"]),
		);
		await tools?.list_workflows.execute({});
		expect(invoke).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "list_workflows",
				source: { configId: "builtin", originalName: "list_workflows" },
			}),
		);
	});

	it("is absent from a turn with no runtime", async () => {
		const tools = await runTurn();

		expect(Object.keys(tools ?? {})).not.toContain("post_to_meeting_chat");
	});
});
