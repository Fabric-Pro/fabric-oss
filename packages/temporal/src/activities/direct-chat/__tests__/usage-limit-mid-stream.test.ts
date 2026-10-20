/**
 * A HARD usage limit reached partway through a direct chat turn.
 *
 * The resolved model checks the limits before each step's request, so a
 * multi-step turn can be refused after it started. Runs the real
 * `executeDirectChatActivity` and the real AI SDK `streamText` loop over a
 * mock provider model wrapped in the real per-request check, and pins the
 * activity's half of the contract:
 *  - text already streamed is kept: the turn succeeds (so the workflow does
 *    not rerun it without tools), with the limit as `partialError` and the
 *    structured `usageLimit` the route turns into its limit event;
 *  - a turn refused before any text fails with the limit as its `error` and
 *    the same `usageLimit` (the workflow skips the tools-off rerun for it),
 *    also when the refusal came inside the SDK's `RetryError`;
 *  - a refusal at model resolution is still thrown, unwrapped, as before.
 *
 * Boundaries mocked as in system-prompt-wiring.test.ts: model resolution,
 * the database, tool factories and the shared agent-tool runtime.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";

const state = vi.hoisted(() => ({
	model: undefined as unknown,
	resolutionError: undefined as Error | undefined,
	builtInTools: {} as Record<string, unknown>,
	recordAggregateUsage: vi.fn(),
}));

vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: vi.fn(),
	getMcpClient: vi.fn(),
}));
vi.mock("@repo/ai", async () => {
	const ai = await vi.importActual<typeof import("ai")>("ai");
	const usageLogging = await vi.importActual<
		typeof import("@repo/ai/lib/usage-logging-middleware")
	>("@repo/ai/lib/usage-logging-middleware");
	return {
		convertToModelMessages: async (
			messages: Array<{
				role: string;
				parts: Array<{ text: string }>;
			}>,
		) =>
			messages.map((m) => ({
				role: m.role,
				content: m.parts.map((p) => p.text).join(""),
			})),
		enhancePromptWithFabric: async () => ({ fabricUsed: false }),
		getAIModelWithMetadata: async () => {
			if (state.resolutionError) {
				throw state.resolutionError;
			}
			return {
				model: state.model,
				metadata: {
					provider: "OPENAI",
					modelString: "gpt-test",
					canonicalName: "gpt-test",
					contextWindow: 200_000,
					selectionSource: "test",
				},
				trackUsage: vi.fn(),
				recordAggregateUsage: state.recordAggregateUsage,
			};
		},
		getCurrentDateContext: () => "Today is October 8, 2026.",
		isStepCount: ai.isStepCount,
		selectAggregateUsageForLogging:
			usageLogging.selectAggregateUsageForLogging,
		streamText: ai.streamText,
		tool: ai.tool,
	};
});
vi.mock("@repo/ai/capabilities", () => ({
	DEFAULT_MODEL_CAPABILITIES: {},
	getModelCapabilities: () => ({}),
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: () => null }));
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
	createBuiltInTools: async () => state.builtInTools,
}));
vi.mock("../advisor-tools", () => ({
	createAdvisorTools: () => ({}),
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

import { wrapModelWithUsageLimits } from "@repo/ai/lib/usage-limit-middleware";
import { APICallError, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { executeDirectChatActivity } from "../ai-execution";

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** Step 1 of a tool turn: optional text, then a call to `lookup`. */
function firstStep(text: string | null) {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start" as const, warnings: [] },
				...(text
					? [
							{ type: "text-start" as const, id: "t1" },
							{
								type: "text-delta" as const,
								id: "t1",
								delta: text,
							},
							{ type: "text-end" as const, id: "t1" },
						]
					: []),
				{
					type: "tool-call" as const,
					toolCallId: "call-1",
					toolName: "lookup",
					input: "{}",
				},
				{
					type: "finish" as const,
					finishReason: {
						unified: "tool-calls" as const,
						raw: undefined,
					},
					usage: USAGE,
				},
			],
		}),
	};
}

function limitError() {
	return new AiUsageLimitExceededError({
		message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
		limitId: "limit-1",
		dimension: "TOKENS" as never,
		window: "MONTHLY" as never,
		used: BigInt(100),
		max: BigInt(100),
		manageLimitsUrl: "https://example.com/limits",
	});
}

/** A provider model whose limit check passes `allowed` times, then refuses. */
function useModel(
	provider: MockLanguageModelV4,
	allowed: number,
	refusal: Error,
) {
	let remaining = allowed;
	state.model = wrapModelWithUsageLimits(
		provider as unknown as LanguageModel,
		async () => {
			if (remaining <= 0) {
				throw refusal;
			}
			remaining -= 1;
		},
	);
}

/** Step 1's provider usage, as the ledger row and the turn result carry it. */
const STEP_ONE_SPEND = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function expectStepOneSpend(result: { usage?: unknown }) {
	expect(state.recordAggregateUsage).toHaveBeenCalledTimes(1);
	expect(state.recordAggregateUsage).toHaveBeenCalledWith(
		expect.objectContaining({
			success: false,
			usage: expect.objectContaining(STEP_ONE_SPEND),
		}),
	);
	expect(result.usage).toMatchObject(STEP_ONE_SPEND);
}

function runTurn() {
	return executeDirectChatActivity(
		{
			executionId: "exec-1",
			message: "What is on the roadmap?",
			history: [],
			userId: "user-1",
			organizationId: "org-1",
			reasoningMode: "balanced",
		} as DirectChatWorkflowInput,
		[],
		"",
		"",
	);
}

beforeEach(() => {
	state.resolutionError = undefined;
	state.recordAggregateUsage.mockReset();
	state.builtInTools = {
		lookup: tool({
			inputSchema: z.object({}),
			execute: async () => ({ found: true }),
		}),
	};
});

describe("direct chat — a usage limit reached during the turn", () => {
	it("keeps the streamed answer and carries the limit when a later step is refused", async () => {
		const refusal = limitError();
		const provider = new MockLanguageModelV4({
			doStream: async () => firstStep("Here is the first part."),
		});
		useModel(provider, 1, refusal);

		const result = await runTurn();

		expect(provider.doStreamCalls).toHaveLength(1);
		expect(result).toMatchObject({
			success: true,
			responseText: "Here is the first part.",
			partialError: refusal.message,
			usageLimit: {
				message: refusal.message,
				limitId: "limit-1",
				dimension: "TOKENS",
				window: "MONTHLY",
				used: "100",
				max: "100",
				manageLimitsUrl: "https://example.com/limits",
			},
		});
		// Survives the workflow result's JSON round trip unchanged.
		expect(JSON.parse(JSON.stringify(result.usageLimit))).toEqual(
			result.usageLimit,
		);
		expect(result).not.toHaveProperty("limitSignal");
		// Step 1's actual spend is recorded once and returned, not an
		// estimate and not zero.
		expectStepOneSpend(result);
	});

	it("fails the turn with the limit when nothing was answered before the refusal", async () => {
		const refusal = limitError();
		const provider = new MockLanguageModelV4({
			doStream: async () => firstStep(null),
		});
		useModel(provider, 1, refusal);

		const result = await runTurn();

		expect(provider.doStreamCalls).toHaveLength(1);
		expect(result).toMatchObject({
			success: false,
			error: refusal.message,
			usageLimit: { limitId: "limit-1", used: "100", max: "100" },
		});
		// Step 1's actual spend is recorded once and returned, never zero.
		expectStepOneSpend(result);
	});

	it("fails the turn with the limit when it refused an SDK retry of the first step", async () => {
		const refusal = limitError();
		const provider = new MockLanguageModelV4({
			doStream: async () => {
				throw new APICallError({
					message: "provider overloaded",
					url: "https://provider.example.com/v1",
					requestBodyValues: {},
					statusCode: 503,
					isRetryable: true,
				});
			},
		});
		useModel(provider, 1, refusal);

		const result = await runTurn();

		expect(provider.doStreamCalls).toHaveLength(1);
		expect(result).toMatchObject({
			success: false,
			error: refusal.message,
			usageLimit: { limitId: "limit-1", used: "100", max: "100" },
		});
	});

	it("still throws a refusal at model resolution, unwrapped", async () => {
		const refusal = limitError();
		state.resolutionError = refusal;

		await expect(runTurn()).rejects.toBe(refusal);
	});
});

describe("direct chat — provider error after Anthropic message_start", () => {
	it.each([false, true])(
		"retains measured spend with an earlier completed step: %s",
		async (completedFirstStep) => {
			let call = 0;
			const provider = new MockLanguageModelV4({
				doStream: async () => {
					if (completedFirstStep && call++ === 0) {
						return firstStep("First step.");
					}
					return {
						stream: simulateReadableStream({
							chunks: [
								{ type: "stream-start" as const, warnings: [] },
								{
									type: "custom" as const,
									kind: "anthropic.message_start",
									providerMetadata: {
										anthropic: {
											usage: {
												input_tokens: 100,
												cache_read_input_tokens: 70,
												cache_creation_input_tokens: 20,
												output_tokens: 2,
											},
										},
									},
								},
								{
									type: "text-start" as const,
									id: "example-text",
								},
								{
									type: "text-delta" as const,
									id: "example-text",
									delta: "Partial answer.",
								},
								{
									type: "error" as const,
									error: new Error("Provider stream failed"),
								},
							],
						}),
					};
				},
			});
			state.model = provider;
			const result = await runTurn();
			expect(provider.doStreamCalls).toHaveLength(
				completedFirstStep ? 2 : 1,
			);
			expect(result).toMatchObject({
				partialError: "Provider stream failed",
			});
			expect(state.recordAggregateUsage).toHaveBeenCalledTimes(1);
			const row = state.recordAggregateUsage.mock.calls[0][0];
			expect(row).toMatchObject({
				success: false,
				usage: {
					inputTokens: completedFirstStep ? 200 : 190,
					outputTokens: completedFirstStep ? 7 : 2,
					totalTokens: completedFirstStep ? 207 : 192,
					inputTokenDetails: {
						cacheReadTokens: 70,
						cacheWriteTokens: 20,
					},
				},
				errorDetails: { usageReportedAt: "stream_start" },
			});
			expect(result.usage).toMatchObject({
				inputTokens: row.usage.inputTokens,
				outputTokens: row.usage.outputTokens,
				totalTokens: row.usage.totalTokens,
				cachedInputTokens: 70,
				cacheCreationInputTokens: 20,
			});
			expect(row.steps).toHaveLength(completedFirstStep ? 2 : 1);
		},
	);
});
