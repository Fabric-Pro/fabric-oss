/**
 * LlmHandler — usage attribution.
 *
 * A Planner step made for a chat records that chat's ID on its usage-log row:
 * the handler hands `ExecuteStepInput.conversationId` to the model selector
 * as attribution. A step with no conversation passes none, and never the
 * execution ID.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	generateText: vi.fn(),
	getAiModel: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateText: h.generateText,
}));

vi.mock("../../../utils", () => ({
	getAiModel: h.getAiModel,
}));

import type { ExecuteStepInput } from "../../../types";
import { LlmHandler } from "../llm-handler";

function buildInput(
	overrides: Partial<ExecuteStepInput> = {},
): ExecuteStepInput {
	return {
		step: {
			id: "s1",
			description: "Present the results",
			type: "api",
			status: "pending",
			order: 1,
			capability: "llm",
		},
		message: "What shipped last week?",
		systemPrompt: "",
		variables: {},
		userId: "user-1",
		organizationId: "org-1",
		executionId: "exec-1",
		executionMode: "balanced",
		totalSteps: 1,
		stepIndex: 1,
		previousStepResults: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	h.getAiModel.mockResolvedValue({ id: "example-model" });
	h.generateText.mockResolvedValue({ text: "Here are the results." });
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("LlmHandler — usage attribution", () => {
	it("passes the step's conversation to the model selector", async () => {
		const input = buildInput({
			conversationId: "conv-1",
			frameId: "frame-1",
		});
		const result = await new LlmHandler().execute({
			input,
			variables: {},
			toolCalls: [],
			startTime: Date.now(),
		});

		expect(result.handled).toBe(true);
		expect(h.getAiModel).toHaveBeenCalledTimes(1);
		const args = h.getAiModel.mock.calls[0];
		expect(args[0]).toBe("user-1");
		expect(args[1]).toBe("org-1");
		expect(args[5]).toEqual({
			conversationId: "conv-1",
			frameId: "frame-1",
		});
		expect(args[5]).not.toHaveProperty("workflowExecutionId");
	});

	it("passes no attribution without a conversation, never the execution ID", async () => {
		await new LlmHandler().execute({
			input: buildInput(),
			variables: {},
			toolCalls: [],
			startTime: Date.now(),
		});

		const args = h.getAiModel.mock.calls[0];
		expect(args[5]).toBeUndefined();
		expect(JSON.stringify(args)).not.toContain("exec-1");
	});
});
