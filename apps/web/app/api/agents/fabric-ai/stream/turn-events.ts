import { classifyLimitError, type LimitSignal } from "@repo/ai/limits";
import type { DirectChatWorkflowOutput } from "@repo/temporal";

/**
 * SSE events that close a Direct turn, built from the workflow's result.
 *
 * Kept out of `route.ts` so they can be tested without the route's Temporal,
 * database and auth graph (a Next route module may only export handlers).
 */

type TurnResult = Pick<
	DirectChatWorkflowOutput,
	| "error"
	| "partialError"
	| "limitSignal"
	| "usageLimit"
	| "toolsFailedThisTurn"
	| "truncated"
	| "durationMs"
	| "usage"
	| "model"
>;

interface TurnErrorEvent {
	type: "error";
	message: string;
	/** Provider limit behind the failure — the client shows the limit banner. */
	limit?: LimitSignal;
	/**
	 * A HARD AI usage limit refused the turn's request: the client shows the
	 * shared limit toast, with `data`, as for a refusal at model resolution.
	 */
	code?: "AI_USAGE_LIMIT_EXCEEDED";
	data?: Omit<NonNullable<TurnResult["usageLimit"]>, "message">;
	/** The answer streamed partly before this error; keep it on screen. */
	partial?: true;
}

function limitFor(
	result: TurnResult,
	message: string,
): Pick<TurnErrorEvent, "limit" | "code" | "data"> {
	if (result.usageLimit) {
		// The payload `buildWorkflowErrorEvent` sends for a refusal at model
		// resolution, so the client handles both the same way.
		const { message: _message, ...data } = result.usageLimit;
		return { code: "AI_USAGE_LIMIT_EXCEEDED", data };
	}
	const limit = result.limitSignal ?? classifyLimitError(message);
	return limit ? { limit } : {};
}

/** For a turn the workflow reported as failed. */
export function failedTurnEvent(result: TurnResult): TurnErrorEvent {
	const message = result.error || "Workflow failed";
	return { type: "error", message, ...limitFor(result, message) };
}

/**
 * For a turn that answered but was cut short by a provider error after some
 * text had streamed. Without it the preamble read as a finished answer and
 * the cause was never shown (review F22/F26).
 */
export function partialTurnEvent(result: TurnResult): TurnErrorEvent | null {
	if (!result.partialError) {
		return null;
	}
	return {
		type: "error",
		message: result.partialError,
		partial: true,
		...limitFor(result, result.partialError),
	};
}

export function doneTurnEvent(result: TurnResult) {
	return {
		type: "done" as const,
		durationMs: result.durationMs,
		usage: result.usage,
		model: result.model,
		// The answer came from the tools-off retry: say so rather than let
		// it pass as a normal tools turn (review F4).
		...(result.toolsFailedThisTurn
			? { toolsFailed: result.toolsFailedThisTurn }
			: {}),
		// The answer stopped on the output ceiling or the step cap; the chat
		// says so and offers to continue (review F25).
		...(result.truncated ? { truncated: result.truncated } : {}),
	};
}

/**
 * The route stops waiting after its poll budget. The workflow is cancelled
 * at that point rather than left running, unseen, for up to another quarter
 * of an hour (review F24), and the user is told plainly what happened.
 */
export const ROUTE_TIMEOUT_MESSAGE =
	"This reply ran past the 5-minute limit and was stopped. Try a narrower request, or split it into smaller steps.";
