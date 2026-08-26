/**
 * Workspace Documents Vector Store
 *
 * Provides vector storage and retrieval for workspace document chunks
 * using Qdrant as the vector database.
 */

// Client configuration
export {
	checkWorkspaceDocumentsQdrantHealth,
	DISTANCE_METRIC,
	getWorkspaceCollectionStats,
	initializeWorkspaceDocumentsCollection,
	VECTOR_SIZE,
	WORKSPACE_COLLECTION_NAME,
} from "./client";

// Store operations
export {
	deleteAllWorkspaceChunks,
	deleteChunksByIds,
	deleteWorkspaceDocumentChunks,
	getDocumentChunkCount,
	getWorkspaceChunkCount,
	searchMultipleWorkspaces,
	searchWorkspaceChunks,
	storeWorkspaceChunk,
	storeWorkspaceChunksBatch,
} from "./store";

// Types
export type {
	BulkStoreOptions,
	MultiWorkspaceSearchOptions,
	WorkspaceChunkStoreOptions,
	WorkspaceRetrievalResult,
	WorkspaceSearchOptions,
} from "./types";
