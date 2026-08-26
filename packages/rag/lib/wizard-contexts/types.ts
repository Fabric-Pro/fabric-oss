/**
 * Type definitions for wizard context RAG operations
 *
 * Wizard contexts are temporary contexts uploaded during the project creation wizard.
 * They are isolated by sessionId until the project is created, then bound to projectId.
 */

/**
 * Options for storing a wizard context in Qdrant
 */
export interface WizardContextStoreOptions {
	contextId: string;
	sessionId: string;
	userId: string;
	organizationId?: string | null;
	content: string;
	embedding: number[];
	chunkIndex?: number;
	totalChunks?: number;
	metadata?: {
		type?: string;
		filename?: string;
		mimeType?: string;
		size?: number;
		[key: string]: unknown;
	};
}

/**
 * Options for searching wizard contexts
 */
export interface WizardContextSearchOptions {
	sessionId: string;
	userId: string;
	organizationId?: string | null;
	queryEmbedding: number[];
	topK?: number;
	minSimilarity?: number;
	contextIds?: string[]; // Optional: filter by specific context IDs
}

/**
 * Result from wizard context search
 */
export interface WizardContextSearchResult {
	contextId: string;
	sessionId: string;
	score: number;
	type: string;
	filename?: string;
	chunkIndex?: number;
}

/**
 * Options for retrieving wizard contexts with semantic search
 */
export interface WizardContextRetrievalOptions {
	sessionId: string;
	query: string;
	userId: string;
	organizationId?: string | null;
	/** Required - AI API key string (legacy) or full provider config */
	apiKey: string | WizardRetrievalProviderConfig;
	/** Number of results to return (default: 5) */
	topK?: number;
	/** Minimum similarity threshold (default: 0.5) */
	similarityThreshold?: number;
}

/**
 * Provider configuration for embeddings
 */
export interface WizardRetrievalProviderConfig {
	apiKey: string;
	provider?: string | null;
	baseUrl?: string | null;
}

/**
 * Retrieved wizard context with full content
 */
export interface RetrievedWizardContext {
	id: string;
	type: string;
	content: string;
	score: number;
	filename?: string;
	mimeType?: string;
}

/**
 * Options for binding wizard embeddings to a project
 */
export interface BindWizardEmbeddingsOptions {
	sessionId: string;
	projectId: string;
	/** Map of WizardTempContext.id -> ProjectContext.id */
	contextIdMapping: Map<string, string>;
	userId: string;
	organizationId?: string | null;
}

/**
 * Result from binding wizard embeddings to a project
 */
export interface BindWizardEmbeddingsResult {
	boundCount: number;
	errors: string[];
}

/**
 * Options for deleting wizard context embeddings
 */
export interface DeleteWizardContextOptions {
	sessionId: string;
	contextId: string;
	organizationId?: string | null;
}
