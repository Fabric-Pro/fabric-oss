/**
 * Types for workspace document vector store operations
 */
import type { SparseVector } from "../embedding/sparse";

/**
 * Options for storing a workspace document chunk
 */
export interface WorkspaceChunkStoreOptions {
	/** Chunk ID from PostgreSQL */
	chunkId: string;
	/** Document ID */
	documentId: string;
	/** Workspace ID */
	workspaceId: string;
	/** User ID (who uploaded) */
	userId: string;
	/** Organization ID (for multi-tenancy, optional) */
	organizationId?: string;
	/** Chunk content */
	content: string;
	/** Chunk index */
	chunkIndex: number;
	/** Embedding vector */
	embedding: number[];
	/** Sparse vector for hybrid retrieval */
	sparseVector?: SparseVector;
	/** Original filename */
	filename?: string;
	/** Page number if applicable */
	pageNumber?: number;
	/** Section headings for context */
	headings?: string[];
}

/**
 * Options for searching workspace document chunks
 */
export interface WorkspaceSearchOptions {
	/** Workspace ID to search within */
	workspaceId: string;
	/** User ID (for access verification) */
	userId: string;
	/** Organization ID (for multi-tenancy, optional) */
	organizationId?: string;
	/** Query embedding vector */
	queryEmbedding: number[];
	/** Sparse query vector for hybrid retrieval */
	querySparseVector?: SparseVector;
	/** Number of results to return (default: 5) */
	topK?: number;
	/** Minimum similarity threshold (default: 0.5) */
	minSimilarity?: number;
	/** Optional: Specific document IDs to filter to */
	documentIds?: string[];
	/** Enable hybrid retrieval when supported (default: true) */
	enableHybrid?: boolean;
}

/**
 * Options for searching across multiple workspaces
 */
export interface MultiWorkspaceSearchOptions {
	/** Workspace IDs to search within */
	workspaceIds: string[];
	/** User ID (for access verification) */
	userId: string;
	/** Organization ID (for multi-tenancy, optional) */
	organizationId?: string;
	/** Query embedding vector */
	queryEmbedding: number[];
	/** Sparse query vector for hybrid retrieval */
	querySparseVector?: SparseVector;
	/** Number of results to return per workspace (default: 5) */
	topK?: number;
	/** Minimum similarity threshold (default: 0.5) */
	minSimilarity?: number;
	/** Optional: Specific document IDs to filter to */
	documentIds?: string[];
	/** Enable hybrid retrieval when supported (default: true) */
	enableHybrid?: boolean;
}

/**
 * Retrieval result from workspace document vector search
 */
export interface WorkspaceRetrievalResult {
	/** Chunk ID */
	chunkId: string;
	/** Document ID */
	documentId: string;
	/** Workspace ID */
	workspaceId: string;
	/** Similarity score (0-1, higher is more similar) */
	score: number;
	/** Original filename */
	filename?: string;
	/** Chunk index */
	chunkIndex: number;
	/** Page number if applicable */
	pageNumber?: number;
	/** Section headings */
	headings?: string[];
}

/**
 * Bulk store options for efficiency
 */
export interface BulkStoreOptions {
	/** Chunks to store */
	chunks: WorkspaceChunkStoreOptions[];
	/** Whether to wait for indexing to complete */
	wait?: boolean;
}
