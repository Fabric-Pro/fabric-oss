/**
 * Global AI usage interceptor.
 *
 * Installed on every language model built by `getModel` (packages/ai/model-factory.ts),
 * so EVERY current and future in-process model call — one-shot `generateObject`/
 * `generateText` AND streaming `streamText`, whether issued by an API procedure, a
 * Temporal activity, the agent orchestrator, MCP sampling, or code not yet written —
 * records an `AiUsageLog` row by construction. The sole exception is a caller
 * that explicitly resolves aggregate mode and owns one SDK multi-step turn;
 * it reuses this module's normalizer/writer for exactly one whole-turn row.
 * Callers otherwise no longer have to remember to call `logModelUsageAsync`;
 * that function is now a no-op superseded by this middleware (see
 * usage-logging.ts).
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
import type {
	EmbeddingModel,
	Experimental_EvaluationModel,
	LanguageModel,
} from "ai";
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

/** One whole-turn usage record emitted by a caller that owns a multi-step loop. */
export interface AggregateUsageRecord {
	usage: unknown;
	latencyMs: number;
	success: boolean;
	errorMessage?: string;
	/**
	 * Full SDK step list. A generation id is safe to attach only if this has
	 * exactly one entry; an aggregate of several provider calls has no single
	 * gateway generation to reconcile later.
	 */
	steps?: readonly { providerMetadata?: unknown }[];
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
 * Read one field out of the flat `inputTokenDetails`/`outputTokenDetails`
 * objects the top-level `LanguageModelUsage` carries (`ai` 7 `dist/index.d.ts`
 * `LanguageModelUsage`), as opposed to the nested breakdown the provider
 * interface uses.
 */
function detail(value: unknown, key: string): number {
	return num((value as Record<string, unknown> | undefined)?.[key]);
}

/**
 * Normalize the AI SDK's `usage` into our token buckets.
 *
 * Two shapes are live under AI SDK 7 and this reads both. The PROVIDER
 * interface — which is what a `wrapLanguageModel` middleware such as this one
 * actually sees — reports `LanguageModelV4Usage`: nested breakdowns
 * `inputTokens: { total, noCache, cacheRead, cacheWrite }` and
 * `outputTokens: { total, text, reasoning }`, with no `totalTokens` of its own
 * (`@ai-sdk/provider` 4 `dist/index.d.ts` `LanguageModelV4Usage`). The
 * TOP-LEVEL `LanguageModelUsage` that `generateText`/`streamText` expose is
 * flat instead — plain `inputTokens`/`outputTokens`/`totalTokens` numbers plus
 * `inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens }` and
 * `outputTokenDetails: { textTokens, reasoningTokens }`.
 *
 * Gone with SDK 6 and deliberately no longer read: the flat
 * `usage.cachedInputTokens` and `usage.reasoningTokens` names, and
 * `providerMetadata.anthropic.cacheCreationInputTokens` — `@ai-sdk/anthropic` 4
 * now maps `cache_creation_input_tokens` into `inputTokens.cacheWrite` and
 * emits no camelCase copy on provider metadata (`dist/index.js:2035-2041`).
 * Keeping a dead fallback here is not free: it is indistinguishable from a
 * supported shape to whoever reads this next.
 */
function normalizeUsage(usage: unknown): NormalizedUsage {
	const u = (usage ?? {}) as Record<string, unknown>;
	// `inputTokens`/`outputTokens` are NOT always numbers. On the provider
	// interface they are breakdown objects, and reading those with a plain
	// number cast yields NaN → 0 — an all-zero count is what this middleware
	// treats as "no billing signal" and drops, so every generation through
	// those providers would go unrecorded while the call itself succeeded.
	// `readTokenCount` accepts both shapes; the OpenAI-compatible aliases after
	// it cover an endpoint that hands its usage back unmapped.
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
		part(u.inputTokens, "cacheRead") ||
		detail(u.inputTokenDetails, "cacheReadTokens");
	const reasoningTokens =
		part(u.outputTokens, "reasoning") ||
		detail(u.outputTokenDetails, "reasoningTokens");
	const cacheCreationInputTokens =
		part(u.inputTokens, "cacheWrite") ||
		detail(u.inputTokenDetails, "cacheWriteTokens");

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
 * Prefer provider-reported aggregate usage, but let a successful caller use
 * its existing estimate when the SDK exposes no billing signal at all.
 */
export function selectAggregateUsageForLogging(
	reportedUsage: unknown,
	estimatedUsage: unknown,
): unknown {
	const normalized = normalizeUsage(reportedUsage);
	return normalized.inputTokens === 0 &&
		normalized.outputTokens === 0 &&
		normalized.totalTokens === 0
		? estimatedUsage
		: reportedUsage;
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

function singleStepGatewayGenerationId(
	steps: AggregateUsageRecord["steps"],
): string | undefined {
	return steps?.length === 1
		? gatewayGenerationIdOf(steps[0]?.providerMetadata)
		: undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * Parse a gateway/provider error body. Accepts either an already-parsed
 * object (`data` on an `APICallError`/gateway-wrapped cause) or a JSON string
 * (`responseBody`), matching the two shapes `@ai-sdk/provider`'s
 * `APICallError` exposes. Returns `undefined` when neither is present or the
 * string does not parse as an object.
 */
function parseErrorBody(
	source: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!source) {
		return undefined;
	}
	if (isRecord(source.data)) {
		return source.data;
	}
	if (typeof source.responseBody === "string") {
		try {
			const parsed: unknown = JSON.parse(source.responseBody);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** A model-call failure's structured attribution, extracted without importing
 * `@ai-sdk/gateway`/`@ai-sdk/provider` error classes — every field is read by
 * duck-typed property shape so this keeps working across a gateway/provider
 * error, a bare `APICallError` from a non-gateway provider, or a plain
 * `Error` with none of this. */
export interface DescribedModelCallError {
	message: string;
	/** Finite HTTP status code of the failed attempt, when the error carried one. */
	statusCode?: number;
	/**
	 * Small structured extract — never the raw response body, headers,
	 * request values, or URL. `routing` (and any other nested field pulled
	 * from the parsed error body) can still carry upstream FREE TEXT,
	 * including one that echoes a submitted credential back (a provider's
	 * "Incorrect API key provided: sk-…" message, Fizzy #2623 review) — this
	 * function does not scrub string leaves itself; every string leaf is
	 * scrubbed for credential-shaped substrings at persistence time
	 * (`prepareErrorDetailsForPersist` in `@repo/database`). `undefined` when
	 * the error carried nothing beyond a message.
	 */
	details?: Record<string, unknown>;
}

/**
 * Describe a model-call failure for the usage ledger (Fizzy #2623): a status
 * code so a gateway-side failure (VERCEL_GATEWAY, e.g. `typesafe-ai/jev`) can
 * be told apart from a provider-side one, and a small structured extract of
 * the gateway's routing metadata when the error's body carries it.
 *
 * `asGatewayError` (`@ai-sdk/gateway`) sets `cause` to the original
 * `@ai-sdk/provider` `APICallError`, which is where the gateway's response
 * body actually lives — `createGatewayErrorFromResponse` does not copy it
 * onto the gateway error itself. This reads the error's own properties first
 * and falls back to `cause`, so it covers both that wrapped shape and a bare
 * `APICallError` thrown directly by a non-gateway provider.
 *
 * Never throws: this feeds the usage ledger's failure path, and a usage row
 * that fails to write because ITS OWN error-description step threw would be
 * worse than one with no status code or details at all. Any unexpected shape
 * (e.g. a getter that throws on access) falls back to just the message.
 */
export function describeModelCallError(
	error: unknown,
): DescribedModelCallError {
	const message = error instanceof Error ? error.message : String(error);
	if (!isRecord(error)) {
		return { message };
	}
	try {
		return describeRecordModelCallError(error, message);
	} catch {
		return { message };
	}
}

function describeRecordModelCallError(
	error: Record<string, unknown>,
	message: string,
): DescribedModelCallError {
	const cause = isRecord(error.cause) ? error.cause : undefined;

	// The gateway wraps a status-less network failure (no HTTP response ever
	// received) in a `GatewayError` that still defaults `statusCode` to 500 —
	// `createGatewayErrorFromResponse`'s own default, not a real HTTP status —
	// and `GatewayTimeoutError` defaults to 408 the same way. When `cause`
	// looks like the original `@ai-sdk/provider` `APICallError` (it carries
	// `url` or `requestBodyValues`, fields only a real HTTP attempt sets),
	// trust ONLY its statusCode — including "it doesn't have one" — instead of
	// the wrapper's invented default.
	const causeIsApiCallError =
		isRecord(cause) && ("url" in cause || "requestBodyValues" in cause);
	const statusCode = causeIsApiCallError
		? finiteNumber(cause?.statusCode)
		: (finiteNumber(error.statusCode) ?? finiteNumber(cause?.statusCode));

	const body = parseErrorBody(error) ?? parseErrorBody(cause);
	const rawBodyError = body?.error;
	const bodyError = isRecord(rawBodyError) ? rawBodyError : undefined;
	const providerMetadata = body?.providerMetadata;
	const gatewayMeta = isRecord(providerMetadata)
		? providerMetadata.gateway
		: undefined;
	const routing = isRecord(gatewayMeta) ? gatewayMeta.routing : undefined;

	const details: Record<string, unknown> = {};

	// `error.name` is excluded unless it is an OWN property: every plain
	// `Error` inherits `name: "Error"` from `Error.prototype`, and that
	// inherited default is not a meaningful attribution. The gateway error
	// classes (e.g. `GatewayInternalServerError`) set `name` as an instance
	// property in their constructor, which shadows the prototype default and
	// passes this check.
	if (typeof error.name === "string" && Object.hasOwn(error, "name")) {
		details.name = error.name;
	}

	const rawBodyType =
		typeof bodyError?.type === "string" ? bodyError?.type : undefined;
	const type = typeof error.type === "string" ? error.type : rawBodyType;
	if (type) {
		details.type = type;
	}
	// `createGatewayErrorFromResponse` maps any body `error.type` it doesn't
	// recognize to a generic `GatewayInternalServerError` (fixed
	// `type: "internal_server_error"`), which loses the upstream body's own
	// type (e.g. `service_unavailable_error`). Keep both when they disagree.
	if (rawBodyType && rawBodyType !== type) {
		details.bodyType = rawBodyType;
	}

	const code = bodyError?.code;
	if (typeof code === "string" || typeof code === "number") {
		details.code = code;
	}

	const isRetryable =
		typeof error.isRetryable === "boolean"
			? error.isRetryable
			: typeof cause?.isRetryable === "boolean"
				? cause?.isRetryable
				: undefined;
	if (isRetryable !== undefined) {
		details.isRetryable = isRetryable;
	}

	if (typeof error.generationId === "string") {
		details.generationId = error.generationId;
	}

	if (isRecord(routing)) {
		details.routing = routing;
	}

	return {
		message,
		statusCode,
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

function emit(
	context: UsageLoggingContext,
	usage: NormalizedUsage,
	latencyMs: number,
	success: boolean,
	errorMessage?: string,
	gatewayGenerationId?: string,
	errorStatusCode?: number,
	errorDetails?: Record<string, unknown>,
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
			errorStatusCode,
			errorDetails,
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

/**
 * Record one caller-owned aggregate usage row through the same normalizer and
 * writer as the automatic middleware. This is deliberately for the rare
 * multi-step callers that opt out of per-provider-call logging at resolution.
 */
export function recordAggregateUsage(
	context: UsageLoggingContext,
	record: AggregateUsageRecord,
): void {
	emit(
		context,
		normalizeUsage(record.usage),
		record.latencyMs,
		record.success,
		record.errorMessage,
		singleStepGatewayGenerationId(record.steps),
	);
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
						normalizeUsage(result.usage),
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
					const described = describeModelCallError(error);
					emit(
						context,
						normalizeUsage(undefined),
						Date.now() - start,
						false,
						described.message,
						undefined,
						described.statusCode,
						described.details,
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
					const described = describeModelCallError(error);
					emit(
						context,
						normalizeUsage(undefined),
						Date.now() - start,
						false,
						described.message,
						undefined,
						described.statusCode,
						described.details,
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
								normalizeUsage(chunk.usage),
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
							const described = describeModelCallError(err);
							emit(
								context,
								normalizeUsage(chunk.usage),
								Date.now() - start,
								false,
								err instanceof Error
									? err.message
									: typeof err === "string"
										? err
										: "stream error",
								undefined,
								described.statusCode,
								described.details,
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

/**
 * Evaluation-model counterpart of the language-model interceptor. Evaluation
 * models expose `doEvaluate` directly rather than supporting the SDK's generic
 * model middleware, so preserve the provider contract while observing that one
 * network boundary. The shared `emit` writer creates the usage row and lets its
 * registered database recorder advance applicable tenant limit counters.
 */
type EvaluationModelInstance = Exclude<Experimental_EvaluationModel, string>;

export function wrapEvaluationModelWithUsageLogging(
	model: EvaluationModelInstance,
	context: UsageLoggingContext,
): EvaluationModelInstance {
	const doEvaluate = model.doEvaluate.bind(model);

	return {
		// GatewayEvaluationModel exposes `provider` through a prototype getter.
		// Read each SDK contract field explicitly: spreading the instance would
		// silently discard that getter and make the wrapped model invalid.
		specificationVersion: model.specificationVersion,
		provider: model.provider,
		modelId: model.modelId,
		supportedQuestionTypes: model.supportedQuestionTypes,
		doEvaluate: async (options) => {
			const start = Date.now();
			try {
				const result = await doEvaluate(options);
				try {
					emit(
						context,
						normalizeUsage(result.usage),
						Date.now() - start,
						true,
						undefined,
						gatewayGenerationIdOf(result.providerMetadata),
					);
				} catch {
					// Usage accounting remains best-effort and never changes an answer.
				}
				return result;
			} catch (error) {
				try {
					const described = describeModelCallError(error);
					emit(
						context,
						normalizeUsage(undefined),
						Date.now() - start,
						false,
						described.message,
						undefined,
						described.statusCode,
						described.details,
					);
				} catch {
					// Usage accounting remains best-effort and never changes an error.
				}
				throw error;
			}
		},
	};
}
