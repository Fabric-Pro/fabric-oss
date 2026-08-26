/**
 * Cross-Encoder Reranker Provider
 *
 * Uses transformers.js to run cross-encoder models locally for reranking.
 * This is a free, self-hosted alternative to cloud APIs like Cohere.
 *
 * Model: Xenova/ms-marco-MiniLM-L-6-v2 (default)
 * - 22M parameters
 * - Trained on MS MARCO passage ranking dataset
 * - Excellent quality/speed tradeoff
 *
 * Performance:
 * - First load: 2-5 seconds (downloads model)
 * - Subsequent runs: 50-200ms depending on document count
 * - Memory: ~100MB for the model
 *
 * @see https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2
 */

import { logger } from "@repo/logs";
import type {
	RerankerConfig,
	RerankerProvider,
	RerankerProviderType,
	RerankOptions,
	RerankResult,
} from "../types";
import { DEFAULT_RERANK_CONFIG, RERANKER_MODELS } from "../types";

// Lazy-loaded transformers.js pipeline
let pipeline: any = null;
let pipelinePromise: Promise<any> | null = null;

/**
 * Lazy-load the transformers.js pipeline
 * Uses singleton pattern to avoid loading the model multiple times
 */
async function getOrCreatePipeline(modelName: string): Promise<any> {
	if (pipeline) {
		return pipeline;
	}

	if (pipelinePromise) {
		return pipelinePromise;
	}

	pipelinePromise = (async () => {
		try {
			logger.info(
				`[CrossEncoderReranker] Loading model ${modelName}... (first load may take a few seconds)`,
			);

			// Dynamic import to avoid bundling issues
			const { pipeline: createPipeline, env } = await import(
				"@huggingface/transformers"
			);

			// Configure transformers.js for server-side usage
			env.allowLocalModels = false;
			env.useBrowserCache = false;

			// Create a text-classification pipeline for cross-encoder scoring
			// Cross-encoders output a single score for query-document pairs
			pipeline = await createPipeline("text-classification", modelName, {
				// Use fp32 for accuracy, fp16 for speed if needed
				dtype: "fp32",
			});

			logger.info("[CrossEncoderReranker] Model loaded successfully");
			return pipeline;
		} catch (error) {
			pipelinePromise = null;
			logger.error(
				`[CrossEncoderReranker] Failed to load model: ${error}`,
			);
			throw new Error(
				`Failed to load cross-encoder model: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	})();

	return pipelinePromise;
}

/**
 * Cross-Encoder Reranker Provider implementation
 */
export class CrossEncoderRerankerProvider implements RerankerProvider {
	readonly providerType: RerankerProviderType = "cross-encoder";

	private readonly model: string;
	private readonly timeout: number;

	constructor(config: RerankerConfig) {
		this.model = config.model || RERANKER_MODELS["cross-encoder"].default;
		this.timeout = config.timeout || DEFAULT_RERANK_CONFIG.timeout;
	}

	/**
	 * Rerank documents using local cross-encoder model
	 */
	async rerank(options: RerankOptions): Promise<RerankResult[]> {
		const {
			query,
			documents,
			topK = DEFAULT_RERANK_CONFIG.topK,
			minRelevanceScore = DEFAULT_RERANK_CONFIG.minRelevanceScore,
		} = options;

		if (documents.length === 0) {
			return [];
		}

		const startTime = Date.now();

		try {
			const classifier = await getOrCreatePipeline(this.model);

			// Create query-document pairs for cross-encoder
			// Format: "query [SEP] document" - the model scores relevance
			const pairs = documents.map((doc) => {
				// Truncate content to avoid token limits (512 tokens typical for MiniLM)
				const truncatedContent = doc.content.slice(0, 1500);
				return `${query} [SEP] ${truncatedContent}`;
			});

			// Process in batches to avoid memory issues
			const batchSize = 32;
			const allScores: number[] = [];

			for (let i = 0; i < pairs.length; i += batchSize) {
				const batch = pairs.slice(i, i + batchSize);

				// The model outputs classification scores
				// For MS MARCO models, LABEL_1 indicates relevance
				const results = await classifier(batch, {
					top_k: null, // Get all labels
				});

				// Extract relevance scores
				for (const result of results) {
					// Handle both array and single result formats
					const scores = Array.isArray(result) ? result : [result];

					// Find the positive label score (LABEL_1 for relevance)
					const positiveScore =
						scores.find(
							(s: { label: string; score: number }) =>
								s.label === "LABEL_1" || s.label === "positive",
						)?.score ?? 0;

					allScores.push(positiveScore);
				}
			}

			const latencyMs = Date.now() - startTime;
			logger.info(
				`[CrossEncoderReranker] Reranked ${documents.length} docs in ${latencyMs}ms`,
			);

			// Combine documents with scores and sort
			const rerankedResults: RerankResult[] = documents
				.map((doc, index) => ({
					document: doc,
					relevanceScore: allScores[index] ?? 0,
					originalIndex: index,
				}))
				.filter((r) => r.relevanceScore >= minRelevanceScore)
				.sort((a, b) => b.relevanceScore - a.relevanceScore)
				.slice(0, topK);

			return rerankedResults;
		} catch (error) {
			logger.error(`[CrossEncoderReranker] Rerank failed: ${error}`);
			throw error;
		}
	}

	/**
	 * Check if the cross-encoder model can be loaded
	 */
	async isAvailable(): Promise<boolean> {
		try {
			await getOrCreatePipeline(this.model);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Clean up resources (model cache)
	 */
	async dispose(): Promise<void> {
		if (pipeline) {
			// Note: transformers.js doesn't have explicit cleanup
			// Setting to null allows garbage collection
			pipeline = null;
			pipelinePromise = null;
			logger.info("[CrossEncoderReranker] Disposed model resources");
		}
	}
}

/**
 * Factory function to create a cross-encoder reranker
 */
export function createCrossEncoderReranker(
	config: Partial<RerankerConfig> = {},
): CrossEncoderRerankerProvider {
	return new CrossEncoderRerankerProvider({
		provider: "cross-encoder",
		...config,
	} as RerankerConfig);
}

/**
 * Reset the model cache (useful for testing)
 */
export function resetCrossEncoderCache(): void {
	pipeline = null;
	pipelinePromise = null;
}
