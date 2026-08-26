/**
 * Types for retrieval operations
 */

import type { EmbeddingProviderConfig } from "../embedding";

/**
 * Options for retrieving context
 */
export interface RetrievalOptions {
	/** Chat ID to search within */
	chatId: string;
	/** User ID (for multi-tenancy) */
	userId: string;
	/** Organization ID (for multi-tenancy, optional) */
	organizationId?: string;
	/** User's query text */
	query: string;
	/** Number of results to return (default: 5) */
	topK?: number;
	/** Minimum similarity threshold (default: 0.5 - cosine similarity) */
	minSimilarity?: number;
	/** API key for embedding generation (legacy, string only) */
	apiKey?: string;
	/** Full provider configuration for embedding generation */
	providerConfig?: EmbeddingProviderConfig;
	/** Optional: Specific document IDs to retrieve context from (if not provided, searches all documents in chat) */
	documentIds?: string[];
	/**
	 * Set by chat surfaces when `documentIds` are files the user explicitly
	 * attached to their message. When true (and `documentIds` is non-empty),
	 * the semantic-similarity floor is dropped so the attached content always
	 * reaches the model regardless of how closely the question matches it.
	 * Leave unset for programmatic/scoped retrieval (e.g. the v1 knowledge API)
	 * that wants `minSimilarity` honoured. Default: false.
	 */
	explicitAttachment?: boolean;
}
