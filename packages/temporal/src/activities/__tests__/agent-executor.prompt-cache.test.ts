/**
 * `executeAgentTurn` and `previewAgentTurn` put a rolling Anthropic cache
 * breakpoint on each tool-loop step, only for models that take one and only
 * when tools are passed (Fizzy #3098).
 *
 * Boundaries mocked: the AI SDK stream, model lookup and the database, so the
 * real executors run and the `streamText` request is captured.
 */

import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	streamText: vi.fn(),
	getAiModelWithSelection: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
}));

vi.mock("@repo/ai", async (original) => ({
	...(await original<typeof import("@repo/ai")>()),
	streamText: (...a: unknown[]) => mocks.streamText(...a),
	getAIModelWithMetadata: (...a: unknown[]) =>
		mocks.getAIModelWithMetadata(...a),
}));
vi.mock("@temporalio/activity", async (original) => ({
	...(await original<typeof import("@temporalio/activity")>()),
	Context: {
		current: () => ({ cancellationSignal: new AbortController().signal }),
	},
	heartbeat: vi.fn(),
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	canCreateProjectStory: vi.fn(async () => false),
	loadProjectDatabricksKnowledgeBinding: async () => null,
}));
vi.mock("../orchestrator/utils/model-selector", () => ({
	getAiModel: vi.fn(),
	getAiModelWithSelection: (...a: unknown[]) =>
		mocks.getAiModelWithSelection(...a),
}));

import {
	executeAgentTurn,
	previewAgentTurn,
} from "../agent-execution-core/agent-executor";

type PrepareStep = (options: { messages: ModelMessage[] }) => {
	messages?: ModelMessage[];
};

const STOP = new Error("captured streamText request");

const stepTwoMessages: ModelMessage[] = [
	{ role: "user", content: "PROMPT" },
	{
		role: "assistant",
		content: [
			{ type: "tool-call", toolCallId: "c1", toolName: "t", input: {} },
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "c1",
				toolName: "t",
				output: { type: "text", value: "[]" },
			},
		],
	},
];

const turnInput = {
	systemPrompt: "Agent",
	userMessage: "Create a ticket",
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project",
};

const runners = {
	executeAgentTurn: (extra: Record<string, unknown>) =>
		executeAgentTurn({ ...turnInput, ...extra } as never),
	previewAgentTurn: (extra: Record<string, unknown>) =>
		previewAgentTurn({
			systemPrompt: "Agent",
			userMessage: "Hi",
			userId: "user-1",
			organizationId: "org-1",
			...extra,
		} as never),
};

async function capture(
	run: (extra: Record<string, unknown>) => Promise<unknown>,
	provider: string,
	modelString: string,
	extra: Record<string, unknown>,
) {
	mocks.getAiModelWithSelection.mockResolvedValue({
		model: { id: modelString },
		provider,
		modelString,
	});
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { id: modelString },
		metadata: { provider, modelString },
	});
	await run(extra).catch(() => undefined);
	return mocks.streamText.mock.calls[0][0] as {
		prepareStep?: PrepareStep;
		tools?: unknown;
	};
}

const withTools = { builtInToolNames: ["create-story"] };

describe.each(Object.entries(runners))("%s prompt cache", (_name, run) => {
	beforeEach(() => {
		mocks.streamText.mockReset();
		mocks.streamText.mockImplementation(() => {
			throw STOP;
		});
		mocks.getAiModelWithSelection.mockReset();
		mocks.getAIModelWithMetadata.mockReset();
	});

	it.each([
		["selected", {}],
		["overridden", { model: "claude-haiku-5-5" }],
	])(
		"puts exactly one breakpoint on the last message with tools on Anthropic (%s model)",
		async (_label, extra) => {
			const call = await capture(
				run,
				"ANTHROPIC_DIRECT",
				"claude-haiku-5-5",
				{ ...withTools, ...extra },
			);
			expect(call.tools).toBeDefined();
			const { messages } =
				call.prepareStep?.({ messages: stepTwoMessages }) ?? {};
			expect(messages?.at(-1)?.providerOptions).toEqual({
				anthropic: { cacheControl: { type: "ephemeral" } },
			});
			expect(
				messages?.filter((m) => m.providerOptions !== undefined),
			).toHaveLength(1);
		},
	);

	it("adds no breakpoint on a provider that does not take one", async () => {
		const call = await capture(run, "OPENAI", "gpt-6.1", withTools);
		expect(call.prepareStep).toBeUndefined();
	});
});

describe("executeAgentTurn without tools", () => {
	it.each([undefined, "example-model"])(
		"preserves workflow attribution with model %s",
		async (model) => {
			mocks.streamText.mockReset();
			mocks.getAiModelWithSelection.mockReset();
			mocks.getAIModelWithMetadata.mockReset();
			mocks.streamText.mockImplementation(() => {
				throw STOP;
			});
			await capture(runners.executeAgentTurn, "OPENAI", "example-model", {
				model,
				workflowExecutionId: "execution-1",
				promptVersionId: "prompt-1",
				featureKey: "scheduled-agent-task",
				jobType: "workflow-builder",
			});
			const context = model
				? mocks.getAIModelWithMetadata.mock.calls[0][1]
				: mocks.getAiModelWithSelection.mock.calls[0][5];
			expect(context).toMatchObject({
				workflowExecutionId: "execution-1",
				promptVersionId: "prompt-1",
				featureKey: "scheduled-agent-task",
			});
			if (model) {
				expect(context.jobType).toBe("workflow-builder");
			} else {
				expect(mocks.getAiModelWithSelection.mock.calls[0][4]).toBe(
					"workflow-builder",
				);
			}
		},
	);

	it("passes no tools, so no cache breakpoint is requested", async () => {
		mocks.streamText.mockReset();
		mocks.streamText.mockImplementation(() => {
			throw STOP;
		});
		const call = await capture(
			runners.executeAgentTurn,
			"ANTHROPIC_DIRECT",
			"claude-haiku-5-5",
			{ projectId: undefined },
		);
		expect(call.tools).toBeUndefined();
		expect(call.prepareStep).toBeUndefined();
	});
});
