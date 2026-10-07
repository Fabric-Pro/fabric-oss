import { createOpenAI } from "@ai-sdk/openai";
import {
	CHATGPT_PLAN_ORIGIN,
	createChatGptPlanFetch,
	redactChatGptPlanHeaders,
	SubscriptionPlanExhaustedError,
	toSubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { logger } from "@repo/logs";
import {
	type LanguageModel,
	type LanguageModelMiddleware,
	wrapLanguageModel,
} from "ai";
import {
	chatGptPlanExhaustedMessage,
	chatGptPlanSourceExhaustedError,
	noteChatGptPlanSourceAnswered,
	recordChatGptPlanSourceExhausted,
} from "./exhaustion-breaker";
import {
	CHATGPT_PLAN_HEAVY_MODEL,
	type ChatGptPlanReasoningEffort,
	recordChatGptPlanModelUnsupported,
} from "./models";
import {
	getChatGptPlanAccessToken,
	getChatGptPlanSourceAccessToken,
	refreshChatGptPlanAfterUnauthorized,
	refreshChatGptPlanSourceAfterUnauthorized,
} from "./plan-credentials";
import { type PlanSourceRef, planSourceLogFields } from "./sources";

/**
 * Rules the SDK must see before it builds the request:
 * - `store: false`, or it replays earlier turns as `item_reference`s to
 *   server-stored items that do not exist for plan requests;
 * - system messages as developer messages (system items are rejected);
 * - no sampling, output cap, conversation or previous-response options;
 * - non-strict JSON schemas: strict mode demands every property in
 *   `required`, and Fabric's schemas use optional fields;
 * - the task's reasoning effort, unless the caller chose one.
 */
export function createChatGptPlanRequestMiddleware(
	reasoningEffort?: ChatGptPlanReasoningEffort,
): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		transformParams: async ({ params }) => {
			const {
				temperature: _temperature,
				topP: _topP,
				maxOutputTokens: _maxOutputTokens,
				...rest
			} = params;
			const {
				previousResponseId: _previousResponseId,
				conversation: _conversation,
				user: _user,
				metadata: _metadata,
				serviceTier: _serviceTier,
				...keptOpenaiOptions
			} = (rest.providerOptions?.openai ?? {}) as Record<string, unknown>;
			return {
				...rest,
				providerOptions: {
					...rest.providerOptions,
					openai: {
						strictJsonSchema: false,
						...(reasoningEffort && { reasoningEffort }),
						...keptOpenaiOptions,
						store: false,
						systemMessageMode: "developer",
					},
				},
			};
		},
	};
}

export const chatGptPlanRequestMiddleware =
	createChatGptPlanRequestMiddleware();

/**
 * Whether the plan refused the model itself — a Plus account cannot use every
 * model a Pro account can — rather than the request.
 */
export function isUnsupportedModelError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}
	const bag = error as {
		statusCode?: unknown;
		responseBody?: unknown;
		message?: unknown;
	};
	if (bag.statusCode !== 400 && bag.statusCode !== 404) {
		return false;
	}
	const text = `${String(bag.responseBody ?? "")} ${String(bag.message ?? "")}`;
	return (
		/model_not_found|unsupported_model/i.test(text) ||
		(/\bmodel\b/i.test(text) &&
			/not supported|unsupported|does not exist|not found|not available/i.test(
				text,
			))
	);
}

export type PlanResponsesModel = ReturnType<
	ReturnType<typeof createOpenAI>["responses"]
>;
export type PlanCallOptions = Parameters<PlanResponsesModel["doGenerate"]>[0];

/**
 * Retries once on the heavy default when the plan refuses the chosen model,
 * and remembers the refusal so the next call goes straight to it. Never loops:
 * the heavy model's own failure is final.
 */
function createChatGptPlanModelFallbackMiddleware(params: {
	source: PlanSourceRef;
	modelId: string;
	fallbackModel: () => PlanResponsesModel;
	onModelFallback?: (modelId: string) => void;
}): LanguageModelMiddleware {
	const fallBack = (error: unknown) => {
		if (
			params.modelId === CHATGPT_PLAN_HEAVY_MODEL ||
			!isUnsupportedModelError(error)
		) {
			throw error;
		}
		logger.warn(
			"[chatgpt-plan] Model not available on this plan; retrying on the default",
			{
				...planSourceLogFields(params.source),
				model: params.modelId,
				fallback: CHATGPT_PLAN_HEAVY_MODEL,
			},
		);
		recordChatGptPlanModelUnsupported(params.source, params.modelId);
		params.onModelFallback?.(CHATGPT_PLAN_HEAVY_MODEL);
		return params.fallbackModel();
	};
	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate, params: callParams }) => {
			try {
				return await doGenerate();
			} catch (error) {
				// `ai` and `@ai-sdk/openai` resolve separate provider-type versions.
				return fallBack(error).doGenerate(
					callParams as PlanCallOptions,
				);
			}
		},
		wrapStream: async ({ doStream, params: callParams }) => {
			try {
				return await doStream();
			} catch (error) {
				return fallBack(error).doStream(callParams as PlanCallOptions);
			}
		},
	};
}

/**
 * Fails fast while this plan source's window is known to be spent, and turns
 * the provider's refusal into a `SubscriptionPlanExhaustedError` — a type
 * Temporal and the limit classifier recognize — remembering it, for every
 * process, for the calls that follow. A bare userId is the member's own plan.
 */
export function createChatGptPlanExhaustionMiddleware(
	source: string | PlanSourceRef,
): LanguageModelMiddleware {
	const ref: PlanSourceRef =
		typeof source === "string" ? { kind: "user", userId: source } : source;
	const guard = async <T>(call: () => PromiseLike<T>): Promise<T> => {
		const open = await chatGptPlanSourceExhaustedError(ref);
		if (open) {
			throw open;
		}
		let result: T;
		try {
			result = await call();
		} catch (error) {
			const exhausted = toSubscriptionPlanExhaustedError(error);
			if (exhausted) {
				await recordChatGptPlanSourceExhausted(ref, exhausted);
				throw new SubscriptionPlanExhaustedError(
					chatGptPlanExhaustedMessage(exhausted.resetAt),
					exhausted.resetAt,
				);
			}
			throw error;
		}
		await noteChatGptPlanSourceAnswered(ref);
		return result;
	};
	return {
		specificationVersion: "v4",
		wrapGenerate: ({ doGenerate }) => guard(doGenerate),
		wrapStream: ({ doStream }) => guard(doStream),
	};
}

/**
 * Logs each plan reply's headers, redacted, while CHATGPT_PLAN_HEADER_DEBUG=1
 * — to learn whether OpenAI reports the usage window anywhere the documented
 * error body does not. Read per call, so the switch needs no restart.
 */
function logChatGptPlanHeaders(status: number, headers: Headers): void {
	if (process.env.CHATGPT_PLAN_HEADER_DEBUG !== "1") {
		return;
	}
	logger.info("[chatgpt-plan] Response headers", {
		status,
		headers: redactChatGptPlanHeaders(headers),
	});
}

export interface ChatGptPlanModelOptions {
	userId: string;
	/** The plan that serves the call; the member's own plan when omitted. */
	source?: PlanSourceRef;
	modelId: string;
	reasoningEffort?: ChatGptPlanReasoningEffort;
	/** Told the model that actually served the call after a fallback. */
	onModelFallback?: (modelId: string) => void;
	/** For tests; production calls go to api.openai.com. */
	fetchImpl?: typeof fetch;
}

/**
 * A Responses model billed to one ChatGPT plan: the member's own, or an
 * organization's shared account. Built per call: the access token is looked
 * up (and refreshed when due) for every request, never shared between
 * sources.
 */
export function createChatGptPlanModel({
	userId,
	source = { kind: "user", userId },
	modelId,
	reasoningEffort,
	onModelFallback,
	fetchImpl,
}: ChatGptPlanModelOptions): LanguageModel {
	// The member's own plan keeps the phase-1 entry points.
	const tokens =
		source.kind === "user"
			? {
					get: () => getChatGptPlanAccessToken(source.userId),
					refresh: (failed: string) =>
						refreshChatGptPlanAfterUnauthorized(
							source.userId,
							failed,
						),
				}
			: {
					get: () => getChatGptPlanSourceAccessToken(source),
					refresh: (failed: string) =>
						refreshChatGptPlanSourceAfterUnauthorized(
							source,
							failed,
						),
				};
	const provider = createOpenAI({
		apiKey: "chatgpt-plan",
		// Pinned: OPENAI_BASE_URL must never redirect a plan token.
		baseURL: `${CHATGPT_PLAN_ORIGIN}/v1`,
		fetch: createChatGptPlanFetch({
			getAccessToken: async () => (await tokens.get()).accessToken,
			onUnauthorized: async (failedToken) =>
				(await tokens.refresh(failedToken)).accessToken,
			onResponseHeaders: logChatGptPlanHeaders,
			...(fetchImpl && { baseFetch: fetchImpl }),
		}),
	});
	return wrapLanguageModel({
		model: provider.responses(modelId),
		middleware: [
			createChatGptPlanExhaustionMiddleware(source),
			createChatGptPlanRequestMiddleware(reasoningEffort),
			createChatGptPlanModelFallbackMiddleware({
				source,
				modelId,
				fallbackModel: () =>
					provider.responses(CHATGPT_PLAN_HEAVY_MODEL),
				onModelFallback,
			}),
		],
	});
}
