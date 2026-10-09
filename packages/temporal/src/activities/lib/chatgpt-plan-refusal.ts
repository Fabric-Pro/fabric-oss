import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
	toSubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";

/**
 * A ChatGPT plan refusal the workflow, not the step, must handle (Fizzy #2770):
 * every plan spent — the workflow waits for a reset and runs the node once
 * more — or a plan that ran out mid-reply with another left, which Temporal's
 * retry resolves. A step that turned either into `{ success: false }` would
 * fail the node for good instead. A plan that does not serve the chosen model
 * is not one of these: no wait can change that, so it stays a failed node.
 */
export function isWorkflowHandledPlanRefusal(error: unknown): boolean {
	return (
		error instanceof SubscriptionPlanExhaustedError ||
		error instanceof PlanSourceRotatedError
	);
}

/**
 * Any ChatGPT plan refusal, a plan that does not serve the chosen model
 * included. Matched by name: that error lives in @repo/ai, which this module
 * does not load.
 */
export function isChatGptPlanRefusal(error: unknown): boolean {
	return (
		isWorkflowHandledPlanRefusal(error) ||
		(error instanceof Error &&
			error.name === "ChatGptPlanModelNotServedError")
	);
}

/**
 * The workflow-handled plan refusal inside an error, however the AI SDK
 * wrapped it (`RetryError.lastError`, `errors`, `cause`), or one read from a
 * provider body that carries the plan's usage-limit code. Null when there is
 * none.
 */
export function findWorkflowHandledPlanRefusal(error: unknown): Error | null {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current; depth++) {
		if (isWorkflowHandledPlanRefusal(current)) {
			return current as Error;
		}
		if (typeof current !== "object") {
			break;
		}
		const wrapper = current as {
			lastError?: unknown;
			errors?: unknown;
			cause?: unknown;
		};
		current =
			wrapper.lastError ??
			(Array.isArray(wrapper.errors)
				? wrapper.errors.at(-1)
				: undefined) ??
			wrapper.cause;
	}
	return toSubscriptionPlanExhaustedError(error);
}
