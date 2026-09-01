/**
 * Global AI usage interceptor.
 *
 * Installed on every language model built by `getModel` (packages/ai/model-factory.ts),
 * so EVERY current and future in-process model call — one-shot `generateObject`/
 * `generateText` AND streaming `streamText`, whether issued by an API procedure, a
 * Temporal activity, the agent orchestrator, MCP sampling, or code not yet written —
 * records an `AiUsageLog` row by construction. Callers no longer have to remember to
 * call `logModelUsageAsync`; that function is now a no-op superseded by this
 * middleware (see usage-logging.ts).
 *
 * It is the SINGLE source of truth for language-model usage. It captures the full
 * provider token breakdown — including prompt-cache reads/writes and reasoning
 * tokens — so `estimateAiUsageCostUsd` can price cached calls at their real rates.
 *
 * Best-effort + non-throwing: a logging failure must never break the model call, so
 * every side effect is wrapped and fired async.
 *
 * Embedding models get the same guarantee via wrapEmbeddingModelWithUsageLogging
 * (installed in getAIEmbeddingModelWithMetadata).
 *
 * NOT covered (and intentionally so): the separate LangGraph agent runtimes under
 * `agents/**` call the Vercel gateway directly in their own processes and never
 * touch this factory — they need gateway-side/token-exchange accounting. A few
 * call sites also build a raw provider client or a hardcoded model string instead
 * of resolving through the factory (e.g. an inline `embed({ model: "openai:..." })`);
 * those must migrate to the resolver to be counted.
 */

import { logAiUsageAsync } from "@repo/database";
import type {
	AIProvider,
	AiTaskType,
	AiUsageBillingCategory,
} from "@repo/database/prisma/generated/client";
import { logger } from "@repo/logs";
import type { EmbeddingModel, LanguageModel } from "ai";
import { wrapEmbeddingModel, wrapLanguageModel } from "ai";

/** Everything the interceptor needs to attribute a call, captured at model resolution. */
export interface UsageLoggingContext {
	userId?: string;
	organizationId?: string;
	projectId?: string;
	provider: AIProvider;
	/** Provider-specific model id actually invoked (the model string). */
	providerModelId: string;
	modelCanonicalName?: string;
	providerConfigId?: string;
	taskType?: AiTaskType;
	billingCategory?: AiUsageBillingCategory | null;
	billingCustomerId?: string | null;
	agentId?: string;
	conversationId?: string;
	/** User-facing AI feature this call belongs to (Fizzy #2230). */
	featureKey?: string;
	/** Resolved PromptVersion id the call ran with, when known. */
	promptVersionId?: string;
	/**
	 * Scheduled/background pipeline that issued this call (Fizzy #1894).
	 * Undefined = user-initiated. Use a key from AI_JOB_TYPES.
	 */
	jobType?: string;
}

type NormalizedUsage = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
	/**
	 * The field names the provider actually sent, kept for the all-zero warning
	 * below and never persisted. A provider reporting usage under a name this
	 * normalizer does not read is indistinguishable from one reporting none at
	 * all; naming the keys is what turns the next occurrence into a fix rather
	 * than another round of guessing.
	 */
	observedKeys: string[];
};

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Read one field out of a nested token breakdown, ignoring anything that is not
 * an object (the flat shape, where the same key holds the count itself).
 */
function part(value: unknown, key: string): number {
	return typeof value === "object" && value !== null
		? num((value as Record<string, unknown>)[key])
		: 0;
}

/**
 * A token count that may arrive either as a plain number or, since the AI SDK v6
 * provider interface, as a `{ total, … }` breakdown object.
 *
 * Exported because any caller reading a token count off `usage` needs both
 * shapes: a plain `typeof value === "number"` test silently yields nothing on
 * the providers that report the breakdown, which turns a diagnostic number into
 * a missing one exactly when it is being used to diagnose something.
 */
export function readTokenCount(value: unknown): number {
	return typeof value === "number" ? num(value) : part(value, "total");
}

/**
 * Normalize the AI SDK's `usage` + `providerMetadata` into our token buckets. The
 * SDK surfaces cache reads on `usage.cachedInputTokens`; Anthropic's cache-WRITE
 * count is only on provider metadata, so read it from both shapes defensively.
 */
function normalizeUsage(
	usage: unknown,
	providerMetadata: unknown,
): NormalizedUsage {
	const u = (usage ?? {}) as Record<string, unknown>;
	// `inputTokens`/`outputTokens` are NOT always numbers. The v6 provider
	// interface reports them as breakdown objects —
	// `{ total, noCache, cacheRead, cacheWrite }` and `{ total, text, reasoning }`
	// (see @ai-sdk/openai, /anthropic and /groq v3, which all build this shape
	// alongside a `raw` passthrough of the provider's original payload). Reading
	// those with a plain number cast yields NaN → 0, and an all-zero count is
	// what this middleware treats as "no billing signal" and drops — so every
	// generation through those providers went unrecorded while the call itself
	// succeeded. `count` accepts both shapes; the OpenAI-compatible aliases
	// after it cover an endpoint that hands its usage back unmapped.
	const inputTokens =
		readTokenCount(u.inputTokens) ||
		num(u.promptTokens) ||
		num(u.prompt_tokens);
	const outputTokens =
		readTokenCount(u.outputTokens) ||
		num(u.completionTokens) ||
		num(u.completion_tokens);
	const totalTokens =
		num(u.totalTokens) || num(u.total_tokens) || inputTokens + outputTokens;
	const cachedInputTokens =
		num(u.cachedInputTokens) ||
		part(u.inputTokens, "cacheRead") ||
		num(
			(u.inputTokenDetails as Record<string, unknown> | undefined)
				?.cacheReadTokens,
		);
	const reasoningTokens =
		num(u.reasoningTokens) ||
		part(u.outputTokens, "reasoning") ||
		num(
			(u.outputTokenDetails as Record<string, unknown> | undefined)
				?.reasoningTokens,
		);
	// Anthropic reports cache-creation tokens only on provider metadata.
	const anthropic = (
		(providerMetadata ?? {}) as Record<string, Record<string, unknown>>
	).anthropic;
	const cacheCreationInputTokens =
		num(u.cacheCreationInputTokens) ||
		part(u.inputTokens, "cacheWrite") ||
		num(anthropic?.cacheCreationInputTokens);

	return {
		inputTokens,
		outputTokens,
		totalTokens,
		cachedInputTokens,
		cacheCreationInputTokens,
		reasoningTokens,
		observedKeys: Object.keys(u),
	};
}

/**
 * The Vercel AI Gateway stamps each response with a generation id on
 * providerMetadata.gateway.generationId; its real billed cost is fetched later
 * via GET /v1/generation. Absent for non-gateway providers.
 */
function gatewayGenerationIdOf(providerMetadata: unknown): string | undefined {
	const gateway = (
		(providerMetadata ?? {}) as Record<string, Record<string, unknown>>
	).gateway;
	const id = gateway?.generationId;
	return typeof id === "string" ? id : undefined;
}

/**
 * A usage write that fails is spend the product can no longer see. It must not
 * break the model call, so it stays swallowed — but swallowed and unlogged is
 * how a ledger goes quietly blind.
 */
function logUsageWriteFailure(
	context: UsageLoggingContext,
	error: unknown,
): void {
	logger.warn("ai.usage.record_failed", {
		provider: context.provider,
		providerModelId: context.providerModelId,
		taskType: context.taskType,
		projectId: context.projectId ?? null,
		error: error instanceof Error ? error.message : String(error),
	});
}

function emit(
	context: UsageLoggingContext,
	usage: NormalizedUsage,
	latencyMs: number,
	success: boolean,
	errorMessage?: string,
	gatewayGenerationId?: string,
): void {
	// A row with zero tokens across the board usually carries no billing signal
	// (a provider that didn't resolve usage, or a throw before any tokens); a
	// SUCCESSFUL zero-token row is skipped as noise. A FAILED call is different:
	// the invocation happened and must be visible in the ledger even though the
	// SDK surfaced no usage for it (Fizzy #1894 FR7), so failures fall through.
	if (
		success &&
		usage.inputTokens === 0 &&
		usage.outputTokens === 0 &&
		usage.totalTokens === 0
	) {
		// A call that SUCCEEDED and still reports nothing means this provider is
		// not resolving usage at all — every generation it serves is then absent
		// from the ledger, and the only symptom is a spend figure that never
		// moves. Say so once per call rather than dropping it silently.
		logger.warn("ai.usage.no_tokens_reported", {
			provider: context.provider,
			providerModelId: context.providerModelId,
			taskType: context.taskType,
			projectId: context.projectId ?? null,
			// Field NAMES only — never their values, and never any content.
			observedUsageKeys: usage.observedKeys,
		});
		return;
	}
	// Logging must NEVER break the model call: swallow a synchronous throw and,
	// since logAiUsageAsync is fire-and-forget, a rejected promise too.
	try {
		const pending = logAiUsageAsync({
			userId: context.userId,
			organizationId: context.organizationId,
			projectId: context.projectId,
			provider: context.provider,
			providerConfigId: context.providerConfigId,
			providerModelId: context.providerModelId,
			modelCanonicalName: context.modelCanonicalName,
			taskType: context.taskType,
			agentId: context.agentId,
			conversationId: context.conversationId,
			featureKey: context.featureKey,
			promptVersionId: context.promptVersionId,
			jobType: context.jobType,
			billingCategory: context.billingCategory ?? null,
			billingCustomerId: context.billingCustomerId ?? null,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			totalTokens: usage.totalTokens,
			cachedInputTokens: usage.cachedInputTokens,
			cacheCreationInputTokens: usage.cacheCreationInputTokens,
			reasoningTokens: usage.reasoningTokens,
			latencyMs,
			success,
			errorMessage,
			gatewayGenerationId,
		}) as unknown;
		if (
			pending &&
			typeof (pending as { then?: unknown }).then === "function"
		) {
			(pending as Promise<unknown>).catch((error: unknown) => {
				logUsageWriteFailure(context, error);
			});
		}
	} catch (error) {
		// Never propagate — but never silent either. This is the single writer
		// of the usage ledger, so a failure here is not a lost log line, it is
		// spend that no longer exists as far as the product is concerned.
		logUsageWriteFailure(context, error);
	}
}

type WrapMiddleware = Parameters<typeof wrapLanguageModel>[0]["middleware"];

/**
 * Build the usage-logging middleware for one resolved model. Returns a
 * `LanguageModelV2Middleware` that logs exactly one row per model round-trip
 * (`doGenerate` or a completed `doStream`).
 */
export function createUsageLoggingMiddleware(
	context: UsageLoggingContext,
): WrapMiddleware {
	const middleware = {
		wrapGenerate: async ({
			doGenerate,
		}: {
			doGenerate: () => Promise<Record<string, unknown>>;
		}) => {
			const start = Date.now();
			try {
				const result = await doGenerate();
				try {
					emit(
						context,
						normalizeUsage(result.usage, result.providerMetadata),
						Date.now() - start,
						true,
						undefined,
						gatewayGenerationIdOf(result.providerMetadata),
					);
				} catch {
					// never let logging break the call
				}
				return result;
			} catch (error) {
				// A failed call may still have consumed tokens upstream, but the SDK
				// gives us no usage on throw — record a zero-token failure marker so
				// the error is at least visible in the activity view.
				try {
					emit(
						context,
						normalizeUsage(undefined, undefined),
						Date.now() - start,
						false,
						error instanceof Error ? error.message : String(error),
					);
				} catch {
					/* ignore */
				}
				throw error;
			}
		},
		wrapStream: async ({
			doStream,
		}: {
			doStream: () => Promise<Record<string, unknown>>;
		}) => {
			const start = Date.now();
			let result: Record<string, unknown>;
			try {
				result = await doStream();
			} catch (error) {
				// Mirror wrapGenerate: a stream that never opens (provider
				// unreachable, auth rejected before the first chunk) must still
				// leave its failure in the ledger (Fizzy #1894 FR7).
				try {
					emit(
						context,
						normalizeUsage(undefined, undefined),
						Date.now() - start,
						false,
						error instanceof Error ? error.message : String(error),
					);
				} catch {
					/* ignore */
				}
				throw error;
			}
			const originalStream = result.stream as ReadableStream<
				Record<string, unknown>
			>;
			let captured = false;
			const tap = new TransformStream<
				Record<string, unknown>,
				Record<string, unknown>
			>({
				transform(chunk, controller) {
					// The terminal chunk of a stream ('finish') carries final usage.
					if (!captured && chunk?.type === "finish") {
						captured = true;
						try {
							emit(
								context,
								normalizeUsage(
									chunk.usage,
									chunk.providerMetadata,
								),
								Date.now() - start,
								true,
								undefined,
								gatewayGenerationIdOf(chunk.providerMetadata),
							);
						} catch {
							/* ignore */
						}
					} else if (!captured && chunk?.type === "error") {
						// An errored stream never reaches 'finish'; record the
						// failure so the invocation is visible in the ledger
						// instead of vanishing (Fizzy #1894 FR7).
						captured = true;
						try {
							const err = (chunk as Record<string, unknown>)
								.error;
							emit(
								context,
								normalizeUsage(
									chunk.usage,
									chunk.providerMetadata,
								),
								Date.now() - start,
								false,
								err instanceof Error
									? err.message
									: typeof err === "string"
										? err
										: "stream error",
							);
						} catch {
							/* ignore */
						}
					}
					controller.enqueue(chunk);
				},
			});
			return { ...result, stream: originalStream.pipeThrough(tap) };
		},
	};
	return middleware as unknown as WrapMiddleware;
}

/**
 * Wrap a resolved language model so every call it makes records usage. Applied
 * once inside `getAIModelWithMetadata`, it makes usage logging automatic for every
 * caller of that resolver — the single global choke point for in-process models.
 */
export function wrapModelWithUsageLogging(
	model: LanguageModel,
	context: UsageLoggingContext,
): LanguageModel {
	return wrapLanguageModel({
		model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
		middleware: createUsageLoggingMiddleware(context),
	}) as LanguageModel;
}

type WrapEmbeddingMiddleware = Parameters<
	typeof wrapEmbeddingModel
>[0]["middleware"];

/**
 * Embedding-model counterpart of the language interceptor. An embedding call
 * reports only prompt `tokens` (no completion), logged as inputTokens with the
 * EMBEDDING task type. Applied inside getAIEmbeddingModelWithMetadata.
 */
export function createEmbeddingUsageLoggingMiddleware(
	context: UsageLoggingContext,
): WrapEmbeddingMiddleware {
	const middleware = {
		wrapEmbed: async ({
			doEmbed,
		}: {
			doEmbed: () => Promise<Record<string, unknown>>;
		}) => {
			const start = Date.now();
			const result = await doEmbed();
			try {
				const tokens = num(
					(result.usage as Record<string, unknown> | undefined)
						?.tokens,
				);
				emit(
					context,
					{
						inputTokens: tokens,
						outputTokens: 0,
						totalTokens: tokens,
						cachedInputTokens: 0,
						cacheCreationInputTokens: 0,
						reasoningTokens: 0,
						observedKeys: [],
					},
					Date.now() - start,
					true,
				);
			} catch {
				/* never let logging break the embed call */
			}
			return result;
		},
	};
	return middleware as unknown as WrapEmbeddingMiddleware;
}

/**
 * Wrap a resolved embedding model so every embed call records usage. Applied once
 * inside getAIEmbeddingModelWithMetadata — the choke point for in-process
 * embedding models.
 */
export function wrapEmbeddingModelWithUsageLogging(
	model: EmbeddingModel,
	context: UsageLoggingContext,
): EmbeddingModel {
	return wrapEmbeddingModel({
		model: model as Parameters<typeof wrapEmbeddingModel>[0]["model"],
		middleware: createEmbeddingUsageLoggingMiddleware(context),
	}) as EmbeddingModel;
}
