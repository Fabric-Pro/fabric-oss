/**
 * runAgentIteration — usage attribution.
 *
 * An Advisor round made for a chat records that chat's ID on its usage-log
 * row: the activity hands `input.conversationId` to the model selector as
 * attribution. A round with no conversation passes none.
 *
 * Mock set mirrors `run-agent-iteration.turn-notice.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	streamTextMock: vi.fn(),
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

vi.mock("@repo/ai/capabilities", () => ({
	getModelCapabilities: vi.fn(() => ({ vision: false })),
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
		model: { __mockModel: true, modelId: "claude-sonnet-5" },
		provider: "ANTHROPIC_DIRECT",
		modelString: "claude-sonnet-5",
		canonicalName: "claude-sonnet-5",
	})),
}));

import { getAiModelWithSelection } from "../../utils";
import {
	type RunAgentIterationInput,
	runAgentIteration,
} from "../run-agent-iteration";

function buildInput(
	overrides: Partial<RunAgentIterationInput> = {},
): RunAgentIterationInput {
	return {
		conversationHistory: [
			{
				role: "user",
				content: "When is the launch?",
				timestamp: "2026-10-05T00:00:00Z",
			},
		],
		availableTools: {},
		enableSkillTools: false,
		systemPrompt: "You are the project Advisor.",
		userId: "user-1",
		organizationId: "org-1",
		executionId: "exec-1",
		iteration: 1,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	stubs.streamTextMock.mockImplementation(() => ({
		stream: (async function* () {})(),
		usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
		finishReason: Promise.resolve("stop"),
	}));
});

describe("runAgentIteration — usage attribution", () => {
	it("passes the conversation to the model selector", async () => {
		await runAgentIteration(
			buildInput({
				conversationId: "conv-1",
				frameId: "frame-1",
				projectId: "project-1",
			}),
		);

		expect(getAiModelWithSelection).toHaveBeenCalledTimes(1);
		const args = vi.mocked(getAiModelWithSelection).mock.calls[0];
		expect(args[0]).toBe("user-1");
		expect(args[1]).toBe("org-1");
		expect(args[5]).toEqual({
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});
		expect(args[5]).not.toHaveProperty("workflowExecutionId");
	});

	it("attributes a frame even without a conversation", async () => {
		await runAgentIteration(buildInput({ frameId: "frame-1" }));
		expect(vi.mocked(getAiModelWithSelection).mock.calls[0][5]).toEqual({
			frameId: "frame-1",
		});
	});

	it("attributes a project even without a conversation or frame", async () => {
		await runAgentIteration(buildInput({ projectId: "project-1" }));
		expect(vi.mocked(getAiModelWithSelection).mock.calls[0][5]).toEqual({
			projectId: "project-1",
		});
	});

	it("passes no attribution without a conversation, never the execution ID", async () => {
		await runAgentIteration(buildInput());

		const args = vi.mocked(getAiModelWithSelection).mock.calls[0];
		expect(args[5]).toBeUndefined();
		expect(JSON.stringify(args)).not.toContain("exec-1");
	});
});
