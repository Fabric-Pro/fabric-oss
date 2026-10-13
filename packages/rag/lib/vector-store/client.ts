/**
 * Qdrant client configuration
 * Manages connection to Qdrant vector database
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { logger } from "@repo/logs";
import { throwIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { VECTOR_STORE_DIMENSIONS } from "../embedding/dimensions";

// Qdrant configuration from environment variables
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

// Collection configuration
export const COLLECTION_NAME =
	process.env.QDRANT_COLLECTION_NAME || "chat-documents";
export const VECTOR_SIZE = VECTOR_STORE_DIMENSIONS;
export const DISTANCE_METRIC = "Cosine"; // Cosine similarity for embeddings

/**
 * Every Qdrant client method that changes something on the server. Typed
 * against the client, so a misspelled or removed name fails to compile.
 */
const QDRANT_WRITE_METHODS: ReadonlySet<PropertyKey> = new Set<
	keyof QdrantClient
>([
	"batchUpdate",
	"clearPayload",
	"createCollection",
	"createFullSnapshot",
	"createPayloadIndex",
	"createShardKey",
	"createShardSnapshot",
	"createSnapshot",
	"delete",
	"deleteCollection",
	"deleteFullSnapshot",
	"deletePayload",
	"deletePayloadIndex",
	"deleteShardKey",
	"deleteShardSnapshot",
	"deleteSnapshot",
	"deleteVectors",
	"overwritePayload",
	"recoverShardFromSnapshot",
	"recoverSnapshot",
	"recreateCollection",
	"setPayload",
	"updateCollection",
	"updateCollectionAliases",
	"updateCollectionCluster",
	"updateVectors",
	"upsert",
]);

/**
 * The client with Fabric's stop check at its write boundary: each write
 * method checks the ambient dispatch guard (an Advisor chat turn that has
 * stopped or used its token allowance) synchronously as it is called,
 * immediately before the request goes out, and rejects with the stop
 * instead of sending. Every Fabric caller is covered, including writes that
 * follow their own awaits, such as a point upsert after its collection
 * lookup. Reads pass through. Outside a turn it is the plain client.
 *
 * The collection manager's provisioning (creating a collection, its payload
 * indexes, enabling sparse vectors) runs outside every turn's guard
 * (`runOutsideDispatchGuard` in `collection-manager/index.ts`), so this
 * check is a no-op there: that work is shared between callers and carries
 * no turn's content, and one turn's stop must not fail it for the others.
 */
function refuseWritesAfterDispatchStop(client: QdrantClient): QdrantClient {
	return new Proxy(client, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (
				typeof value !== "function" ||
				!QDRANT_WRITE_METHODS.has(property)
			) {
				return value;
			}
			return (...args: unknown[]) => {
				try {
					throwIfDispatchStopped();
				} catch (stop) {
					return Promise.reject(stop);
				}
				return (value as (...a: unknown[]) => unknown).apply(
					target,
					args,
				);
			};
		},
	});
}

/**
 * Initialize Qdrant client
 */
export const qdrantClient = refuseWritesAfterDispatchStop(
	new QdrantClient({
		url: QDRANT_URL,
		apiKey: QDRANT_API_KEY,
	}),
);

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
