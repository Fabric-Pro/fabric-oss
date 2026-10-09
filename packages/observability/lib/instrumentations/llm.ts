/**
 * LLM Call Instrumentation
 *
 * Provides tracing and metrics for AI/LLM operations including:
 * - Model invocations (Anthropic, OpenAI, etc.)
 * - Token usage tracking
 * - Latency metrics
 * - Error tracking
 * - Cost estimation
 *
 * @example
 * ```typescript
 * import { llmInstrumentation } from '@repo/observability';
 *
 * // Wrap an LLM call
 * const result = await llmInstrumentation.trace('chat-completion', {
 *   provider: 'anthropic',
 *   model: 'claude-3-sonnet',
 * }, async (span) => {
 *   const response = await anthropic.messages.create({...});
 *   span.setTokenUsage(response.usage.input_tokens, response.usage.output_tokens);
 *   return response;
 * });
 * ```
 */

import {
	type Attributes,
	metrics,
	type Span,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";

// Semantic conventions for LLM operations (following OpenTelemetry GenAI conventions)
const LLM_SYSTEM = "gen_ai.system";
const LLM_REQUEST_MODEL = "gen_ai.request.model";
const LLM_RESPONSE_MODEL = "gen_ai.response.model";
const LLM_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
const LLM_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
const LLM_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const LLM_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const LLM_RESPONSE_FINISH_REASON = "gen_ai.response.finish_reasons";

// Get tracer. Metric instruments are resolved lazily because service
// entrypoints import model modules before registering their MeterProvider.
const tracer = trace.getTracer("fabric-llm");

function getLLMMetrics() {
	const meter = metrics.getMeter("fabric-llm");
	return {
		requestCounter: meter.createCounter("llm.requests", {
			description: "Total number of LLM requests",
			unit: "1",
		}),
		tokensCounter: meter.createCounter("llm.tokens", {
			description: "Total tokens used",
			unit: "1",
		}),
		requestDuration: meter.createHistogram("llm.request.duration", {
			description: "Duration of LLM requests",
			unit: "ms",
		}),
		errorCounter: meter.createCounter("llm.errors", {
			description: "Total number of LLM errors",
			unit: "1",
		}),
	};
}

function getDecisionMetrics() {
	const meter = metrics.getMeter("fabric-llm");
	return {
		outcomeCounter: meter.createCounter("llm.decision.outcomes", {
			description:
				"Decision outcomes per call site: whether the typed decision was used or the site fell back",
			unit: "1",
		}),
		confidenceHistogram: meter.createHistogram("llm.decision.confidence", {
			description:
				"Confidence (0..1) of typed decision answers per call site and answering model",
			unit: "1",
			advice: {
				explicitBucketBoundaries: [
					0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1,
				],
			},
		}),
	};
}

export interface LLMCallOptions {
	/** LLM provider (anthropic, openai, groq, etc.) */
	provider: string;
	/** Model identifier */
	model: string;
	/** Maximum tokens for response */
	maxTokens?: number;
	/** Temperature setting */
	temperature?: number;
	/** Additional attributes */
	attributes?: Attributes;
}

export interface LLMSpan extends Span {
	/** Record token usage after completion */
	setTokenUsage(inputTokens: number, outputTokens: number): void;
	/** Record finish reason */
	setFinishReason(reason: string | string[]): void;
	/** Record the actual model used (may differ from requested) */
	setResponseModel(model: string): void;
}

export interface LLMTokenUsage {
	inputTokens?: number;
	outputTokens?: number;
}

/** Operations an invocation span can represent. Chat is the default. */
export type LLMInvocationOperation = "chat" | "decide";

/**
 * Span-only context for an invocation. Every field is an identifier, enum or
 * number, bounded before it is recorded. None of it is ever a metric label:
 * `organizationId` in particular is unbounded cardinality.
 */
export interface LLMInvocationContext {
	/** Opaque organization id, never a name. */
	organizationId?: string;
	projectId?: string;
	featureKey?: string;
	jobType?: string;
	/** Number of questions in a decide call. */
	questionCount?: number;
}

export interface LLMInvocationOptions {
	/** LLM provider (anthropic, openai, groq, etc.) */
	provider: string;
	/** Requested model identifier */
	model: string;
	/** Defaults to "chat". "decide" produces an `llm.decide` span. */
	operation?: LLMInvocationOperation;
	/** Span-only context. Omitted fields are not recorded. */
	context?: LLMInvocationContext;
}

export interface LLMSuccessDetails {
	/** Model that actually answered, when it can differ from the requested one. */
	responseModel?: string;
	/** Number of per-question refusals in a decide result. Never the refusal text. */
	refusalCount?: number;
}

export interface LLMInvocation {
	/** Finish the invocation successfully. Duplicate terminal signals are ignored. */
	succeed(usage?: LLMTokenUsage, details?: LLMSuccessDetails): void;
	/** Finish the invocation as failed without recording the error message or stack. */
	fail(error?: unknown): void;
	/** Finish an invocation whose streaming consumer cancelled it. */
	cancel(): void;
}

const MAX_LLM_ATTRIBUTE_LENGTH = 128;

function boundedAttribute(value: string, fallback: string): string {
	const normalized = value.trim() || fallback;
	return normalized.slice(0, MAX_LLM_ATTRIBUTE_LENGTH);
}

function tokenCount(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function boundedErrorType(error: unknown): string {
	if (error instanceof Error) {
		try {
			const type = error.constructor.name;
			return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(type)
				? boundedAttribute(type, "Error")
				: "Error";
		} catch {
			return "Error";
		}
	}
	return "UnknownError";
}

const noopInvocation: LLMInvocation = {
	succeed() {},
	fail() {},
	cancel() {},
};

/**
 * Span-only attributes for the optional invocation context. A field that is
 * absent, empty or not the expected type is omitted rather than recorded as a
 * placeholder.
 */
function contextAttributes(
	context: LLMInvocationContext | undefined,
): Attributes {
	const attributes: Attributes = {};
	if (!context) {
		return attributes;
	}
	const strings: Array<[string, string | undefined]> = [
		["fabric.organization.id", context.organizationId],
		["fabric.project.id", context.projectId],
		["fabric.feature_key", context.featureKey],
		["fabric.job_type", context.jobType],
	];
	for (const [key, value] of strings) {
		if (typeof value === "string" && value.trim()) {
			attributes[key] = boundedAttribute(value, "unknown");
		}
	}
	if (
		typeof context.questionCount === "number" &&
		Number.isFinite(context.questionCount) &&
		context.questionCount >= 0
	) {
		attributes["llm.decision.question_count"] = context.questionCount;
	}
	return attributes;
}

function startInvocation(options: LLMInvocationOptions): LLMInvocation {
	try {
		const provider = boundedAttribute(options.provider, "unknown");
		const model = boundedAttribute(options.model, "unknown");
		const operation: LLMInvocationOperation =
			options.operation === "decide" ? "decide" : "chat";
		const startedAt = Date.now();
		const span = trace
			.getTracer("fabric-llm")
			.startSpan(`llm.${operation}`, {
				attributes: {
					[LLM_SYSTEM]: provider,
					[LLM_REQUEST_MODEL]: model,
					[LLM_USAGE_INPUT_TOKENS]: 0,
					[LLM_USAGE_OUTPUT_TOKENS]: 0,
					...contextAttributes(options.context),
				},
			});
		let finished = false;

		const finish = (
			outcome: "success" | "error" | "cancelled",
			usage?: LLMTokenUsage,
			error?: unknown,
			details?: LLMSuccessDetails,
		) => {
			if (finished) {
				return;
			}
			finished = true;
			const inputTokens = tokenCount(usage?.inputTokens);
			const outputTokens = tokenCount(usage?.outputTokens);

			try {
				const {
					errorCounter,
					requestCounter,
					requestDuration,
					tokensCounter,
				} = getLLMMetrics();
				span.setAttributes({
					[LLM_USAGE_INPUT_TOKENS]: inputTokens,
					[LLM_USAGE_OUTPUT_TOKENS]: outputTokens,
					"llm.outcome": outcome,
				});
				if (outcome === "success" && details) {
					if (
						typeof details.responseModel === "string" &&
						details.responseModel.trim()
					) {
						span.setAttribute(
							LLM_RESPONSE_MODEL,
							boundedAttribute(details.responseModel, "unknown"),
						);
					}
					if (
						typeof details.refusalCount === "number" &&
						Number.isFinite(details.refusalCount) &&
						details.refusalCount >= 0
					) {
						span.setAttribute(
							"llm.decision.refusal_count",
							details.refusalCount,
						);
					}
				}
				if (outcome === "success") {
					span.setStatus({ code: SpanStatusCode.OK });
				} else if (outcome === "error") {
					span.setStatus({ code: SpanStatusCode.ERROR });
					span.setAttribute("error.type", boundedErrorType(error));
				} else {
					span.setStatus({ code: SpanStatusCode.UNSET });
				}

				requestCounter.add(1, {
					provider,
					model,
					operation,
					status: outcome,
				});
				tokensCounter.add(inputTokens, {
					provider,
					model,
					type: "input",
				});
				tokensCounter.add(outputTokens, {
					provider,
					model,
					type: "output",
				});
				if (outcome === "error") {
					errorCounter.add(1, {
						provider,
						model,
						operation,
						error_type: boundedErrorType(error),
					});
				}
				requestDuration.record(Date.now() - startedAt, {
					provider,
					model,
					operation,
				});
			} catch {
				// Telemetry is best-effort and must never change model behavior.
			} finally {
				try {
					span.end();
				} catch {
					// Telemetry is best-effort and must never change model behavior.
				}
			}
		};

		return {
			succeed: (usage, details) =>
				finish("success", usage, undefined, details),
			fail: (error) => finish("error", undefined, error),
			cancel: () => finish("cancelled"),
		};
	} catch {
		return noopInvocation;
	}
}

export interface LLMDecisionOutcomeRecord {
	/** Fixed identifier of the decision call site. Never user-derived. */
	site: string;
	/** Closed-enum outcome. Never free text. */
	outcome: string;
	/** Answering model label. Bounded. */
	model: string;
	/** Confidence samples in 0..1; values outside that range are dropped. */
	confidences?: readonly number[];
	/** How many decisions share this outcome. Defaults to 1. */
	count?: number;
}

/**
 * Record one decision-call-site outcome. Metric labels are site, outcome and
 * model only. Never throws.
 */
function recordDecisionOutcome(record: LLMDecisionOutcomeRecord): void {
	try {
		const site = boundedAttribute(record.site, "unknown");
		const outcome = boundedAttribute(record.outcome, "unknown");
		const model = boundedAttribute(record.model, "unknown");
		const count =
			typeof record.count === "number" &&
			Number.isInteger(record.count) &&
			record.count > 0
				? record.count
				: 1;
		const confidences = (record.confidences ?? []).filter(
			(value) =>
				typeof value === "number" &&
				Number.isFinite(value) &&
				value >= 0 &&
				value <= 1,
		);

		try {
			const { confidenceHistogram, outcomeCounter } =
				getDecisionMetrics();
			outcomeCounter.add(count, { site, outcome, model });
			for (const confidence of confidences) {
				confidenceHistogram.record(confidence, { site, model });
			}
		} catch {
			// Telemetry is best-effort and must never change decision behavior.
		}

		try {
			const span = trace.getActiveSpan();
			if (span) {
				span.setAttribute("llm.decision.site", site);
				span.setAttribute("llm.decision.outcome", outcome);
				if (confidences.length > 0) {
					span.setAttribute(
						"llm.decision.confidence",
						Math.min(...confidences),
					);
				}
			}
		} catch {
			// Telemetry is best-effort and must never change decision behavior.
		}
	} catch {
		// Telemetry is best-effort and must never change decision behavior.
	}
}

/**
 * Create an instrumented LLM span wrapper
 */
function createLLMSpan(span: Span, options: LLMCallOptions): LLMSpan {
	const llmSpan = span as LLMSpan;

	llmSpan.setTokenUsage = (inputTokens: number, outputTokens: number) => {
		const { tokensCounter } = getLLMMetrics();
		span.setAttribute(LLM_USAGE_INPUT_TOKENS, inputTokens);
		span.setAttribute(LLM_USAGE_OUTPUT_TOKENS, outputTokens);

		// Record token metrics
		tokensCounter.add(inputTokens, {
			provider: options.provider,
			model: options.model,
			type: "input",
		});
		tokensCounter.add(outputTokens, {
			provider: options.provider,
			model: options.model,
			type: "output",
		});
	};

	llmSpan.setFinishReason = (reason: string | string[]) => {
		const reasons = Array.isArray(reason) ? reason : [reason];
		span.setAttribute(LLM_RESPONSE_FINISH_REASON, reasons);
	};

	llmSpan.setResponseModel = (model: string) => {
		span.setAttribute(LLM_RESPONSE_MODEL, model);
	};

	return llmSpan;
}

/**
 * LLM Instrumentation utilities
 */
export const llmInstrumentation = {
	/** Start a privacy-safe span whose lifetime can cross streaming callbacks. */
	startInvocation,

	/** Record how a decision call site used (or fell back from) a typed decision. */
	recordDecisionOutcome,

	/**
	 * Trace an LLM call with automatic metrics recording
	 *
	 * @param operationName - Name of the operation (e.g., 'chat-completion', 'embedding')
	 * @param options - LLM call options
	 * @param fn - Async function to execute within the span
	 */
	async trace<T>(
		operationName: string,
		options: LLMCallOptions,
		fn: (span: LLMSpan) => Promise<T>,
	): Promise<T> {
		const startTime = Date.now();
		const attributes: Attributes = {
			[LLM_SYSTEM]: options.provider,
			[LLM_REQUEST_MODEL]: options.model,
			...options.attributes,
		};

		if (options.maxTokens !== undefined) {
			attributes[LLM_REQUEST_MAX_TOKENS] = options.maxTokens;
		}
		if (options.temperature !== undefined) {
			attributes[LLM_REQUEST_TEMPERATURE] = options.temperature;
		}

		return tracer.startActiveSpan(
			`llm.${operationName}`,
			{ attributes },
			async (span) => {
				const { errorCounter, requestCounter, requestDuration } =
					getLLMMetrics();
				const llmSpan = createLLMSpan(span, options);

				try {
					const result = await fn(llmSpan);

					// Record success metrics
					requestCounter.add(1, {
						provider: options.provider,
						model: options.model,
						operation: operationName,
						status: "success",
					});

					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					// Record error metrics
					requestCounter.add(1, {
						provider: options.provider,
						model: options.model,
						operation: operationName,
						status: "error",
					});
					errorCounter.add(1, {
						provider: options.provider,
						model: options.model,
						operation: operationName,
						error_type:
							error instanceof Error
								? error.name
								: "UnknownError",
					});

					span.setStatus({
						code: SpanStatusCode.ERROR,
						message:
							error instanceof Error
								? error.message
								: String(error),
					});
					if (error instanceof Error) {
						span.recordException(error);
					}
					throw error;
				} finally {
					const duration = Date.now() - startTime;
					requestDuration.record(duration, {
						provider: options.provider,
						model: options.model,
						operation: operationName,
					});
					span.end();
				}
			},
		);
	},

	/**
	 * Record a streaming LLM response
	 * Use this for tracking streaming responses where you collect tokens incrementally
	 */
	recordStreamingResponse(options: {
		provider: string;
		model: string;
		inputTokens: number;
		outputTokens: number;
		durationMs: number;
		finishReason?: string;
	}): void {
		const { requestCounter, requestDuration, tokensCounter } =
			getLLMMetrics();
		requestCounter.add(1, {
			provider: options.provider,
			model: options.model,
			operation: "streaming",
			status: "success",
		});

		tokensCounter.add(options.inputTokens, {
			provider: options.provider,
			model: options.model,
			type: "input",
		});

		tokensCounter.add(options.outputTokens, {
			provider: options.provider,
			model: options.model,
			type: "output",
		});

		requestDuration.record(options.durationMs, {
			provider: options.provider,
			model: options.model,
			operation: "streaming",
		});
	},

	/**
	 * Create a child span for tool/function calls within an LLM interaction
	 */
	traceToolCall<T>(
		toolName: string,
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		return tracer.startActiveSpan(
			`llm.tool.${toolName}`,
			{ attributes: { "tool.name": toolName } },
			async (span) => {
				try {
					const result = await fn(span);
					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message:
							error instanceof Error
								? error.message
								: String(error),
					});
					if (error instanceof Error) {
						span.recordException(error);
					}
					throw error;
				} finally {
					span.end();
				}
			},
		);
	},
};
