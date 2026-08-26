/**
 * RAG (Retrieval-Augmented Generation) Instrumentation
 *
 * Provides tracing and metrics for RAG operations including:
 * - Vector store queries (Qdrant)
 * - Embedding generation
 * - Document chunking
 * - Retrieval latency
 *
 * @example
 * ```typescript
 * import { ragInstrumentation } from '@repo/observability';
 *
 * // Trace a vector search
 * const results = await ragInstrumentation.traceVectorSearch({
 *   collection: 'documents',
 *   topK: 10,
 * }, async (span) => {
 *   return await qdrantClient.search(collection, { ... });
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

// Get tracer and meter
const tracer = trace.getTracer("fabric-rag");
const meter = metrics.getMeter("fabric-rag");

// Metrics
const vectorSearchCounter = meter.createCounter("rag.vector_search", {
	description: "Total number of vector searches",
	unit: "1",
});

const vectorSearchDuration = meter.createHistogram(
	"rag.vector_search.duration",
	{
		description: "Duration of vector searches",
		unit: "ms",
	},
);

const vectorSearchResults = meter.createHistogram("rag.vector_search.results", {
	description: "Number of results returned by vector search",
	unit: "1",
});

const embeddingCounter = meter.createCounter("rag.embeddings", {
	description: "Total number of embedding generations",
	unit: "1",
});

const embeddingDuration = meter.createHistogram("rag.embedding.duration", {
	description: "Duration of embedding generation",
	unit: "ms",
});

const embeddingTokens = meter.createCounter("rag.embedding.tokens", {
	description: "Total tokens processed for embeddings",
	unit: "1",
});

const documentChunkCounter = meter.createCounter("rag.chunks", {
	description: "Total document chunks processed",
	unit: "1",
});

const ragErrorCounter = meter.createCounter("rag.errors", {
	description: "Total number of RAG errors",
	unit: "1",
});

export interface VectorSearchOptions {
	/** Collection/index name */
	collection: string;
	/** Number of results requested */
	topK: number;
	/** Filter applied */
	filter?: Record<string, unknown>;
	/** Additional attributes */
	attributes?: Attributes;
}

export interface EmbeddingOptions {
	/** Model used for embedding */
	model: string;
	/** Number of texts being embedded */
	batchSize: number;
	/** Provider (openai, cohere, etc.) */
	provider?: string;
	/** Additional attributes */
	attributes?: Attributes;
}

export interface VectorSearchSpan extends Span {
	/** Record the number of results returned */
	setResultCount(count: number): void;
	/** Record the score range of results */
	setScoreRange(minScore: number, maxScore: number): void;
}

/**
 * RAG instrumentation utilities
 */
export const ragInstrumentation = {
	/**
	 * Trace a vector search operation
	 */
	async traceVectorSearch<T>(
		options: VectorSearchOptions,
		fn: (span: VectorSearchSpan) => Promise<T>,
	): Promise<T> {
		const startTime = Date.now();

		const attributes: Attributes = {
			"rag.collection": options.collection,
			"rag.top_k": options.topK,
			...options.attributes,
		};

		if (options.filter) {
			attributes["rag.has_filter"] = true;
		}

		return tracer.startActiveSpan(
			`rag.vector_search.${options.collection}`,
			{ attributes },
			async (span) => {
				// Extend span with helper methods
				const ragSpan = span as VectorSearchSpan;
				let resultCount = 0;

				ragSpan.setResultCount = (count: number) => {
					resultCount = count;
					span.setAttribute("rag.result_count", count);
				};

				ragSpan.setScoreRange = (
					minScore: number,
					maxScore: number,
				) => {
					span.setAttribute("rag.min_score", minScore);
					span.setAttribute("rag.max_score", maxScore);
				};

				try {
					const result = await fn(ragSpan);

					vectorSearchCounter.add(1, {
						collection: options.collection,
						status: "success",
					});

					vectorSearchResults.record(resultCount, {
						collection: options.collection,
					});

					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					vectorSearchCounter.add(1, {
						collection: options.collection,
						status: "error",
					});
					ragErrorCounter.add(1, {
						operation: "vector_search",
						collection: options.collection,
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
					vectorSearchDuration.record(duration, {
						collection: options.collection,
					});
					span.end();
				}
			},
		);
	},

	/**
	 * Trace embedding generation
	 */
	async traceEmbedding<T>(
		options: EmbeddingOptions,
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		const startTime = Date.now();

		const attributes: Attributes = {
			"rag.embedding.model": options.model,
			"rag.embedding.batch_size": options.batchSize,
			...options.attributes,
		};

		if (options.provider) {
			attributes["rag.embedding.provider"] = options.provider;
		}

		return tracer.startActiveSpan(
			"rag.embedding",
			{ attributes },
			async (span) => {
				try {
					const result = await fn(span);

					embeddingCounter.add(1, {
						model: options.model,
						provider: options.provider || "unknown",
						status: "success",
					});

					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					embeddingCounter.add(1, {
						model: options.model,
						provider: options.provider || "unknown",
						status: "error",
					});
					ragErrorCounter.add(1, {
						operation: "embedding",
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
					embeddingDuration.record(duration, {
						model: options.model,
						provider: options.provider || "unknown",
					});
					span.end();
				}
			},
		);
	},

	/**
	 * Record embedding token usage
	 */
	recordEmbeddingTokens(
		tokens: number,
		model: string,
		provider?: string,
	): void {
		embeddingTokens.add(tokens, {
			model,
			provider: provider || "unknown",
		});
	},

	/**
	 * Trace document chunking operation
	 */
	async traceChunking<T>(
		options: {
			strategy: string;
			documentCount: number;
			attributes?: Attributes;
		},
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		const _startTime = Date.now();

		return tracer.startActiveSpan(
			"rag.chunking",
			{
				attributes: {
					"rag.chunking.strategy": options.strategy,
					"rag.chunking.document_count": options.documentCount,
					...options.attributes,
				},
			},
			async (span) => {
				try {
					const result = await fn(span);
					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					ragErrorCounter.add(1, {
						operation: "chunking",
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
					span.end();
				}
			},
		);
	},

	/**
	 * Record chunk statistics
	 */
	recordChunks(
		chunkCount: number,
		strategy: string,
		_avgChunkSize?: number,
	): void {
		documentChunkCounter.add(chunkCount, { strategy });
	},

	/**
	 * Trace a complete RAG pipeline (retrieve + generate)
	 */
	async traceRAGPipeline<T>(
		operationName: string,
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		return tracer.startActiveSpan(
			`rag.pipeline.${operationName}`,
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
