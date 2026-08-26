/**
 * Types for vector store operations
 */

import type { SparseVector } from "../embedding/sparse";

/**
 * Retrieval result from vector search
 */
export interface RetrievalResult {
	/** Chunk ID */
	id: string;
	/** Chunk content */
	content: string;
	/** Similarity score (0-1, higher is more similar) */
	similarity: number;
	/** Document ID */
	documentId: string;
	/** Document filename */
	filename: string;
	/** Chunk metadata */
	metadata: Record<string, unknown>;
}

/**
 * Options for storing a chunk
 */
export interface StoreChunkOptions {
	/** Document ID */
	documentId: string;
	/** Chat ID */
	chatId: string;
	/** User ID (for multi-tenancy) */
	userId: string;
	/** Organization ID (for multi-tenancy, optional) */
	organizationId?: string;
	/** Chunk content */
	content: string;
	/** Chunk index */
	chunkIndex: number;
	/** Dense embedding vector */
	embedding: number[];
	/** Sparse BM25 vector for hybrid search (optional — generated automatically if not provided) */
	sparseVector?: SparseVector;
	/** Chunk metadata */
	metadata: Record<string, unknown>;
}

/**
 * Options for searching similar chunks
 */
export interface SearchOptions {
	/** Chat ID to search within */
	chatId: string;
	/** User ID (for multi-tenancy) */
	userId: string;
	/** Organization ID (for multi-tenancy, optional) */
	organizationId?: string;
	/** Query embedding vector */
	queryEmbedding: number[];
	/** Query sparse vector for hybrid search (optional) */
	querySparseVector?: SparseVector;
	/** Number of results to return (default: 5) */
	topK?: number;
	/** Minimum similarity threshold (default: 0.7) */
	minSimilarity?: number;
	/** Optional: Specific document IDs to retrieve context from (if not provided, searches all documents in chat) */
	documentIds?: string[];
	/**
	 * Set by chat surfaces when `documentIds` are files the user explicitly
	 * attached to their message. When true (and `documentIds` is non-empty), the
	 * similarity floor is dropped so the attached content always reaches the
	 * model. Unset for programmatic/scoped retrieval (e.g. the v1 knowledge API).
	 * Default: false.
	 */
	explicitAttachment?: boolean;
	/**
	 * Enable hybrid search (BM25 + vector with RRF fusion).
	 * Requires querySparseVector. Default: true when querySparseVector is provided.
	 */
	enableHybrid?: boolean;
}
