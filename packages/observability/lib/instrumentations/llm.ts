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

// Get tracer and meter
const tracer = trace.getTracer("fabric-llm");
const meter = metrics.getMeter("fabric-llm");

// Metrics
const llmRequestCounter = meter.createCounter("llm.requests", {
	description: "Total number of LLM requests",
	unit: "1",
});

const llmTokensCounter = meter.createCounter("llm.tokens", {
	description: "Total tokens used",
	unit: "1",
});

const llmRequestDuration = meter.createHistogram("llm.request.duration", {
	description: "Duration of LLM requests",
	unit: "ms",
});

const llmErrorCounter = meter.createCounter("llm.errors", {
	description: "Total number of LLM errors",
	unit: "1",
});

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

/**
 * Create an instrumented LLM span wrapper
 */
function createLLMSpan(span: Span, options: LLMCallOptions): LLMSpan {
	const llmSpan = span as LLMSpan;

	llmSpan.setTokenUsage = (inputTokens: number, outputTokens: number) => {
		span.setAttribute(LLM_USAGE_INPUT_TOKENS, inputTokens);
		span.setAttribute(LLM_USAGE_OUTPUT_TOKENS, outputTokens);

		// Record token metrics
		llmTokensCounter.add(inputTokens, {
			provider: options.provider,
			model: options.model,
			type: "input",
		});
		llmTokensCounter.add(outputTokens, {
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
				const llmSpan = createLLMSpan(span, options);

				try {
					const result = await fn(llmSpan);

					// Record success metrics
					llmRequestCounter.add(1, {
						provider: options.provider,
						model: options.model,
						operation: operationName,
						status: "success",
					});

					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					// Record error metrics
					llmRequestCounter.add(1, {
						provider: options.provider,
						model: options.model,
						operation: operationName,
						status: "error",
					});
					llmErrorCounter.add(1, {
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
					llmRequestDuration.record(duration, {
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
		llmRequestCounter.add(1, {
			provider: options.provider,
			model: options.model,
			operation: "streaming",
			status: "success",
		});

		llmTokensCounter.add(options.inputTokens, {
			provider: options.provider,
			model: options.model,
			type: "input",
		});

		llmTokensCounter.add(options.outputTokens, {
			provider: options.provider,
			model: options.model,
			type: "output",
		});

		llmRequestDuration.record(options.durationMs, {
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
