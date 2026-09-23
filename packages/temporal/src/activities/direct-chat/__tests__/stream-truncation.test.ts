import { describe, expect, it } from "vitest";
import { resolveStreamOutcome, resolveTruncation } from "../stream-outcome";

/**
 * A turn that stops on a limit must say so (review F25, Fizzy #2166): an
 * answer cut at the output ceiling, or a step-capped turn whose last text is
 * a planning preamble, used to read as a complete answer.
 */
describe("resolveTruncation", () => {
	it("flags an answer cut at the output ceiling", () => {
		expect(resolveTruncation({ finishReason: "length" })).toBe(
			"output_limit",
		);
	});

	it("flags a turn the step cap stopped while the model wanted tools", () => {
		expect(
			resolveTruncation({
				finishReason: "tool-calls",
				stepCount: 10,
				maxSteps: 10,
			}),
		).toBe("step_limit");
	});

	it("does not flag tool calls below the cap", () => {
		expect(
			resolveTruncation({
				finishReason: "tool-calls",
				stepCount: 3,
				maxSteps: 10,
			}),
		).toBeUndefined();
	});

	it("does not flag a turn waiting on the user to confirm a tool", () => {
		expect(
			resolveTruncation({
				finishReason: "tool-calls",
				stepCount: 10,
				maxSteps: 10,
				pendingConfirmation: {
					workflowId: "wf",
					workflowName: "Deploy",
					message: "Run it?",
				},
			}),
		).toBeUndefined();
	});

	it("does not flag a finished answer", () => {
		expect(
			resolveTruncation({
				finishReason: "stop",
				stepCount: 10,
				maxSteps: 10,
			}),
		).toBeUndefined();
	});
});

describe("resolveStreamOutcome truncation", () => {
	it("keeps the text and reports the output limit", () => {
		expect(
			resolveStreamOutcome({
				responseText: "The first half of a long document…",
				toolCalls: [],
				finishReason: "length",
			}),
		).toEqual({ toolCalls: [], truncated: "output_limit" });
	});

	it("reports the step limit even when no text was written", () => {
		const outcome = resolveStreamOutcome({
			responseText: "",
			toolCalls: [],
			finishReason: "tool-calls",
			stepCount: 5,
			maxSteps: 5,
		});
		expect(outcome.error).toBeUndefined();
		expect(outcome.truncated).toBe("step_limit");
	});

	it("reports a provider error, not truncation, when both happen", () => {
		const outcome = resolveStreamOutcome({
			responseText: "Partial",
			toolCalls: [],
			streamErrorMessage: "overloaded",
			finishReason: "length",
		});
		expect(outcome.partialError).toBe("overloaded");
		expect(outcome.truncated).toBeUndefined();
	});
});
