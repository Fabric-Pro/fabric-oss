/**
 * Types for embedding generation
 */

/**
 * Embedding result
 */
export interface EmbeddingResult {
	/** Embedding vector */
	embedding: number[];
	/** Model used for embedding */
	model: string;
	/** Token count */
	tokens: number;
}

/**
 * Batch embedding result
 */
export interface BatchEmbeddingResult {
	/** Array of embeddings */
	embeddings: number[][];
	/** Model used */
	model: string;
	/** Total tokens used */
	totalTokens: number;
	/** Cost in dollars */
	cost: number;
}

/**
 * Multi-tenancy context for tracking usage per user/organization
 *
 * This context is passed to Vercel AI Gateway via providerOptions.gateway
 * to enable per-tenant usage tracking, cost attribution, and rate limiting.
 *
 * @see https://sdk.vercel.ai/providers/ai-sdk-providers/ai-gateway#tracking-usage
 */
export interface TenantContext {
	/** User ID for usage tracking and cost attribution */
	userId?: string;
	/** Organization ID for usage tracking and cost attribution */
	organizationId?: string;
	/** Project ID for per-project cost attribution in AiUsageLog */
	projectId?: string;
	/** Additional tags for categorization (e.g., 'rag-embedding', 'document-processing') */
	tags?: string[];
}
