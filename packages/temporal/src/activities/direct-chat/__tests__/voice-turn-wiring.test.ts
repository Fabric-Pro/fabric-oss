/**
 * Runs the real `executeDirectChatActivity` up to its `streamText` call and
 * asserts on the request it builds for a spoken turn (feature key "parlume")
 * against an ordinary chat turn: the OpenAI reasoning effort, the skipped
 * prompt enhancer, and the timings it reports. Same boundaries mocked as
 * `system-prompt-wiring.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";
import { TurnTimings, withTurnTimings } from "../../shared/turn-timing";

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
vi.mock("../../shared/agent-tool-runtime", () => ({
	agentToolAbortSignal: () => undefined,
	hasExactAgentToolApproval: vi.fn(),
	observeAgentText: vi.fn(),
	prepareAgentTools: async () => undefined,
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

type Captured = { providerOptions?: unknown; maxOutputTokens?: number };

async function runTurn(overrides: Partial<DirectChatWorkflowInput> = {}) {
	state.captured = undefined;
	const timings = new TurnTimings();
	await withTurnTimings(timings, () =>
		executeDirectChatActivity(
			{
				executionId: "exec-1",
				message: "What is the plan?",
				history: [],
				userId: "user-1",
				organizationId: "org-1",
				reasoningMode: "balanced",
				...overrides,
			} as DirectChatWorkflowInput,
			[],
			"",
			"",
		),
	);
	expect(state.captured).toBeDefined();
	return { request: state.captured as Captured, timings: timings.snapshot() };
}

beforeEach(() => {
	state.provider = "VERCEL_GATEWAY";
	state.modelString = "openai/gpt-6-luna";
	state.enhance.mockClear();
});

describe("direct chat: a spoken turn", () => {
	it("asks the OpenAI reasoning model for the least reasoning it accepts", async () => {
		const { request } = await runTurn({ featureKey: "parlume" });
		expect(request.providerOptions).toEqual({
			openai: { reasoningEffort: "low" },
		});
	});

	it("does so even when the agent saved a deep reasoning mode", async () => {
		const { request } = await runTurn({
			featureKey: "parlume",
			reasoningMode: "pro",
		});
		expect(request.providerOptions).toEqual({
			openai: { reasoningEffort: "low" },
		});
	});

	it("skips the Fabric prompt enhancer", async () => {
		const { timings } = await runTurn({ featureKey: "parlume" });
		expect(state.enhance).not.toHaveBeenCalled();
		expect(timings.values["direct.enhancerMs"]).toBe(0);
	});

	it("does not mistake a reasoning-effort option for Anthropic thinking", async () => {
		const { request } = await runTurn({ featureKey: "parlume" });
		expect(request.maxOutputTokens).toBeUndefined();
	});

	it("reports where its time went", async () => {
		const { timings } = await runTurn({ featureKey: "parlume" });
		expect(Object.keys(timings.values).sort()).toEqual(
			[
				"direct.enhancerMs",
				"direct.modelResolveMs",
				"direct.preLlmMs",
				"llm.cachedInputTokens",
				"llm.firstTextMs",
				"llm.inputTokens",
				"llm.outputTokens",
				"llm.reasoningTokens",
				"llm.toolCalls",
				"llm.totalMs",
			].sort(),
		);
		expect(timings.values["llm.reasoningTokens"]).toBe(12);
		expect(timings.values["llm.cachedInputTokens"]).toBe(8_000);
		expect(timings.values["llm.firstTextMs"]).toBeLessThanOrEqual(
			timings.values["llm.totalMs"] + 1,
		);
	});
});

describe("direct chat: an ordinary turn", () => {
	it.each([undefined, "chat-agent"] as const)(
		"with feature key %s is enhanced and carries no provider options",
		async (featureKey) => {
			const { request, timings } = await runTurn({ featureKey });
			expect(state.enhance).toHaveBeenCalledTimes(1);
			expect(request.providerOptions).toBeUndefined();
			expect(timings.values["direct.enhancerMs"]).toBeGreaterThanOrEqual(
				0,
			);
		},
	);
});
