/**
 * The plan-step MCP tool loop puts a rolling Anthropic cache breakpoint on
 * each step's request, and only for models that take it (Fizzy #3094).
 *
 * Boundaries mocked: the AI SDK and model lookup, so the real
 * `McpToolHandler.executeWithTools` runs and the `streamText` request is
 * captured.
 */

import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	streamText: vi.fn(),
	getAiModelWithSelection: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	generateText: vi.fn(),
	isStepCount: vi.fn(),
	NoSuchToolError: class NoSuchToolError extends Error {},
	streamText: (...a: unknown[]) => mocks.streamText(...a),
	tool: (definition: unknown) => definition,
}));
vi.mock("@repo/mcp", () => ({
	invalidateMcpClientCache: vi.fn(),
	OAuthAuthorizationRequiredError: class OAuthAuthorizationRequiredError extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../utils", () => ({
	getAiModel: vi.fn(),
	getAiModelWithSelection: (...a: unknown[]) =>
		mocks.getAiModelWithSelection(...a),
	getToolLearningContext: vi.fn(() => ""),
	recordFailedToolCall: vi.fn(),
	recordSuccessfulToolCall: vi.fn(),
}));
vi.mock("../../../utils/partykit-publisher", () => ({
	publishStepProgress: vi.fn(),
	publishToolComplete: vi.fn(),
	publishToolInput: vi.fn(),
	publishToolStart: vi.fn(),
}));
vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(),
}));
vi.mock("../../../planning/operation-risk-detector", () => ({
	validateToolsForDestructivePatterns: vi.fn(),
}));
vi.mock("../../context/tool-loader", () => ({ loadMcpTools: vi.fn() }));

import { McpToolHandler } from "../mcp-tool-handler";

type PrepareStep = (options: { messages: ModelMessage[] }) => {
	messages?: ModelMessage[];
};

const STOP = new Error("captured streamText request");

async function capturePrepareStep(
	provider: string,
	modelString: string,
): Promise<PrepareStep> {
	mocks.getAiModelWithSelection.mockResolvedValue({
		model: { id: modelString },
		provider,
		modelString,
	});
	const handler = new McpToolHandler();
	await expect(
		(
			handler as unknown as {
				executeWithTools: (...args: unknown[]) => Promise<unknown>;
			}
		).executeWithTools(
			{
				userId: "user-1",
				organizationId: "org-1",
				step: { id: "step-1", description: "List the open cards" },
			},
			{},
			{},
			{ maxSteps: 5, systemPrompt: "SYSTEM", stepPrompt: "STEP" },
			[],
			{},
			null,
			undefined,
		),
	).rejects.toBe(STOP);
	return mocks.streamText.mock.calls[0][0].prepareStep as PrepareStep;
}

// Step 2's input: the step-1 prompt plus one tool round.
const stepTwoMessages: ModelMessage[] = [
	{ role: "user", content: "STEP" },
	{
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "list",
				input: {},
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "c1",
				toolName: "list",
				output: { type: "text", value: "[]" },
			},
		],
	},
];

describe("MCP tool step prompt cache", () => {
	beforeEach(() => {
		mocks.streamText.mockReset();
		mocks.streamText.mockImplementation(() => {
			throw STOP;
		});
		mocks.getAiModelWithSelection.mockReset();
	});

	it.each([
		["ANTHROPIC_DIRECT", "claude-haiku-5-5"],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-5-5"],
	])("marks the last message of step 2 for %s", async (provider, model) => {
		const prepareStep = await capturePrepareStep(provider, model);
		const { messages } = prepareStep({ messages: stepTwoMessages });
		expect(messages?.at(-1)?.providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
		expect(
			messages?.slice(0, -1).some((m) => m.providerOptions !== undefined),
		).toBe(false);
	});

	it.each([
		["OPENAI", "gpt-6.1"],
		["AWS_BEDROCK", "anthropic.claude-sonnet-5-5"],
		["VERCEL_GATEWAY", "openai/gpt-6.1"],
	])("adds no breakpoint for %s %s", async (provider, model) => {
		const prepareStep = await capturePrepareStep(provider, model);
		const { messages } = prepareStep({ messages: stepTwoMessages });
		for (const message of messages ?? stepTwoMessages) {
			expect(message.providerOptions).toBeUndefined();
		}
	});
});
