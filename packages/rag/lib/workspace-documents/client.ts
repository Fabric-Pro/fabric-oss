/**
 * Qdrant client configuration for workspace documents
 * Manages connection to Qdrant vector database for workspace-based RAG
 */

import { logger } from "@repo/logs";
import { DISTANCE_METRIC, qdrantClient, VECTOR_SIZE } from "../vector-store";

// Collection configuration for workspace documents
export const WORKSPACE_COLLECTION_NAME =
	process.env.QDRANT_WORKSPACE_COLLECTION_NAME || "workspace-documents";

// Re-export shared constants for convenience
export { DISTANCE_METRIC, VECTOR_SIZE, qdrantClient };

/**
 * Initialize Qdrant collection for workspace documents
 * Creates the collection if it doesn't exist
 * Should be called on application startup or first use
 */
export async function initializeWorkspaceDocumentsCollection(): Promise<void> {
	logger.info(
		`[Qdrant] Initializing workspace documents collection: ${WORKSPACE_COLLECTION_NAME}`,
	);

	try {
		// Check if collection exists
		const collections = await qdrantClient.getCollections();
		const collectionExists = collections.collections.some(
			(col) => col.name === WORKSPACE_COLLECTION_NAME,
		);

		if (collectionExists) {
			logger.info(
				`[Qdrant] Collection "${WORKSPACE_COLLECTION_NAME}" already exists`,
			);
			return;
		}

		// Create collection with vector configuration
		await qdrantClient.createCollection(WORKSPACE_COLLECTION_NAME, {
			vectors: {
				size: VECTOR_SIZE,
				distance: DISTANCE_METRIC,
			},
			// Enable optimized indexing for better search performance
			optimizers_config: {
				indexing_threshold: 10000,
			},
		});

		logger.info(
			`[Qdrant] Collection "${WORKSPACE_COLLECTION_NAME}" created successfully`,
		);

		// Create payload indexes for efficient filtering
		// These indexes speed up multi-tenancy and document filtering
		await qdrantClient.createPayloadIndex(WORKSPACE_COLLECTION_NAME, {
			field_name: "workspaceId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(WORKSPACE_COLLECTION_NAME, {
			field_name: "documentId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(WORKSPACE_COLLECTION_NAME, {
			field_name: "userId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(WORKSPACE_COLLECTION_NAME, {
			field_name: "organizationId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(WORKSPACE_COLLECTION_NAME, {
			field_name: "chunkId",
			field_schema: "keyword",
		});

		logger.info("[Qdrant] Payload indexes created successfully");
	} catch (error) {
		logger.error(`[Qdrant] Failed to initialize collection: ${error}`);
		throw new Error(
			`Failed to initialize Qdrant collection: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Check Qdrant connection health for workspace documents
 */
export async function checkWorkspaceDocumentsQdrantHealth(): Promise<boolean> {
	try {
		await qdrantClient.getCollections();
		logger.info("[Qdrant] Connection healthy");
		return true;
	} catch (error) {
		logger.error(`[Qdrant] Connection failed: ${error}`);
		return false;
	}
}

/**
 * Get collection statistics
 */
export async function getWorkspaceCollectionStats(): Promise<{
	pointsCount: number;
	vectorSize: number;
}> {
	try {
		const info = await qdrantClient.getCollection(
			WORKSPACE_COLLECTION_NAME,
		);
		let vectorSize = VECTOR_SIZE;

		if (
			info.config.params.vectors &&
			typeof info.config.params.vectors === "object" &&
			"size" in info.config.params.vectors &&
			typeof info.config.params.vectors.size === "number"
		) {
			vectorSize = info.config.params.vectors.size;
		}

		return {
			pointsCount: info.points_count ?? 0,
			vectorSize,
		};
	} catch (error) {
		logger.error(`[Qdrant] Failed to get collection stats: ${error}`);
		throw new Error(
			`Failed to get collection stats: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
