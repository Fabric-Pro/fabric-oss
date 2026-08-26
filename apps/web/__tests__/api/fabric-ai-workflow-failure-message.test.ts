import { describe, expect, it } from "vitest";
import { extractWorkflowFailureMessage } from "@/app/api/agents/fabric-ai/stream/workflow-failure-message";

describe("extractWorkflowFailureMessage", () => {
	it("uses the error cause message when present", () => {
		const err = Object.assign(new Error("Workflow execution failed"), {
			cause: new Error("tools: too many tools provided"),
		});
		expect(extractWorkflowFailureMessage(err)).toBe(
			"tools: too many tools provided",
		);
	});

	it("falls back to the top-level error message", () => {
		expect(
			extractWorkflowFailureMessage(new Error("DIRECT_CHAT_FAILED")),
		).toBe("DIRECT_CHAT_FAILED");
	});

	it("falls back to the default when no message is available", () => {
		expect(extractWorkflowFailureMessage(undefined)).toBe(
			"Workflow execution failed",
		);
		expect(extractWorkflowFailureMessage({})).toBe(
			"Workflow execution failed",
		);
	});

	it("walks a 3-level chain and returns the deepest meaningful message", () => {
		const root = Object.assign(new Error("Workflow execution failed"), {
			cause: Object.assign(new Error("Activity task failed"), {
				cause: new Error("tools: too many tools provided"),
			}),
		});
		expect(extractWorkflowFailureMessage(root)).toBe(
			"tools: too many tools provided",
		);
	});

	it("returns parent's meaningful message when only cause has empty message", () => {
		const err = Object.assign(new Error("Something meaningful"), {
			cause: new Error(""),
		});
		expect(extractWorkflowFailureMessage(err)).toBe("Something meaningful");
	});

	it("returns the default when all chain messages are generic Temporal wrappers", () => {
		const root = Object.assign(new Error("Workflow execution failed"), {
			cause: Object.assign(new Error("Activity task failed"), {
				cause: new Error("Activity task failed."),
			}),
		});
		expect(extractWorkflowFailureMessage(root)).toBe(
			"Workflow execution failed",
		);
	});

	it("truncates a deepest cause message longer than 500 chars to exactly 500 chars", () => {
		const longMessage = "x".repeat(600);
		const err = Object.assign(new Error("Workflow execution failed"), {
			cause: new Error(longMessage),
		});
		const result = extractWorkflowFailureMessage(err);
		expect(result).toHaveLength(500);
		expect(result).toBe("x".repeat(500));
	});
});
