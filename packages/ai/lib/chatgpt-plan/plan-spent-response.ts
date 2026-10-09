import {
	CHATGPT_PLAN_EXHAUSTED_CODE,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { getAiProviderApiKey } from "@repo/database";
import {
	type ChatGptPlanSourcesExhausted,
	chatGptPlanPoolExhaustedMessage,
	pickChatGptPlanSource,
} from "./pool";

/**
 * Switching to the organization's API billing reroutes the member's work only
 * when the organization has a provider, its policy still asks rather than
 * never, and the member's own plan is in play (turning it off is the switch).
 */
export function chatGptPlanApiBillingOption(
	plan: ChatGptPlanSourcesExhausted,
	hasLlmProvider: boolean,
): boolean {
	return (
		(plan.policy?.apiFallbackInteractive ?? "ASK") === "ASK" &&
		hasLlmProvider &&
		plan.ownPlanSpent !== undefined
	);
}

/** The refusal for a spent pick: the own plan's, or the pool's. */
export function chatGptPlanSpentError(
	plan: ChatGptPlanSourcesExhausted,
): SubscriptionPlanExhaustedError {
	return plan.ownPlanOnly && plan.ownPlanSpent
		? plan.ownPlanSpent
		: new SubscriptionPlanExhaustedError(
				chatGptPlanPoolExhaustedMessage(plan.resetAt),
				plan.resetAt,
			);
}

/**
 * The 429 a chat route answers before starting a turn when every ChatGPT plan
 * that would serve the member's interactive work is spent (Fizzy #2770),
 * instead of falling through to the organization's provider or starting a
 * run that can only fail. Null when a plan or no plan serves the turn; a
 * fault reads as null, leaving the route's own resolution to decide.
 */
export async function chatGptPlanSpentChatResponse(context: {
	userId: string;
	organizationId?: string | null;
}): Promise<Response | null> {
	if (!context.organizationId) {
		return null;
	}
	let plan: Awaited<ReturnType<typeof pickChatGptPlanSource>>;
	try {
		plan = await pickChatGptPlanSource({
			userId: context.userId,
			organizationId: context.organizationId,
			planEligible: true,
		});
	} catch {
		return null;
	}
	if (!plan || !("exhausted" in plan)) {
		return null;
	}
	const error = chatGptPlanSpentError(plan);
	const hasLlmProvider =
		plan.ownPlanSpent !== undefined &&
		(await getAiProviderApiKey({
			userId: context.userId,
			organizationId: context.organizationId,
		})
			.then((config) => config.provider !== null)
			.catch(() => false));
	return new Response(
		JSON.stringify({
			error: error.message,
			code: CHATGPT_PLAN_EXHAUSTED_CODE,
			resetAt: error.resetAt?.toISOString() ?? null,
			apiBillingOption: chatGptPlanApiBillingOption(plan, hasLlmProvider),
		}),
		{ status: 429, headers: { "Content-Type": "application/json" } },
	);
}
