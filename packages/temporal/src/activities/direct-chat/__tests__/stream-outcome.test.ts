import { describe, expect, it } from "vitest";
import type { DirectChatToolCall } from "../../../types";
import { resolveStreamOutcome } from "../stream-outcome";

/**
 * Pure unit tests for the classifier that decides whether a finished model
 * stream actually produced a turn.
 *
 * Written against a real staging failure (Fizzy #2040): three workflow
 * histories came back `success: true` with `responseText: ""` and one tool
 * call frozen at `status: "pending"` with `args: {}`. The stream had ended
 * at the `tool-input-start` part, so the tool never ran and the model never
 * answered — but nothing reported a failure, and the stored `pending`
 * status rendered as a "Running" spinner that could never resolve.
 *
 * Two behaviours are pinned here, and they are deliberately independent:
 *   1. An unsettled tool call is ALWAYS settled as an error, even when the
 *      turn otherwise succeeded — that is what stops the spinner.
 *   2. The turn is only failed when it produced nothing usable, so a real
 *      answer is never thrown away just because a tool call was abandoned.
 */

function toolCall(
	overrides: Partial<DirectChatToolCall> & { name: string },
): DirectChatToolCall {
	return {
		id: `call-${overrides.name}`,
		args: {},
		status: "complete",
		...overrides,
	};
}

describe("resolveStreamOutcome — settling unfinished tool calls", () => {
	it.each(["pending", "running"] as const)(
		"settles a %s tool call as an error",
		(status) => {
			const outcome = resolveStreamOutcome({
				responseText: "",
				toolCalls: [
					toolCall({ name: "mcp_example_get_identity", status }),
				],
			});

			expect(outcome.toolCalls[0].status).toBe("error");
			expect(outcome.toolCalls[0].error).toMatch(/never ran/);
		},
	);

	it("settles the spinner even when the turn produced an answer", () => {
		// Text plus an abandoned call is still a bug, but the answer is
		// real — surface the failed call without discarding the answer.
		const outcome = resolveStreamOutcome({
			responseText: "Here is what I found.",
			toolCalls: [
				toolCall({ name: "mcp_example_search", status: "pending" }),
			],
		});

		expect(outcome.error).toBeUndefined();
		expect(outcome.toolCalls[0].status).toBe("error");
	});

	it("leaves settled tool calls alone", () => {
		const calls = [
			toolCall({ name: "mcp_example_search", status: "complete" }),
			toolCall({
				name: "mcp_example_write",
				status: "error",
				error: "denied",
			}),
		];

		const outcome = resolveStreamOutcome({
			responseText: "done",
			toolCalls: calls,
		});

		expect(outcome.toolCalls[0].status).toBe("complete");
		expect(outcome.toolCalls[1].error).toBe("denied");
	});

	it("does not mutate the array it was given", () => {
		const calls = [
			toolCall({ name: "mcp_example_search", status: "pending" }),
		];

		resolveStreamOutcome({ responseText: "", toolCalls: calls });

		expect(calls[0].status).toBe("pending");
	});
});

describe("resolveStreamOutcome — failing a turn that produced nothing", () => {
	it("fails when a tool call was cut off and no text arrived", () => {
		const outcome = resolveStreamOutcome({
			responseText: "",
			toolCalls: [
				toolCall({
					name: "mcp_example_get_identity",
					status: "pending",
				}),
			],
		});

		expect(outcome.error).toContain("mcp_example_get_identity");
		expect(outcome.error).toMatch(/never ran/);
	});

	it("prefers the provider's own message over the inferred one", () => {
		const outcome = resolveStreamOutcome({
			responseText: "",
			toolCalls: [
				toolCall({
					name: "mcp_example_get_identity",
					status: "pending",
				}),
			],
			streamErrorMessage: "provider signalled an overloaded_error",
		});

		expect(outcome.error).toContain(
			"provider signalled an overloaded_error",
		);
	});

	it("records the finish reason when the provider gave one", () => {
		const outcome = resolveStreamOutcome({
			responseText: "",
			toolCalls: [
				toolCall({
					name: "mcp_example_get_identity",
					status: "pending",
				}),
			],
			finishReason: "length",
		});

		expect(outcome.error).toContain("length");
	});

	it("treats whitespace-only text as no answer", () => {
		const outcome = resolveStreamOutcome({
			responseText: "  \n ",
			toolCalls: [
				toolCall({
					name: "mcp_example_get_identity",
					status: "pending",
				}),
			],
		});

		expect(outcome.error).toBeDefined();
	});

	it("does not fail a turn waiting on the user to confirm a tool", () => {
		// A confirmation request is a legitimate empty-text turn.
		const outcome = resolveStreamOutcome({
			responseText: "",
			toolCalls: [toolCall({ name: "fabric_execute_workflow" })],
			pendingConfirmation: {
				workflowId: "wf-1",
				workflowName: "Nightly sync",
				message: "Ready to run?",
			},
		});

		expect(outcome.error).toBeUndefined();
	});

	it("leaves an empty turn with no tool calls to the caller's fallbacks", () => {
		// `ai-execution` has a separate attached-documents fallback for this
		// shape; claiming a tool failure here would be a lie.
		const outcome = resolveStreamOutcome({
			responseText: "",
			toolCalls: [],
		});

		expect(outcome.error).toBeUndefined();
	});

	it("does not fail a turn whose tool calls all completed", () => {
		const outcome = resolveStreamOutcome({
			responseText: "All set.",
			toolCalls: [toolCall({ name: "mcp_example_search" })],
		});

		expect(outcome.error).toBeUndefined();
	});
});
