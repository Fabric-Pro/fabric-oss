/**
 * The ways a ChatGPT plan can refuse a procedure's AI call (Fizzy #2939,
 * #2770), as the client-facing error. A procedure maps these instead of
 * treating them as "the model produced nothing": nothing ran, so nothing may
 * advance, and the person needs to know whether to wait, to reconnect, or to
 * have another model chosen.
 */
import { ORPCError } from "@orpc/client";
import { toSubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { ChatGptPlanModelNotServedError } from "@repo/ai/lib/chatgpt-plan/models";
import {
	CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
	ChatGptPlanAuthError,
} from "@repo/ai/lib/chatgpt-plan/oauth";

function resetPhrase(resetAt: Date | null, now: number): string {
	if (!resetAt) {
		return "Wait for its limit to reset, then try again.";
	}
	const minutes = Math.max(1, Math.ceil((resetAt.getTime() - now) / 60_000));
	return minutes < 60
		? `It resets in about ${minutes} min.`
		: `It resets in about ${Math.round(minutes / 60)} h.`;
}

/** Whether `error` is a ChatGPT plan refusal this module maps. */
export function isChatGptPlanRefusal(error: unknown): boolean {
	return (
		error instanceof ChatGptPlanAuthError ||
		error instanceof ChatGptPlanModelNotServedError ||
		toSubscriptionPlanExhaustedError(error) !== null
	);
}

/**
 * For a catch around an AI call that would otherwise turn every failure into
 * an empty result, a fallback or a generic error: a plan refusal goes on, and
 * `domainErrorMapper` turns it into the error that tells the person to wait or
 * reconnect. Silently returning nothing would hide that their plan refused.
 */
export function rethrowChatGptPlanRefusal(error: unknown): void {
	if (isChatGptPlanRefusal(error)) {
		throw error;
	}
}

export function chatGptPlanRefusalToORPCError(
	error: unknown,
	now = Date.now(),
): ORPCError<string, unknown> | null {
	const exhausted = toSubscriptionPlanExhaustedError(error);
	if (exhausted) {
		return new ORPCError("TOO_MANY_REQUESTS", {
			message: `Your ChatGPT plan has no usage left. ${resetPhrase(exhausted.resetAt, now)}`,
			data: {
				code: "CHATGPT_PLAN_EXHAUSTED",
				resetAt: exhausted.resetAt?.toISOString() ?? null,
				retryAfterMs: exhausted.resetAt
					? Math.max(0, exhausted.resetAt.getTime() - now)
					: null,
			},
		});
	}
	if (error instanceof ChatGptPlanAuthError) {
		return new ORPCError("PRECONDITION_FAILED", {
			message: CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
			data: { code: "CHATGPT_PLAN_UNAVAILABLE" },
		});
	}
	if (error instanceof ChatGptPlanModelNotServedError) {
		return new ORPCError("PRECONDITION_FAILED", {
			message: error.message,
			data: { code: "CHATGPT_PLAN_MODEL_NOT_SERVED", model: error.model },
		});
	}
	return null;
}
