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

	/**
	 * A tool's usage-limit refusal becomes the partial error while the model
	 * stream itself finishes normally (Fizzy #3031), so that stream can still
	 * have stopped on a limit. Reporting only the error hid that the answer
	 * was cut short and the offer to continue (Fizzy #3273).
	 */
	it("reports both a partial error and the output limit when both happen", () => {
		expect(
			resolveStreamOutcome({
				responseText: "Partial",
				toolCalls: [],
				streamErrorMessage: "AI usage limit reached",
				finishReason: "length",
			}),
		).toEqual({
			toolCalls: [],
			partialError: "AI usage limit reached",
			truncated: "output_limit",
		});
	});

	it("reports both a partial error and the step limit when both happen", () => {
		const outcome = resolveStreamOutcome({
			responseText: "I checked three projects so far.",
			toolCalls: [],
			streamErrorMessage: "AI usage limit reached",
			finishReason: "tool-calls",
			stepCount: 5,
			maxSteps: 5,
		});
		expect(outcome.partialError).toBe("AI usage limit reached");
		expect(outcome.truncated).toBe("step_limit");
	});

	it("reports no truncation when the stream ended on the error", () => {
		const outcome = resolveStreamOutcome({
			responseText: "I'll search the project first.",
			toolCalls: [],
			streamErrorMessage: "429 Too Many Requests",
			finishReason: "error",
		});
		expect(outcome.partialError).toBe("429 Too Many Requests");
		expect(outcome.truncated).toBeUndefined();
	});
});
