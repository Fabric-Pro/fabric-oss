/**
 * Qdrant client configuration for project contexts
 * Manages connection to Qdrant vector database for project-based RAG
 */

import { logger } from "@repo/logs";
import { DISTANCE_METRIC, qdrantClient, VECTOR_SIZE } from "../vector-store";

// Collection configuration for project contexts
export const PROJECT_COLLECTION_NAME =
	process.env.QDRANT_PROJECT_COLLECTION_NAME || "project-contexts";

// Re-export shared constants for convenience
export { DISTANCE_METRIC, VECTOR_SIZE, qdrantClient };

/**
 * Initialize Qdrant collection for project contexts
 * Creates the collection if it doesn't exist
 * Should be called on application startup or first use
 */
export async function initializeProjectContextsCollection(): Promise<void> {
	logger.info(
		`[Qdrant] Initializing project contexts collection: ${PROJECT_COLLECTION_NAME}`,
	);

	try {
		// Check if collection exists
		const collections = await qdrantClient.getCollections();
		const collectionExists = collections.collections.some(
			(col) => col.name === PROJECT_COLLECTION_NAME,
		);

		if (collectionExists) {
			logger.info(
				`[Qdrant] Collection "${PROJECT_COLLECTION_NAME}" already exists`,
			);
			return;
		}

		// Create collection with vector configuration
		await qdrantClient.createCollection(PROJECT_COLLECTION_NAME, {
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
			`[Qdrant] Collection "${PROJECT_COLLECTION_NAME}" created successfully`,
		);

		// Create payload indexes for efficient filtering
		// These indexes speed up multi-tenancy filtering
		await qdrantClient.createPayloadIndex(PROJECT_COLLECTION_NAME, {
			field_name: "projectId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(PROJECT_COLLECTION_NAME, {
			field_name: "userId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(PROJECT_COLLECTION_NAME, {
			field_name: "organizationId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(PROJECT_COLLECTION_NAME, {
			field_name: "contextId",
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
 * Check Qdrant connection health for project contexts
 */
export async function checkProjectContextsQdrantHealth(): Promise<boolean> {
	try {
		await qdrantClient.getCollections();
		logger.info("[Qdrant] Connection healthy");
		return true;
	} catch (error) {
		logger.error(`[Qdrant] Connection failed: ${error}`);
		return false;
	}
}
