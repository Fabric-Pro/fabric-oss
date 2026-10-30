import {
	CHATGPT_PLAN_API_BILLING_HEADER,
	CHATGPT_PLAN_EXHAUSTED_CODE,
	CHATGPT_PLAN_PERSONAL_KEY_HEADER,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { getAiProviderApiKey } from "@repo/database";
import {
	type ChatGptPlanSourcesExhausted,
	chatGptPlanInteractiveApiFallback,
	chatGptPlanPersonalKeyFallback,
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
 * What a chat route does before starting a turn when every ChatGPT plan that
 * would serve the member's interactive work is spent (Fizzy #2770):
 * - `refusal` — the 429 to answer with when it resets, instead of falling
 *   through to the organization's provider or starting a run that can only
 *   fail;
 * - `apiBilling` — the organization's "Use API billing" policy runs the turn
 *   on its provider (Fizzy #3048), and the member is told until when;
 * - `personalKey` — the organization would stop the turn, and the member's
 *   own key they opted in runs it instead (Fizzy #3085); they are told which
 *   provider and until when. The refusal otherwise carries
 *   `personalKeyOption`, so the stop message can link to that opt-in.
 *
 * Null when a plan or no plan serves the turn; a fault reads as null, leaving
 * the route's own resolution to decide.
 */
export type ChatGptPlanChatPreflight =
	| { refusal: Response }
	| { apiBilling: { resetAt: Date | null } }
	| { personalKey: { provider: string; resetAt: Date | null } }
	| null;

export async function chatGptPlanChatPreflight(context: {
	userId: string;
	organizationId?: string | null;
}): Promise<ChatGptPlanChatPreflight> {
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
	if (await chatGptPlanInteractiveApiFallback(plan, context.organizationId)) {
		return { apiBilling: { resetAt: plan.resetAt } };
	}
	const personal = await chatGptPlanPersonalKeyFallback(plan, context);
	if (personal?.config?.provider) {
		return {
			personalKey: {
				provider: personal.config.provider,
				resetAt: plan.resetAt,
			},
		};
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
	return {
		refusal: new Response(
			JSON.stringify({
				error: error.message,
				code: CHATGPT_PLAN_EXHAUSTED_CODE,
				resetAt: error.resetAt?.toISOString() ?? null,
				apiBillingOption: chatGptPlanApiBillingOption(
					plan,
					hasLlmProvider,
				),
				personalKeyOption: personal !== null,
			}),
			{ status: 429, headers: { "Content-Type": "application/json" } },
		),
	};
}

/**
 * What a chat turn tells the member about its billing (Fizzy #3048): when
 * it runs on the organization's API billing, the plans' reset time (null
 * when unknown); when it runs on the member's own key (Fizzy #3086), that
 * key's provider as well. Null when the turn runs on a plan as usual.
 */
export function chatGptPlanApiBillingMarker(
	preflight: ChatGptPlanChatPreflight,
): { resetAt: Date | null; personalKeyProvider?: string } | null {
	if (!preflight || "refusal" in preflight) {
		return null;
	}
	if ("personalKey" in preflight) {
		return {
			resetAt: preflight.personalKey.resetAt,
			personalKeyProvider: preflight.personalKey.provider,
		};
	}
	return { resetAt: preflight.apiBilling.resetAt };
}

/**
 * Marks a chat route's stream whose turn runs on the organization's API
 * billing (Fizzy #3048) with the plans' reset time, or empty when it is
 * unknown, so the chat can say so under the reply. A turn on the member's
 * own key (Fizzy #3086) also names that key's provider. Otherwise unchanged.
 */
export function withChatGptPlanApiBilling(
	response: Response,
	preflight: ChatGptPlanChatPreflight,
): Response {
	const marker = chatGptPlanApiBillingMarker(preflight);
	if (!response.ok || !marker) {
		return response;
	}
	response.headers.set(
		CHATGPT_PLAN_API_BILLING_HEADER,
		marker.resetAt?.toISOString() ?? "",
	);
	if (marker.personalKeyProvider !== undefined) {
		response.headers.set(
			CHATGPT_PLAN_PERSONAL_KEY_HEADER,
			marker.personalKeyProvider,
		);
	}
	return response;
}
