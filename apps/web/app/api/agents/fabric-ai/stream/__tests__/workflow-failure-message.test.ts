import { describe, expect, it } from "vitest";
import { extractAiUsageLimitExceededError } from "../extract-ai-usage-limit-error";
import { extractWorkflowFailureMessage } from "../workflow-failure-message";

// The client serializes custom exception fields away. Model that boundary
// with Error instances carrying the SDK's name/type/cause fields, without
// importing the workflow runtime into the web package.
function workflowFailure(message: string, type: string) {
	const original = Object.assign(new Error(message), {
		name: "ApplicationFailure",
		type,
		nonRetryable: true,
	});
	const activity = Object.assign(
		new Error("Activity task failed", { cause: original }),
		{
			name: "ActivityFailure",
		},
	);
	const terminal = Object.assign(
		new Error("Activity task failed", { cause: activity }),
		{
			name: "ApplicationFailure",
			type: "DIRECT_CHAT_FAILED",
			nonRetryable: true,
		},
	);
	return Object.assign(
		new Error("Workflow execution failed", { cause: terminal }),
		{
			name: "WorkflowFailedError",
		},
	);
}

describe("direct chat terminal failure cause chain", () => {
	it("finds a provider failure through the workflow and activity wrappers", () => {
		expect(
			extractWorkflowFailureMessage(
				workflowFailure(
					"Example provider is not configured",
					"AIProviderNotConfiguredError",
				),
			),
		).toBe("Example provider is not configured");
	});

	it("finds a serialized limit through DIRECT_CHAT_FAILED and ActivityFailure", () => {
		const message =
			"AI usage limit exceeded: example-limit (TOKENS, MONTHLY) — used 100 of 100";
		const error = workflowFailure(message, "AiUsageLimitExceededError");
		expect(extractWorkflowFailureMessage(error)).toBe(message);
		expect(extractAiUsageLimitExceededError(error)).toMatchObject({
			limitId: "example-limit",
			dimension: "TOKENS",
			window: "MONTHLY",
			used: 100n,
			max: 100n,
			// Serialized exceptions lose custom fields; activity result data keeps the URL.
			manageLimitsUrl: "",
		});
	});
});
