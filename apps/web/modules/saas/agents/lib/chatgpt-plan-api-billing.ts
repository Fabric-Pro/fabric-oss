import { CHATGPT_PLAN_API_BILLING_HEADER } from "@repo/agent-types/chatgpt-plan-fetch";
import { formatPlanResetTime } from "@saas/shared/lib/ai-error-message";

/**
 * A turn that ran on the organization's API billing because every ChatGPT
 * plan was spent (Fizzy #3048), and when the plans reset, if known.
 */
export interface ChatGptPlanApiBilling {
	resetAt: string | null;
}

/** What a chat stream's response says about API billing, if anything. */
export function readChatGptPlanApiBilling(
	response: Pick<Response, "headers">,
): ChatGptPlanApiBilling | undefined {
	const value = response.headers?.get?.(CHATGPT_PLAN_API_BILLING_HEADER);
	if (value === null || value === undefined) {
		return undefined;
	}
	return {
		resetAt: value && !Number.isNaN(Date.parse(value)) ? value : null,
	};
}

/** The marker as a saved message's metadata holds it, if it is one. */
export function parseChatGptPlanApiBilling(
	value: unknown,
): ChatGptPlanApiBilling | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const { resetAt } = value as { resetAt?: unknown };
	return {
		resetAt:
			typeof resetAt === "string" && !Number.isNaN(Date.parse(resetAt))
				? resetAt
				: null,
	};
}

/** The note under a reply that ran on API billing. */
export function chatGptPlanApiBillingNote(
	apiBilling: ChatGptPlanApiBilling,
	now = new Date(),
): string {
	const ran =
		"This reply ran on API billing because every ChatGPT plan is spent.";
	return apiBilling.resetAt
		? `${ran} Plans reset at ${formatPlanResetTime(new Date(apiBilling.resetAt), now)}.`
		: ran;
}
