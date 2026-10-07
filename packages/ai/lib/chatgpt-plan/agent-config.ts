import {
	CHATGPT_PLAN_EXHAUSTED_CODE,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { chatGptPlanSourceExhaustedError } from "./exhaustion-breaker";
import {
	CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
	ChatGptPlanAuthError,
} from "./oauth";
import {
	getChatGptPlanAccessToken,
	getChatGptPlanSourceAccessToken,
} from "./plan-credentials";
import { type PlanSourceRef, planSourceKey } from "./sources";

/**
 * What an agent receives in place of a provider key when the resolver chose
 * a ChatGPT plan — the member's own or an organization's shared account: the
 * server-refreshed access token and the plan's model, never the
 * organization's key, base URL or deployment.
 */
export interface ChatGptPlanAgentConfig {
	provider: "OPENAI_CHATGPT_PLAN";
	apiKey: string;
	model: string;
	gatewayUrl: null;
	deploymentName: null;
	isReasoningModel: false;
}

export type ChatGptPlanAgentConfigResult =
	| {
			ok: true;
			config: ChatGptPlanAgentConfig;
			expiresAt: Date;
			/** The plan's opaque key, for the agent to exclude after a refusal. */
			planSource: string;
	  }
	| {
			ok: false;
			status: 409 | 429;
			code: "CHATGPT_PLAN_UNAVAILABLE" | "CHATGPT_PLAN_EXHAUSTED";
			error: string;
			/** When a spent window resets, when OpenAI said. */
			resetAt?: string | null;
	  };

export async function getChatGptPlanAgentConfig(params: {
	userId: string;
	model: string;
	/** The plan the resolver chose; the member's own when omitted. */
	source?: PlanSourceRef;
}): Promise<ChatGptPlanAgentConfigResult> {
	const source: PlanSourceRef = params.source ?? {
		kind: "user",
		userId: params.userId,
	};
	const exhausted = await chatGptPlanSourceExhaustedError(source);
	if (exhausted) {
		return {
			ok: false,
			status: 429,
			code: "CHATGPT_PLAN_EXHAUSTED",
			error: exhausted.message,
			resetAt: exhausted.resetAt?.toISOString() ?? null,
		};
	}
	try {
		const token =
			source.kind === "user"
				? await getChatGptPlanAccessToken(source.userId)
				: await getChatGptPlanSourceAccessToken(source);
		return {
			ok: true,
			expiresAt: token.expiresAt,
			planSource: planSourceKey(source),
			config: {
				provider: "OPENAI_CHATGPT_PLAN",
				apiKey: token.accessToken,
				model: params.model,
				gatewayUrl: null,
				deploymentName: null,
				isReasoningModel: false,
			},
		};
	} catch {
		return {
			ok: false,
			status: 409,
			code: "CHATGPT_PLAN_UNAVAILABLE",
			error: CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
		};
	}
}

/**
 * The 409 an agent route answers when resolving the model refused because
 * the member's plan needs reconnecting; never the organization's key.
 */
export function chatGptPlanReconnectRefusal(error: unknown): {
	status: 409;
	body: { error: string; code: "CHATGPT_PLAN_UNAVAILABLE" };
} | null {
	return error instanceof ChatGptPlanAuthError
		? {
				status: 409,
				body: {
					error: CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
					code: "CHATGPT_PLAN_UNAVAILABLE",
				},
			}
		: null;
}

/**
 * The 429 an agent route answers when every ChatGPT plan that would serve the
 * call is spent (Fizzy #2770) — never the organization's key.
 */
export function chatGptPlanExhaustedRefusal(error: unknown): {
	status: 429;
	body: {
		error: string;
		code: "CHATGPT_PLAN_EXHAUSTED";
		resetAt: string | null;
	};
} | null {
	return error instanceof SubscriptionPlanExhaustedError
		? {
				status: 429,
				body: {
					error: error.message,
					code: "CHATGPT_PLAN_EXHAUSTED",
					resetAt: error.resetAt?.toISOString() ?? null,
				},
			}
		: null;
}

/**
 * The response a chat route answers when resolving the model already found
 * every ChatGPT plan spent (Fizzy #2770), before any stream exists. It carries
 * the provider's own exhaustion code, so the client's limit classifier shows
 * the same "plan has no usage left" notice as for a plan spent mid-reply, and
 * the message names the reset time.
 */
export function chatGptPlanExhaustedChatResponse(
	error: unknown,
): Response | null {
	if (!(error instanceof SubscriptionPlanExhaustedError)) {
		return null;
	}
	return new Response(
		JSON.stringify({
			error: error.message,
			code: CHATGPT_PLAN_EXHAUSTED_CODE,
			resetAt: error.resetAt?.toISOString() ?? null,
		}),
		{ status: 429, headers: { "Content-Type": "application/json" } },
	);
}
