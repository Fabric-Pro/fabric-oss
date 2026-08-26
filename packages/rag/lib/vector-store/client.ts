/**
 * Qdrant client configuration
 * Manages connection to Qdrant vector database
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { logger } from "@repo/logs";

// Qdrant configuration from environment variables
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

// Collection configuration
export const COLLECTION_NAME =
	process.env.QDRANT_COLLECTION_NAME || "chat-documents";
export const VECTOR_SIZE = 1536; // OpenAI text-embedding-3-small dimensions
export const DISTANCE_METRIC = "Cosine"; // Cosine similarity for embeddings

/**
 * Initialize Qdrant client
 */
export const qdrantClient = new QdrantClient({
	url: QDRANT_URL,
	apiKey: QDRANT_API_KEY,
});

/**
 * Initialize Qdrant collection
 * Creates the collection if it doesn't exist
 * Should be called on application startup
 */
export async function initializeQdrantCollection(): Promise<void> {
	logger.info(`[Qdrant] Initializing collection: ${COLLECTION_NAME}`);

	try {
		// Check if collection exists
		const collections = await qdrantClient.getCollections();
		const collectionExists = collections.collections.some(
			(col) => col.name === COLLECTION_NAME,
		);

		if (collectionExists) {
			logger.info(
				`[Qdrant] Collection "${COLLECTION_NAME}" already exists`,
			);
			return;
		}

		// Create collection with vector configuration
		await qdrantClient.createCollection(COLLECTION_NAME, {
			vectors: {
				size: VECTOR_SIZE,
				distance: DISTANCE_METRIC,
			},
			// Enable optimized indexing for better search performance
			optimizers_config: {
				indexing_threshold: 10000,
			},
			// Create payload indexes for efficient filtering
			// These indexes speed up multi-tenancy filtering
		});

		logger.info(
			`[Qdrant] Collection "${COLLECTION_NAME}" created successfully`,
		);

		// Create payload indexes for multi-tenancy filtering
		await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
			field_name: "chatId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
			field_name: "userId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
			field_name: "organizationId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
			field_name: "documentId",
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
 * Check Qdrant connection health
 */
export async function checkQdrantHealth(): Promise<boolean> {
	try {
		await qdrantClient.getCollections();
		logger.info("[Qdrant] Connection healthy");
		return true;
	} catch (error) {
		logger.error(`[Qdrant] Connection failed: ${error}`);
		return false;
	}
}
