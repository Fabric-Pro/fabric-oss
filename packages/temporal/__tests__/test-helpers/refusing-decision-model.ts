/**
 * A decision model that refuses every question, driven through the real AI SDK
 * `experimental_decide`.
 *
 * Since `ai` 7.0.130 a provider reports a refusal as a `{ type: "refusal" }`
 * answer, and `experimental_decide` turns any refused question into a thrown
 * `Experimental_DecisionRefusalError` rather than returning it among the
 * answers. Tests that mock `@repo/ai` route their `experimental_decide` mock
 * through `decideWithRefusal`, so the decision site under test sees exactly
 * what the SDK produces for a refusal, not a hand-built stand-in.
 */
import { Experimental_DecisionRefusalError, experimental_decide } from "ai";

export const refusingDecisionModel = {
	specificationVersion: "v4" as const,
	provider: "example-decider",
	modelId: "example/refusing-decider",
	supportedQuestionTypes: ["choice", "score", "boolean"] as Array<
		"choice" | "score" | "boolean"
	>,
	doDecide: async ({
		questions,
	}: {
		questions: Record<string, unknown>;
	}) => ({
		answers: Object.fromEntries(
			Object.keys(questions).map((id) => [
				id,
				{ type: "refusal" as const },
			]),
		),
		warnings: [],
	}),
};

/** Drop-in implementation for an `experimental_decide` mock. */
export function decideWithRefusal(
	args: Parameters<typeof experimental_decide>[0],
) {
	return experimental_decide({
		...args,
		model: refusingDecisionModel as unknown as Parameters<
			typeof experimental_decide
		>[0]["model"],
	});
}

/** Whether a call's settled value is the SDK's refusal error. */
export async function rejectedWithRefusal(pending: unknown): Promise<boolean> {
	try {
		await pending;
		return false;
	} catch (error) {
		return Experimental_DecisionRefusalError.isInstance(error);
	}
}
