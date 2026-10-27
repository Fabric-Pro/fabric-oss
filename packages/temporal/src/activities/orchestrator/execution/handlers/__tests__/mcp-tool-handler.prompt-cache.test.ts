/**
 * The plan-step MCP tool loop puts a rolling Anthropic cache breakpoint on
 * each step's request, and only for models that take it (Fizzy #3094).
 *
 * Boundaries mocked: the AI SDK and model lookup, so the real
 * `McpToolHandler.executeWithTools` runs and the `streamText` request is
 * captured.
 */

import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import { createUsageLoggingMiddleware } from "@repo/ai/lib/usage-logging-middleware";
import type { ModelMessage } from "ai";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	streamText: vi.fn(),
	getAiModelWithSelection: vi.fn(),
	getAiModel: vi.fn(),
	generateObject: vi.fn(),
	generateText: vi.fn(),
	repairPurpose: undefined as string | undefined,
	rows: vi.fn(),
}));

vi.mock("@repo/database", () => ({ logAiUsageAsync: mocks.rows }));
vi.mock("@repo/ai", () => ({
	generateObject: (...args: unknown[]) => {
		mocks.repairPurpose = currentAiCallPurpose();
		return mocks.generateObject(...args);
	},
	generateText: (...args: unknown[]) => mocks.generateText(...args),
	isStepCount: vi.fn(),
	NoSuchToolError: class NoSuchToolError extends Error {
		static isInstance() {
			return false;
		}
	},
	streamText: (...a: unknown[]) => mocks.streamText(...a),
	tool: (definition: unknown) => definition,
}));
vi.mock("@repo/mcp", () => ({
	invalidateMcpClientCache: vi.fn(),
	isClosedClientRefusedBeforeSend: () => false,
	OAuthAuthorizationRequiredError: class OAuthAuthorizationRequiredError extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../utils", () => ({
	getAiModel: (...args: unknown[]) => mocks.getAiModel(...args),
	getAiModelWithSelection: (...a: unknown[]) =>
		mocks.getAiModelWithSelection(...a),
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
	model: unknown = { id: modelString },
): Promise<PrepareStep> {
	mocks.streamText.mockClear();
	mocks.getAiModelWithSelection.mockClear();
	mocks.getAiModelWithSelection.mockResolvedValue({
		model,
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

it("labels tool-handler generation and repair on its reused model", async () => {
	await capturePrepareStep("VERCEL_GATEWAY", "example-model");
	expect(mocks.getAiModelWithSelection.mock.calls[0][5]).not.toHaveProperty(
		"callPurpose",
	);
	mocks.generateObject.mockResolvedValue({ object: { query: "example" } });
	const repair = mocks.streamText.mock.calls[0][0].repairToolCall;
	const result = await repair({
		toolCall: { toolName: "example_search", input: "{}" },
		tools: { example_search: { inputSchema: {} } },
		inputSchema: () => ({}),
		error: new Error("invalid input"),
	});
	expect(result.input).toBe('{"query":"example"}');
	expect(mocks.repairPurpose).toBe("tool-argument-repair");
});

it("labels the no-tools fallback generation", async () => {
	mocks.getAiModel.mockResolvedValue({});
	mocks.generateText.mockResolvedValue({ text: "Example answer" });
	const handler = new McpToolHandler() as any;
	await handler.executeWithoutTools(
		{
			userId: "example-user",
			organizationId: "example-org",
			step: { description: "Summarize notes" },
		},
		{ systemPrompt: "Summarize" },
		null,
		undefined,
	);
	expect(mocks.getAiModel.mock.calls[0][5]).toMatchObject({
		callPurpose: "handler-fallback",
	});
});

it("request scopes distinguish tool-handler generation from repair on one model", async () => {
	mocks.rows.mockClear();
	const model = wrapLanguageModel({
		model: new MockLanguageModelV4({
			doGenerate: async () => ({
				content: [{ type: "text", text: "example" }],
				finishReason: { unified: "stop", raw: "stop" },
				warnings: [],
				usage: {
					inputTokens: {
						total: 1,
						noCache: 1,
						cacheRead: 0,
						cacheWrite: 0,
					},
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
			}),
		}),
		middleware: createUsageLoggingMiddleware({
			provider: "VERCEL_GATEWAY",
			providerModelId: "example-model",
		}),
	});
	await capturePrepareStep("VERCEL_GATEWAY", "example-model", model);
	const options = mocks.streamText.mock.calls[0][0];
	await runWithAiCallPurpose("compaction", async () => {
		await options.model.doGenerate({ prompt: [] });
		mocks.generateObject.mockImplementationOnce(async ({ model }) => {
			await model.doGenerate({ prompt: [] });
			return { object: { query: "example" } };
		});
		await options.repairToolCall({
			toolCall: { toolName: "example_search", input: "{}" },
			tools: { example_search: { inputSchema: {} } },
			inputSchema: () => ({}),
			error: new Error("invalid input"),
		});
	});
	expect(mocks.rows.mock.calls.map(([row]) => row.callPurpose)).toEqual([
		"tool-handler-generation",
		"tool-argument-repair",
	]);
});
