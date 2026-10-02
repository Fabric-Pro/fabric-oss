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
	/**
	 * The provider the call's model was resolved from. The generator always
	 * sets it; optional so a stand-in result need not.
	 */
	provider?: string;
	/**
	 * The model string the call embedded with, as resolved (`model` is its
	 * base name). With `provider`, it names the model that actually produced
	 * the vector, which a caller that records its index's model stamps
	 * rather than an identity resolved before the call. Set with `provider`.
	 */
	modelString?: string;
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
	/** The provider the call's model was resolved from; see `EmbeddingResult`. */
	provider?: string;
	/** The model string every embedding was produced with; see `EmbeddingResult`. */
	modelString?: string;
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
	/**
	 * Resolve the embedding model from the organization's configuration
	 * only, never the user's personal provider. Company context sets it
	 * (Fizzy #2719): its vectors are shared by the whole organization, so
	 * they must come from one model whoever embeds or searches.
	 */
	organizationOnly?: boolean;
}
