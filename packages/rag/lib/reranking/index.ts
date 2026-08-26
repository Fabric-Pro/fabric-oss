/**
 * Reranking Module
 *
 * Provides document reranking capabilities to improve retrieval quality.
 * Supports multiple providers:
 * - cross-encoder: Self-hosted, free (default)
 * - cohere: Cloud API, high quality
 *
 * Usage:
 * ```typescript
 * import { rerankContexts } from "@repo/rag/lib/reranking";
 *
 * const reranked = await rerankContexts({
 *   query: "What are the authentication requirements?",
 *   contexts: retrievedContexts,
 *   topK: 10,
 * });
 * ```
 */

import { logger } from "@repo/logs";
import type { RetrievedContext } from "../project-contexts/retrieval";
import { getRerankerConfig, isCohereAvailable } from "./config";
import { CohereRerankerProvider } from "./providers/cohere";
import { CrossEncoderRerankerProvider } from "./providers/cross-encoder";
import type {
	RerankerConfig,
	RerankerProvider,
	RerankerProviderType,
	RerankStats,
} from "./types";
import { DEFAULT_RERANK_CONFIG } from "./types";

export * from "./config";
export { CohereRerankerProvider } from "./providers/cohere";
export {
	CrossEncoderRerankerProvider,
	resetCrossEncoderCache,
} from "./providers/cross-encoder";
// Re-export types and providers
export * from "./types";

/**
 * Create a reranker provider based on configuration
 */
export function createReranker(config: RerankerConfig): RerankerProvider {
	switch (config.provider) {
		case "cohere":
			return new CohereRerankerProvider(config);
		case "cross-encoder":
			return new CrossEncoderRerankerProvider(config);
		default:
			throw new Error(`Unknown reranker provider: ${config.provider}`);
	}
}

/**
 * Get the best available reranker provider
 *
 * Priority:
 * 1. Preferred provider (if specified and available)
 * 2. RERANKER_PROVIDER env var (if set)
 * 3. Cross-encoder (default, always available, free)
 *
 * Note: Cohere requires explicit configuration via preferredProvider or RERANKER_PROVIDER env var.
 * If Cohere is selected but no API key exists, falls back to cross-encoder.
 */
export function getBestAvailableReranker(
	preferredProvider?: RerankerProviderType,
): RerankerProvider {
	const config = getRerankerConfig(preferredProvider);
	return createReranker(config);
}

/**
 * Options for rerankContexts function
 */
export interface RerankContextsOptions {
	/** Query to rerank against */
	query: string;
	/** Contexts to rerank */
	contexts: RetrievedContext[];
	/** Number of results to return (default: 10) */
	topK?: number;
	/** Minimum relevance score (default: 0) */
	minRelevanceScore?: number;
	/** Preferred provider (optional, will fallback if unavailable) */
	provider?: RerankerProviderType;
	/** Custom provider config (optional) */
	config?: Partial<RerankerConfig>;
}

/**
 * Result from rerankContexts
 */
export interface RerankContextsResult {
	/** Reranked contexts with updated scores */
	contexts: RetrievedContext[];
	/** Reranking statistics */
	stats: RerankStats;
}

/**
 * Rerank retrieved contexts using the best available provider
 *
 * This is the main high-level function for reranking in the RAG pipeline.
 * It handles provider selection, error handling, and returns contexts
 * with updated relevance scores.
 *
 * @param options - Reranking options
 * @returns Reranked contexts sorted by relevance
 */
export async function rerankContexts(
	options: RerankContextsOptions,
): Promise<RerankContextsResult> {
	const {
		query,
		contexts,
		topK = DEFAULT_RERANK_CONFIG.topK,
		minRelevanceScore = DEFAULT_RERANK_CONFIG.minRelevanceScore,
		provider: preferredProvider,
		config: customConfig,
	} = options;

	// Skip reranking if no contexts or only one
	if (contexts.length <= 1) {
		return {
			contexts,
			stats: {
				latencyMs: 0,
				inputCount: contexts.length,
				outputCount: contexts.length,
				provider: "cross-encoder",
				model: "none",
			},
		};
	}

	const startTime = Date.now();

	try {
		// Get reranker config
		const config = getRerankerConfig(preferredProvider, customConfig);
		const reranker = createReranker(config);

		logger.info(
			`[Reranking] Starting with provider=${config.provider}, model=${config.model}, input=${contexts.length}`,
		);

		// Perform reranking
		const results = await reranker.rerank({
			query,
			documents: contexts,
			topK,
			minRelevanceScore,
		});

		const latencyMs = Date.now() - startTime;

		// Map results back to RetrievedContext format with updated scores
		const rerankedContexts: RetrievedContext[] = results.map((result) => ({
			...result.document,
			// Update score to use reranking relevance (preserving original as metadata)
			score: result.relevanceScore,
			metadata: {
				...result.document.metadata,
				originalVectorScore: result.document.score,
				rerankScore: result.relevanceScore,
				rerankedBy: config.provider,
			},
		}));

		const stats: RerankStats = {
			latencyMs,
			inputCount: contexts.length,
			outputCount: rerankedContexts.length,
			provider: config.provider,
			model: config.model,
		};

		logger.info(
			`[Reranking] Completed: ${stats.inputCount} → ${stats.outputCount} contexts in ${stats.latencyMs}ms`,
		);

		return { contexts: rerankedContexts, stats };
	} catch (error) {
		logger.error(`[Reranking] Failed: ${error}`);

		// On error, return original contexts unchanged
		// This ensures the pipeline doesn't break if reranking fails
		return {
			contexts,
			stats: {
				latencyMs: Date.now() - startTime,
				inputCount: contexts.length,
				outputCount: contexts.length,
				provider: preferredProvider || "cross-encoder",
				model: "fallback-passthrough",
			},
		};
	}
}

/**
 * Check which reranker providers are currently available
 */
export async function getAvailableRerankers(): Promise<{
	cohere: boolean;
	"cross-encoder": boolean;
}> {
	return {
		cohere: isCohereAvailable(),
		"cross-encoder": true, // Always available (self-hosted)
	};
}
