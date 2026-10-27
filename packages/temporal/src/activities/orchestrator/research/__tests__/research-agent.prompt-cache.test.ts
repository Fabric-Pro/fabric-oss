/**
 * The research agent's tool loop puts a rolling Anthropic cache breakpoint on
 * each step, only for models that take one (Fizzy #3098).
 *
 * Boundaries mocked: the AI SDK, model lookup and tool building, so the real
 * `executeResearchAgent` runs and the `generateText` request is captured.
 */

import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	getAiModelWithSelection: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateText: (...a: unknown[]) => mocks.generateText(...a),
	isStepCount: vi.fn(),
}));
vi.mock("../../utils", () => ({
	getAiModelWithSelection: (...a: unknown[]) =>
		mocks.getAiModelWithSelection(...a),
}));
vi.mock("../research-tools", () => ({
	buildResearchTools: vi.fn(async () => ({ webSearch: {} })),
}));

import { executeResearchAgent } from "../research-agent";

type PrepareStep = (options: { messages: ModelMessage[] }) => {
	messages?: ModelMessage[];
};

const STOP = new Error("captured generateText request");

const stepTwoMessages: ModelMessage[] = [
	{ role: "user", content: "PROMPT" },
	{
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "webSearch",
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
				toolName: "webSearch",
				output: { type: "text", value: "[]" },
			},
		],
	},
];

async function capturePrepareStep(provider: string, modelString: string) {
	mocks.getAiModelWithSelection.mockResolvedValue({
		model: { id: modelString },
		provider,
		modelString,
	});
	await executeResearchAgent({
		researchQueries: ["q"],
		informationNeeds: [],
		originalTask: "task",
		userId: "user-1",
		organizationId: "org-1",
		availableTools: [],
		availableAgents: [],
	}).catch(() => undefined);
	return mocks.generateText.mock.calls[0][0].prepareStep as
		| PrepareStep
		| undefined;
}

describe("research agent prompt cache", () => {
	beforeEach(() => {
		mocks.generateText.mockReset();
		mocks.generateText.mockImplementation(() => {
			throw STOP;
		});
		mocks.getAiModelWithSelection.mockReset();
	});

	it("selects the tool-calling model for the call", async () => {
		await capturePrepareStep("ANTHROPIC_DIRECT", "claude-haiku-5-5");
		expect(mocks.getAiModelWithSelection).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			true,
			undefined,
			undefined,
			{ callPurpose: "research" },
		);
	});

	it("puts exactly one breakpoint on the last message on Anthropic", async () => {
		const prepareStep = await capturePrepareStep(
			"ANTHROPIC_DIRECT",
			"claude-haiku-5-5",
		);
		const { messages } = prepareStep?.({ messages: stepTwoMessages }) ?? {};
		expect(messages?.at(-1)?.providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
		expect(
			messages?.filter((m) => m.providerOptions !== undefined),
		).toHaveLength(1);
	});

	it("adds no breakpoint on a provider that does not take one", async () => {
		const prepareStep = await capturePrepareStep("OPENAI", "gpt-6.1");
		expect(prepareStep).toBeUndefined();
	});
});
