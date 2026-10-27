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
	dispatchSendSignal,
	getDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { waitUntil } from "@vercel/functions";
import {
	type LanguageModel,
	type LanguageModelMiddleware,
	wrapLanguageModel,
} from "ai";
import {
	createRequestObservationMiddleware,
	hasActiveRequestObservation,
	observeRequestWire,
} from "../request-observation";
import { createStrictJsonSchemaMiddleware } from "../strict-json-schema-middleware";
import { structuredOutputCapabilityFor } from "../structured-output-capabilities";
import {
	capturePlanCredentials,
	notePlanCredentialUsed,
	planCredentialUsed,
} from "./credential-capture";
import {
	chatGptPlanExhaustedMessage,
	chatGptPlanSourceExhaustedError,
	noteChatGptPlanSourceAnswered,
	recordChatGptPlanSourceExhausted,
} from "./exhaustion-breaker";
import {
	ChatGptPlanModelNotServedError,
	type ChatGptPlanReasoningEffort,
} from "./models";
import {
	type ChatGptPlanAccessToken,
	getChatGptPlanAccessToken,
	getChatGptPlanSourceAccessToken,
	refreshChatGptPlanAfterUnauthorized,
	refreshChatGptPlanSourceAfterUnauthorized,
} from "./plan-credentials";
import {
	noteChatGptPlanReportedUsage,
	settleChatGptPlanWindowsInBackground,
} from "./reported-usage";
import { refreshChatGptPlanServedModelsInBackground } from "./served-models";
import { type PlanSourceRef, planSourceLogFields } from "./sources";
import { createChatGptPlanStructuredOutputMiddleware } from "./structured-output";

/**
 * Rules the SDK must see before it builds the request:
 * - `store: false`, or it replays earlier turns as `item_reference`s to
 *   server-stored items that do not exist for plan requests;
 * - system messages as developer messages (system items are rejected);
 * - no sampling, output cap, conversation or previous-response options;
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
 * When the plan refuses the chosen model as unsupported, retries once on the
 * organization's fallback model (Fizzy #2770 F10). No fallback, the same
 * model, or a refusal of the fallback too ends in
 * {@link ChatGptPlanModelNotServedError}, naming the chosen model. Never loops.
 * A throw from `beforeModelFallback` (the fallback model's usage limit) ends
 * the call before the fallback is sent.
 */
function createChatGptPlanModelFallbackMiddleware(params: {
	source: PlanSourceRef;
	modelId: string;
	fallbackModelId: string | null;
	buildModel: (modelId: string) => PlanResponsesModel;
	beforeModelFallback?: (modelId: string) => Promise<void>;
	onModelFallback?: (modelId: string) => void;
}): LanguageModelMiddleware {
	const { fallbackModelId } = params;
	const fallBack = async (error: unknown): Promise<PlanResponsesModel> => {
		if (!isUnsupportedModelError(error)) {
			throw error;
		}
		// OpenAI just refused a model the stored list may still name; re-read
		// the list so pickers and resolution catch up on their own.
		refreshChatGptPlanServedModelsInBackground(params.source);
		if (!fallbackModelId || fallbackModelId === params.modelId) {
			throw new ChatGptPlanModelNotServedError(params.modelId);
		}
		await params.beforeModelFallback?.(fallbackModelId);
		logger.warn(
			"[chatgpt-plan] Model not available on this plan; retrying on the fallback",
			{
				...planSourceLogFields(params.source),
				model: params.modelId,
				fallback: fallbackModelId,
			},
		);
		params.onModelFallback?.(fallbackModelId);
		return params.buildModel(fallbackModelId);
	};
	const finalOnFallback = (error: unknown): never => {
		throw isUnsupportedModelError(error)
			? new ChatGptPlanModelNotServedError(params.modelId)
			: error;
	};
	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate, params: callParams }) => {
			let retry: PlanResponsesModel;
			try {
				return await doGenerate();
			} catch (error) {
				retry = await fallBack(error);
			}
			// `ai` and `@ai-sdk/openai` resolve separate provider-type versions.
			return Promise.resolve(
				retry.doGenerate(callParams as PlanCallOptions),
			).catch(finalOnFallback);
		},
		wrapStream: async ({ doStream, params: callParams }) => {
			let retry: PlanResponsesModel;
			try {
				return await doStream();
			} catch (error) {
				retry = await fallBack(error);
			}
			return Promise.resolve(
				retry.doStream(callParams as PlanCallOptions),
			).catch(finalOnFallback);
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
		// Whatever the call writes about the source is bound to the sign-in
		// its token came from (Fizzy #3037).
		const { notes, result: calling } = capturePlanCredentials(call);
		let result: T;
		try {
			result = await calling;
		} catch (error) {
			const exhausted = toSubscriptionPlanExhaustedError(error);
			if (exhausted) {
				await recordChatGptPlanSourceExhausted(
					ref,
					planCredentialUsed(notes, ref),
					exhausted,
				);
				throw new SubscriptionPlanExhaustedError(
					chatGptPlanExhaustedMessage(exhausted.resetAt),
					exhausted.resetAt,
				);
			}
			throw error;
		}
		await noteChatGptPlanSourceAnswered(
			ref,
			planCredentialUsed(notes, ref),
		);
		settleChatGptPlanWindowsInBackground(ref);
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
	sessionKey?: string;
	userId: string;
	/** The plan that serves the call; the member's own plan when omitted. */
	source?: PlanSourceRef;
	modelId: string;
	/** The organization's fallback for a model the plan refuses; null for none. */
	fallbackModelId?: string | null;
	reasoningEffort?: ChatGptPlanReasoningEffort;
	/**
	 * Runs before the call moves to the fallback model; a throw (a usage
	 * limit on that model) ends the call there instead.
	 */
	beforeModelFallback?: (modelId: string) => Promise<void>;
	/** Told the model that actually served the call after a fallback. */
	onModelFallback?: (modelId: string) => void;
	/**
	 * Applied to every model a request is physically sent through: the plan's
	 * own model and the fallback model the fallback middleware calls directly.
	 * The factory wraps each in the turn token ledger here, so every physical
	 * send — the first, the fallback, and (through the rotation building a new
	 * plan model) every account it moves to — reserves and settles on its own.
	 */
	wrapPhysicalModel?: (model: PlanResponsesModel) => PlanResponsesModel;
	/**
	 * Handed each background write of a reply's reported usage, for a caller
	 * that must not answer before it lands (the plan Test). Never rejects.
	 */
	onUsageReport?: (write: Promise<void>) => void;
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
	sessionKey,
	userId,
	source = { kind: "user", userId },
	modelId,
	fallbackModelId = null,
	reasoningEffort,
	beforeModelFallback,
	onModelFallback,
	wrapPhysicalModel = (model) => model,
	onUsageReport,
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
	// Each token read tells the call which sign-in it is using.
	let lastFingerprint: string | undefined;
	const used = (token: ChatGptPlanAccessToken): string => {
		notePlanCredentialUsed(source, token.credentialFingerprint);
		lastFingerprint = token.credentialFingerprint;
		return token.accessToken;
	};
	// Every reply — a 429 included, before it is remapped — may carry the
	// plan's own usage report; it is stored in the background, kept alive
	// past the response on Vercel, where a bare promise may never finish.
	const onResponseHeaders = (status: number, headers: Headers): void => {
		logChatGptPlanHeaders(status, headers);
		const write = noteChatGptPlanReportedUsage(source, {
			status,
			headers,
			credentialFingerprint: lastFingerprint,
		});
		waitUntil(write);
		onUsageReport?.(write);
	};
	const physicalModel = (id: string) =>
		wrapPhysicalModel(
			wrapLanguageModel({
				model: provider.responses(id),
				middleware: createRequestObservationMiddleware(),
			}) as unknown as PlanResponsesModel,
		);
	const provider = createOpenAI({
		apiKey: "chatgpt-plan",
		// Pinned: OPENAI_BASE_URL must never redirect a plan token.
		baseURL: `${CHATGPT_PLAN_ORIGIN}/v1`,
		fetch: createChatGptPlanFetch({
			sessionKey,
			getAccessToken: async () => used(await tokens.get()),
			onUnauthorized: async (failedToken) =>
				used(await tokens.refresh(failedToken)),
			onResponseHeaders,
			// Inside an Advisor chat turn (the ambient dispatch guard), every
			// physical send is checked at the fetch itself, synchronously:
			// the token lookup and, after a 401, the token refresh are awaited
			// after the model middleware's check, so a stop latched during
			// them refuses the send, and the send carries the guard's abort
			// signal. A resend after a 401 also passes the turn's durable
			// dispatch check first. It is not reserved again: the 401 billed
			// nothing, and the one reservation this physical model made
			// (`wrapPhysicalModel`) covers the one send that is billed. A
			// no-op outside a turn.
			beforeSend: dispatchSendSignal,
			beforeResend: async () => {
				await getDispatchGuard()?.assertDispatchable();
			},
			baseFetch: (request, init) => {
				try {
					if (
						hasActiveRequestObservation() &&
						typeof init?.body === "string"
					) {
						observeRequestWire(
							JSON.parse(init.body),
							"chatgpt-plan-responses",
							new Headers(init.headers).get("session_id"),
						);
					}
				} catch {
					/* Observation does not change the transport request. */
				}
				return (fetchImpl ?? fetch)(request, init);
			},
		}),
	});
	return wrapLanguageModel({
		model: physicalModel(modelId),
		middleware: [
			createChatGptPlanExhaustionMiddleware(source),
			createChatGptPlanRequestMiddleware(reasoningEffort),
			createChatGptPlanStructuredOutputMiddleware(),
			createChatGptPlanModelFallbackMiddleware({
				source,
				modelId,
				fallbackModelId,
				buildModel: (id) => physicalModel(id),
				beforeModelFallback,
				onModelFallback,
			}),
			createStrictJsonSchemaMiddleware(
				structuredOutputCapabilityFor(
					"OPENAI_CHATGPT_PLAN",
					false,
					modelId,
				),
			),
		],
	});
}
