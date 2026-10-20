import {
	CHATGPT_PLAN_API_BILLING_HEADER,
	CHATGPT_PLAN_PERSONAL_KEY_HEADER,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { PROVIDER_DISPLAY_NAMES } from "@saas/settings/components/org-ai-model-preferences/use-org-api-model-preferences";
import { formatPlanResetTime } from "@saas/shared/lib/ai-error-message";

/**
 * A turn that ran on API billing because every ChatGPT plan was spent
 * (Fizzy #3048), and when the plans reset, if known. `personalKeyProvider`
 * is set when it ran on the member's own personal key rather than the
 * organization's (Fizzy #3086): that key's provider, never the key.
 */
export interface ChatGptPlanApiBilling {
	resetAt: string | null;
	personalKeyProvider?: string;
}

function providerName(provider: string): string {
	return (
		PROVIDER_DISPLAY_NAMES[provider] ??
		provider
			.toLowerCase()
			.split("_")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ")
	);
}

/** What a chat stream's response says about API billing, if anything. */
export function readChatGptPlanApiBilling(
	response: Pick<Response, "headers">,
): ChatGptPlanApiBilling | undefined {
	const value = response.headers?.get?.(CHATGPT_PLAN_API_BILLING_HEADER);
	if (value === null || value === undefined) {
		return undefined;
	}
	const personalKeyProvider = response.headers?.get?.(
		CHATGPT_PLAN_PERSONAL_KEY_HEADER,
	);
	return {
		resetAt: value && !Number.isNaN(Date.parse(value)) ? value : null,
		...(personalKeyProvider && { personalKeyProvider }),
	};
}

/** The marker as a saved message's metadata holds it, if it is one. */
export function parseChatGptPlanApiBilling(
	value: unknown,
): ChatGptPlanApiBilling | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const { resetAt, personalKeyProvider } = value as {
		resetAt?: unknown;
		personalKeyProvider?: unknown;
	};
	return {
		resetAt:
			typeof resetAt === "string" && !Number.isNaN(Date.parse(resetAt))
				? resetAt
				: null,
		...(typeof personalKeyProvider === "string" &&
			personalKeyProvider && { personalKeyProvider }),
	};
}

/** The note under a reply that ran on API billing, or on the member's own key. */
export function chatGptPlanApiBillingNote(
	apiBilling: ChatGptPlanApiBilling,
	now = new Date(),
): string {
	const ran = apiBilling.personalKeyProvider
		? `This reply used your personal ${providerName(apiBilling.personalKeyProvider)} key because the ChatGPT plan is spent.`
		: "This reply ran on API billing because every ChatGPT plan is spent.";
	return apiBilling.resetAt
		? `${ran} Plans reset at ${formatPlanResetTime(new Date(apiBilling.resetAt), now)}.`
		: ran;
}
