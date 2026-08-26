/**
 * Reranking Types and Interfaces
 *
 * This module defines the type system for reranking providers.
 * Reranking improves retrieval quality by using cross-encoder models
 * to score query-document relevance more accurately than vector similarity.
 *
 * Supported providers:
 * - cross-encoder: Self-hosted, free, uses transformers.js (default)
 * - cohere: Cloud API, high quality, requires API key
 */

import type { RetrievedContext } from "../project-contexts/retrieval";

/**
 * Available reranker provider types
 */
export type RerankerProviderType = "cross-encoder" | "cohere";

/**
 * Result from reranking a document
 */
export interface RerankResult {
	/** Original document/context */
	document: RetrievedContext;
	/** Reranking relevance score (0-1, higher is more relevant) */
	relevanceScore: number;
	/** Original index in the input array */
	originalIndex: number;
}

/**
 * Options for reranking documents
 */
export interface RerankOptions {
	/** Query to rerank documents against */
	query: string;
	/** Documents to rerank */
	documents: RetrievedContext[];
	/** Number of top results to return after reranking */
	topK?: number;
	/** Optional minimum relevance score threshold (0-1) */
	minRelevanceScore?: number;
}

/**
 * Configuration for initializing a reranker provider
 */
export interface RerankerConfig {
	/** Provider type */
	provider: RerankerProviderType;
	/** API key (required for cohere, optional for cross-encoder) */
	apiKey?: string;
	/** Custom model name (provider-specific) */
	model?: string;
	/** Timeout in milliseconds (default: 30000) */
	timeout?: number;
}

/**
 * Interface that all reranker providers must implement
 */
export interface RerankerProvider {
	/** Provider identifier */
	readonly providerType: RerankerProviderType;

	/**
	 * Rerank documents based on relevance to the query
	 *
	 * @param options - Rerank options including query and documents
	 * @returns Reranked results sorted by relevance score (highest first)
	 */
	rerank(options: RerankOptions): Promise<RerankResult[]>;

	/**
	 * Check if the provider is available/healthy
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Optional cleanup when provider is no longer needed
	 */
	dispose?(): Promise<void>;
}

/**
 * Factory function type for creating reranker providers
 */
export type RerankerFactory = (config: RerankerConfig) => RerankerProvider;

/**
 * Reranking statistics for monitoring
 */
export interface RerankStats {
	/** Time taken for reranking in ms */
	latencyMs: number;
	/** Number of documents reranked */
	inputCount: number;
	/** Number of documents returned after filtering */
	outputCount: number;
	/** Provider used */
	provider: RerankerProviderType;
	/** Model used */
	model?: string;
}

/**
 * Default configuration values
 */
export const DEFAULT_RERANK_CONFIG = {
	/** Default number of results to return after reranking */
	topK: 10,
	/** Default minimum relevance score */
	minRelevanceScore: 0.0,
	/** Default timeout in ms */
	timeout: 30000,
	/** Default provider */
	provider: "cross-encoder" as RerankerProviderType,
} as const;

/**
 * Model identifiers for each provider
 */
export const RERANKER_MODELS = {
	cohere: {
		default: "rerank-v3.5",
		v3: "rerank-v3.5",
		multilingual: "rerank-multilingual-v3.0",
	},
	"cross-encoder": {
		default: "Xenova/ms-marco-MiniLM-L-6-v2",
		minilm: "Xenova/ms-marco-MiniLM-L-6-v2",
		tinybert: "Xenova/ms-marco-TinyBERT-L-6",
	},
} as const;
