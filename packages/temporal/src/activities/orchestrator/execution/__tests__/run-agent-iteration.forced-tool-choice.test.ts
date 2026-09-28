/**
 * runAgentIteration — forced frame/slideshow `toolChoice` per model.
 *
 * The orchestrator forces `{ type: "tool", toolName: "fabric_create_frame" }`
 * when the prompt heuristic detects a frame request. claude-opus-5-5,
 * claude-fable-5-1 and claude-mythos-5-1 return HTTP 400 for any forced
 * `tool_choice` regardless of thinking settings, so for them the activity
 * must fall back to `"auto"` (the prompt steering still applies).
 * claude-opus-5 accepts a forced tool_choice and keeps being forced.
 *
 * Mock set mirrors `run-agent-iteration.suppression.test.ts`; the only
 * difference is that `getAiModelWithSelection` returns a model carrying
 * `modelId` (the field the AI SDK exposes on every resolved language model)
 * and the catalog `canonicalName`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	streamTextMock: vi.fn(),
	modelId: { current: "claude-sonnet-5" as string | undefined },
	canonicalName: { current: undefined as string | undefined },
}));

vi.mock("@repo/ai", () => ({
	streamText: stubs.streamTextMock,
	tool: vi.fn((definition: { description?: string }) => ({
		__isAiSdkTool: true,
		description: definition?.description,
	})),
	jsonSchema: vi.fn((schema: unknown) => ({ __isJsonSchema: true, schema })),
	isStepCount: vi.fn((n: number) => ({ __stopWhen: "stepCount", n })),
}));

vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => null),
}));

vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: vi.fn(async () => []),
	createSkillTools: vi.fn(() => ({})),
	buildSkillsSystemBlock: vi.fn(() => ""),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));

vi.mock("../../utils", () => ({
	getAiModelWithSelection: vi.fn(async () => ({
		model:
			stubs.modelId.current === undefined
				? { __mockModel: true }
				: { __mockModel: true, modelId: stubs.modelId.current },
		provider: "DATABRICKS",
		modelString: stubs.modelId.current,
		canonicalName: stubs.canonicalName.current,
	})),
}));

import {
	type RunAgentIterationInput,
	runAgentIteration,
} from "../run-agent-iteration";

function makeStreamResult() {
	return {
		stream: (async function* () {})(),
		usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
		finishReason: Promise.resolve("stop"),
	};
}

function frameRequest(
	overrides: Partial<RunAgentIterationInput> = {},
): RunAgentIterationInput {
	return {
		conversationHistory: [
			{
				role: "user",
				// `detectRequestedFrameOutput` matches "interactive dashboard".
				content:
					"Build me an interactive dashboard for the team metrics.",
				timestamp: "2026-09-27T00:00:00.000Z",
			},
		],
		availableTools: {
			fabric_create_frame: {
				description: "Create a Fabric Frame.",
				inputSchema: { type: "object", properties: {} },
			},
			other_tool: {
				description: "Something else.",
				inputSchema: { type: "object", properties: {} },
			},
		},
		systemPrompt: "You are a helpful agent.",
		userId: "user-1",
		organizationId: "org-1",
		executionId: "exec-1",
		iteration: 1,
		...overrides,
	};
}

async function toolChoiceFor(
	modelId: string | undefined,
	overrides: Partial<RunAgentIterationInput> = {},
	canonicalName?: string,
): Promise<unknown> {
	stubs.modelId.current = modelId;
	stubs.canonicalName.current = canonicalName;
	await runAgentIteration(frameRequest(overrides));
	expect(stubs.streamTextMock).toHaveBeenCalledTimes(1);
	return (stubs.streamTextMock.mock.calls[0][0] as { toolChoice?: unknown })
		.toolChoice;
}

beforeEach(() => {
	vi.clearAllMocks();
	stubs.streamTextMock.mockImplementation(() => makeStreamResult());
});

describe("runAgentIteration — forced frame toolChoice by model", () => {
	it.each([
		"claude-opus-5-5",
		"anthropic/claude-opus-5.5",
		"claude-fable-5-1",
		"claude-mythos-5-1",
	])("%s → auto (model rejects forced tool_choice)", async (modelId) => {
		expect(await toolChoiceFor(modelId)).toBe("auto");
	});

	// A Databricks serving endpoint the org named itself says nothing about
	// the model behind it; only the resolved catalog name does.
	it("uses the catalog canonical name when the model id is an opaque alias", async () => {
		expect(await toolChoiceFor("prod-chat", {}, "claude-opus-5-5")).toBe(
			"auto",
		);
	});

	it("still forces behind an opaque alias when the catalog model accepts it", async () => {
		expect(await toolChoiceFor("prod-chat", {}, "claude-opus-5")).toEqual({
			type: "tool",
			toolName: "fabric_create_frame",
		});
	});

	it("uses modelOverride when the resolved model exposes no modelId", async () => {
		expect(
			await toolChoiceFor(undefined, {
				modelOverride: "claude-opus-5-5",
			}),
		).toBe("auto");
	});

	it.each(["claude-opus-5", "anthropic/claude-opus-5", "claude-sonnet-5"])(
		"%s → still forces fabric_create_frame",
		async (modelId) => {
			expect(await toolChoiceFor(modelId)).toEqual({
				type: "tool",
				toolName: "fabric_create_frame",
			});
		},
	);
});
