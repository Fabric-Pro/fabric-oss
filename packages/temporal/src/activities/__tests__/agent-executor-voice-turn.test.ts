/**
 * The custom-agent engine (`executeAgentTurn`) is the second way a Parlume turn
 * is answered. A spoken turn must reach the model with the same minimal
 * reasoning effort as on the built-in engine, an ordinary turn must not, and
 * both engines report the same timing keys.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentTurn } from "../agent-execution-core/agent-executor";
import { withAgentToolRuntime } from "../shared/agent-tool-runtime";
import { TurnTimings, withTurnTimings } from "../shared/turn-timing";

const state = vi.hoisted(() => ({
	captured: undefined as unknown,
	provider: "VERCEL_GATEWAY",
	modelString: "openai/gpt-6-luna",
	overrideMetadata: vi.fn(),
	selection: vi.fn(),
}));

vi.mock("@repo/ai", async (original) => ({
	...(await original<typeof import("@repo/ai")>()),
	isStepCount: (count: number) => count,
	streamText: (request: unknown) => {
		state.captured = request;
		const chunk = (request as { onChunk?: (event: unknown) => void })
			.onChunk;
		const result = {
			text: Promise.resolve("Done."),
			usage: Promise.resolve({
				inputTokens: 5_000,
				outputTokens: 30,
				inputTokenDetails: { cacheReadTokens: 0 },
				outputTokenDetails: { reasoningTokens: 7 },
			}),
		};
		chunk?.({ chunk: { type: "text-delta", text: "Done." } });
		return Object.assign(Promise.resolve(result), result);
	},
	getAIModelWithMetadata: state.overrideMetadata,
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	loadProjectDatabricksKnowledgeBinding: async () => null,
}));
vi.mock("../orchestrator/utils/model-selector", () => ({
	getAiModel: async () => ({ id: "model" }),
	getAiModelWithSelection: state.selection,
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ cancellationSignal: undefined }) },
	heartbeat: vi.fn(),
}));

type Captured = { providerOptions?: unknown };

async function run(featureKey: string | undefined, model?: string) {
	state.captured = undefined;
	const timings = new TurnTimings();
	const result = await withTurnTimings(timings, () =>
		executeAgentTurn({
			systemPrompt: "Agent",
			userMessage: "What is the plan?",
			userId: "user-1",
			organizationId: "org-1",
			featureKey: featureKey as "parlume",
			model,
		}),
	);
	return {
		result,
		request: state.captured as Captured,
		timings: timings.snapshot().values,
	};
}

beforeEach(() => {
	state.selection.mockReset();
	state.overrideMetadata.mockReset();
	state.selection.mockImplementation(async () => ({
		model: { id: "model" },
		provider: state.provider,
		modelString: state.modelString,
		canonicalName: state.modelString,
	}));
	state.overrideMetadata.mockImplementation(async () => ({
		model: { id: "override-model" },
		metadata: {
			provider: state.provider,
			modelString: state.modelString,
		},
	}));
});

describe("custom agent engine: a spoken turn", () => {
	it("asks the OpenAI reasoning model for the least reasoning it accepts", async () => {
		const { result, request } = await run("parlume");
		expect(result.success).toBe(true);
		expect(request.providerOptions).toEqual({
			openai: { reasoningEffort: "low" },
		});
	});

	it("does the same for an agent that pins its own model", async () => {
		const { request } = await run("parlume", "openai/gpt-6-luna");
		expect(state.overrideMetadata).toHaveBeenCalledTimes(1);
		expect(request.providerOptions).toEqual({
			openai: { reasoningEffort: "low" },
		});
	});

	it("sends nothing to a model that does not take the option", async () => {
		state.modelString = "openai/gpt-4.1";
		const { request } = await run("parlume");
		expect(request.providerOptions).toBeUndefined();
	});

	it("reports where its time went", async () => {
		const { timings } = await run("parlume");
		expect(Object.keys(timings).sort()).toEqual(
			[
				"agent.modelResolveMs",
				"agent.preLlmMs",
				"agent.preModelMs",
				"llm.cachedInputTokens",
				"llm.firstTextMs",
				"llm.inputTokens",
				"llm.outputTokens",
				"llm.reasoningTokens",
				"llm.toolCalls",
				"llm.totalMs",
			].sort(),
		);
		expect(timings["llm.reasoningTokens"]).toBe(7);
	});
});

describe("custom agent engine: an ordinary turn", () => {
	it.each([undefined, "chat-agent"])(
		"with feature key %s carries no provider options",
		async (featureKey) => {
			const { request } = await run(featureKey);
			expect(request.providerOptions).toBeUndefined();
		},
	);
});

describe("custom agent engine: a tool the runtime adds", () => {
	type Tools = Record<
		string,
		{ execute: (args: unknown) => Promise<unknown> }
	>;

	it("reaches the model, and its calls go through the runtime under the runtime's source", async () => {
		const invoke = vi.fn(async () => ({ posted: true }));
		const chat = {
			description: "Post to the chat",
			inputSchema: {},
			execute: vi.fn(),
		};
		state.captured = undefined;

		await withAgentToolRuntime(
			{ invoke, tools: { post_to_meeting_chat: chat } },
			() =>
				executeAgentTurn({
					systemPrompt: "Agent",
					userMessage: "Post the link",
					userId: "user-1",
					organizationId: "org-1",
					featureKey: "parlume",
				}),
		);

		const { tools } = state.captured as { tools?: Tools };
		expect(Object.keys(tools ?? {})).toEqual(["post_to_meeting_chat"]);
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

	it("does not appear in a turn without a runtime", async () => {
		const { request } = await run("parlume");

		expect((request as { tools?: unknown }).tools).toBeUndefined();
	});
});
