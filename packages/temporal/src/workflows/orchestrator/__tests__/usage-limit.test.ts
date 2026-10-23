import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
} from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { orchestratorErrorMessage } from "../usage-limit";

describe("orchestratorErrorMessage", () => {
	it("preserves the parseable refusal inside Temporal's wrapper", () => {
		const cause = ApplicationFailure.create({
			type: "AiUsageLimitExceededError",
			message:
				"AI usage limit exceeded: example-limit (TOKENS, DAILY) — used 10 of 10",
		});
		const error = new ActivityFailure(
			"Activity task failed",
			"runAgentIteration",
			"example",
			RetryState.NON_RETRYABLE_FAILURE,
			"example-worker",
			cause,
		);
		expect(orchestratorErrorMessage(error)).toBe(cause.message);
	});
	it("keeps generic failures and fallbacks unchanged", () => {
		expect(orchestratorErrorMessage(new Error("provider failed"))).toBe(
			"provider failed",
		);
		expect(orchestratorErrorMessage(null)).toBe("Unknown error");
		const error = new ActivityFailure(
			"Activity task failed",
			"example",
			"example",
			RetryState.MAXIMUM_ATTEMPTS_REACHED,
			"example-worker",
			ApplicationFailure.create({ type: "OtherError", message: "other" }),
		);
		expect(orchestratorErrorMessage(error)).toBe("Activity task failed");
	});
});
