/**
 * Deep-research sub-agent and direct-research tool loops put a rolling
 * Anthropic cache breakpoint on each step, only for models that take one and
 * only when search tools are passed (Fizzy #3098).
 *
 * Boundaries mocked: the AI SDK, model lookup, MCP config lookup and RAG, so
 * the real executors run and the `generateText` request is captured.
 */

import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	getAiModelWithSelection: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateText: (...a: unknown[]) => mocks.generateText(...a),
	getAIModelWithMetadata: (...a: unknown[]) =>
		mocks.getAIModelWithMetadata(...a),
	isStepCount: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { mCPConfig: { findMany: (...a: unknown[]) => mocks.findMany(...a) } },
}));
vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn(async () => ({
		client: { tools: async () => ({ web_search: { description: "s" } }) },
	})),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));
vi.mock("../../orchestrator/utils/model-selector", () => ({
	getAiModelWithSelection: (...a: unknown[]) =>
		mocks.getAiModelWithSelection(...a),
}));

import { executeDirectResearch, executeSubAgent } from "../execution";

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

const subTask = {
	id: "t1",
	title: "T",
	description: "D",
	focusArea: "F",
	expectedOutput: "E",
} as never;

const runners = {
	executeSubAgent: () =>
		executeSubAgent({
			subTask,
			parentQuery: "Q",
			userId: "user-1",
			organizationId: "org-1",
			iteration: 1,
		}),
	executeDirectResearch: () =>
		executeDirectResearch({
			query: "Q",
			userId: "user-1",
			organizationId: "org-1",
		} as never),
};

async function capture(
	run: () => Promise<unknown>,
	provider: string,
	modelString: string,
	withSearch: boolean,
) {
	mocks.findMany.mockResolvedValue(
		withSearch ? [{ id: "cfg", displayName: "Brave Search" }] : [],
	);
	mocks.getAiModelWithSelection.mockResolvedValue({
		model: { id: modelString },
		provider,
		modelString,
	});
	await run().catch(() => undefined);
	return mocks.generateText.mock.calls[0][0] as {
		prepareStep?: PrepareStep;
	};
}

describe.each(Object.entries(runners))("%s prompt cache", (_name, run) => {
	beforeEach(() => {
		mocks.generateText.mockReset();
		mocks.generateText.mockImplementation(() => {
			throw STOP;
		});
		mocks.getAiModelWithSelection.mockReset();
		mocks.findMany.mockReset();
	});

	it("resolves deep research through the shared selector without a purpose", async () => {
		const actual = await vi.importActual<
			typeof import("../../orchestrator/utils/model-selector")
		>("../../orchestrator/utils/model-selector");
		mocks.getAiModelWithSelection.mockImplementation(
			actual.getAiModelWithSelection,
		);
		mocks.getAIModelWithMetadata.mockReset().mockResolvedValue({
			model: {},
			metadata: { provider: "OPENAI", modelString: "example-model" },
			trackUsage: vi.fn(),
		});
		mocks.findMany.mockResolvedValue([]);
		await run().catch(() => undefined);
		expect(mocks.generateText).toHaveBeenCalledOnce();
		expect(
			mocks.getAIModelWithMetadata.mock.calls[0][1].callPurpose,
		).toBeUndefined();
	});

	it("keeps the hard-coded task type when selecting the model", async () => {
		await capture(run, "ANTHROPIC_DIRECT", "claude-haiku-5-5", true);
		expect(mocks.getAiModelWithSelection).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			false,
		);
	});

	it("puts exactly one breakpoint on the last message with search tools on Anthropic", async () => {
		const call = await capture(
			run,
			"ANTHROPIC_DIRECT",
			"claude-haiku-5-5",
			true,
		);
		const { messages } =
			call.prepareStep?.({ messages: stepTwoMessages }) ?? {};
		expect(messages?.at(-1)?.providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
		expect(
			messages?.filter((m) => m.providerOptions !== undefined),
		).toHaveLength(1);
	});

	it("adds no breakpoint on a provider that does not take one", async () => {
		const call = await capture(run, "OPENAI", "gpt-6.1", true);
		expect(call.prepareStep).toBeUndefined();
	});

	it("passes no tools and no prepareStep when there are no search tools", async () => {
		const call = await capture(
			run,
			"ANTHROPIC_DIRECT",
			"claude-haiku-5-5",
			false,
		);
		expect((call as { tools?: unknown }).tools).toBeUndefined();
		expect(call.prepareStep).toBeUndefined();
	});
});
