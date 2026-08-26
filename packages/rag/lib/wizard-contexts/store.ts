/**
 * Vector store operations for wizard contexts using Qdrant
 *
 * Handles storing and retrieving wizard context embeddings during the project
 * creation wizard flow. Uses the same collection as project contexts but with
 * session-based isolation until the project is created.
 *
 * Multi-tenancy:
 * - Personal data (organizationId = null): Shared collection with sessionId + userId filtering
 * - Organization data: Dedicated collections per organization for physical isolation
 *
 * Security Model:
 * - During wizard: Isolated by sessionId + userId + organizationId
 * - After project creation: Embeddings are bound to projectId via payload update
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { ensureCollection } from "../collection-manager";
import { generatePointId as generatePointIdBase } from "../utils";
import { qdrantClient } from "../vector-store/client";
import type {
	BindWizardEmbeddingsOptions,
	BindWizardEmbeddingsResult,
	DeleteWizardContextOptions,
	WizardContextSearchOptions,
	WizardContextSearchResult,
	WizardContextStoreOptions,
} from "./types";

/**
 * Get the collection name for wizard contexts based on organization
 * Uses the same collection as project contexts
 */
async function getWizardCollection(
	organizationId?: string | null,
): Promise<string> {
	return ensureCollection("project-contexts", organizationId);
}

/**
 * Generate a deterministic point ID for a wizard context chunk
 */
function generatePointId(contextId: string, chunkIndex = 0): string {
	return generatePointIdBase(`wizard-${contextId}-${chunkIndex}`);
}

/**
 * Store a wizard context chunk with its embedding in Qdrant
 *
 * @param options - Store options
 * @returns Qdrant point ID
 */
export async function storeWizardContext(
	options: WizardContextStoreOptions,
): Promise<string> {
	const {
		contextId,
		sessionId,
		userId,
		organizationId,
		embedding,
		chunkIndex = 0,
		totalChunks = 1,
		metadata,
	} = options;

	logger.info(
		`[WizardContextStore] Storing context ${contextId} for session ${sessionId} (chunk ${chunkIndex + 1}/${totalChunks})`,
	);

	try {
		// Get collection name (creates org-specific collection if needed)
		const collectionName = await getWizardCollection(organizationId);

		// Generate deterministic point ID
		const pointId = generatePointId(contextId, chunkIndex);

		// Store in Qdrant with wizard-specific payload
		await qdrantClient.upsert(collectionName, {
			wait: true,
			points: [
				{
					id: pointId,
					vector: embedding,
					payload: {
						contextId,
						sessionId,
						projectId: null, // NULL during wizard phase
						userId,
						organizationId: organizationId || null,
						type: metadata?.type || "unknown",
						filename: metadata?.filename,
						chunkIndex,
						totalChunks,
						isWizardContext: true, // Flag to distinguish from regular project contexts
						createdAt: new Date().toISOString(),
					},
				},
			],
		});

		logger.info(
			`[WizardContextStore] Context stored successfully with point ID: ${pointId}`,
		);

		return pointId;
	} catch (error) {
		logger.error(`[WizardContextStore] Failed to store context: ${error}`);
		throw new Error(
			`Failed to store wizard context: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Search for similar wizard contexts using vector similarity
 *
 * Security Model:
 * - Physical isolation: Organization data is in separate collections
 * - Session isolation: Filtering by sessionId ensures cross-session isolation
 * - User verification: Filtering by userId ensures only owner can access
 *
 * @param options - Search options
 * @returns Array of search results
 */
export async function searchWizardContexts(
	options: WizardContextSearchOptions,
): Promise<WizardContextSearchResult[]> {
	const {
		sessionId,
		userId,
		organizationId,
		queryEmbedding,
		topK = 5,
		minSimilarity = 0.5,
		contextIds,
	} = options;

	logger.info(
		`[WizardContextStore] Searching wizard contexts for session ${sessionId} (topK=${topK}, minSimilarity=${minSimilarity})`,
	);

	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getWizardCollection(organizationId);

		// Build filter with defense-in-depth tenant isolation
		const filter: {
			must: Array<
				| {
						key: string;
						match: { value: string | boolean } | { any: string[] };
				  }
				| { is_null: { key: string } }
			>;
		} = {
			must: [
				// Primary: Session isolation
				{ key: "sessionId", match: { value: sessionId } },
				// Secondary: User ownership
				{ key: "userId", match: { value: userId } },
				// Tertiary: Must be a wizard context
				{ key: "isWizardContext", match: { value: true } },
			],
		};

		// For org contexts, scope to org (additional safety layer)
		// For personal contexts, add explicit is_null check
		if (organizationId) {
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			filter.must.push({
				is_null: { key: "organizationId" },
			});
		}

		// Add specific context IDs filter if provided
		if (contextIds && contextIds.length > 0) {
			filter.must.push({
				key: "contextId",
				match: { any: contextIds },
			});
		}

		// Search Qdrant
		const searchResult = await qdrantClient.search(collectionName, {
			vector: queryEmbedding,
			limit: topK,
			score_threshold: minSimilarity,
			filter,
		});

		if (searchResult.length === 0) {
			logger.info("[WizardContextStore] No similar contexts found");
			return [];
		}

		// Map results to search result format
		const results: WizardContextSearchResult[] = searchResult.map(
			(result) => ({
				contextId: result.payload?.contextId as string,
				sessionId: result.payload?.sessionId as string,
				score: result.score,
				type: result.payload?.type as string,
				filename: result.payload?.filename as string | undefined,
				chunkIndex: result.payload?.chunkIndex as number | undefined,
			}),
		);

		logger.info(
			`[WizardContextStore] Found ${results.length} similar contexts`,
		);

		return results;
	} catch (error) {
		logger.error(
			`[WizardContextStore] Failed to search contexts: ${error}`,
		);
		throw new Error(
			`Failed to search wizard contexts: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Bind wizard embeddings to a project after project creation
 *
 * Updates Qdrant point payloads to:
 * - Set projectId
 * - Update contextId to the new ProjectContext ID
 * - Set isWizardContext to false
 * - Clear sessionId
 *
 * This is more efficient than re-embedding since vectors don't change.
 *
 * @param options - Binding options
 * @returns Binding result with count and any errors
 */
export async function bindWizardEmbeddingsToProject(
	options: BindWizardEmbeddingsOptions,
): Promise<BindWizardEmbeddingsResult> {
	const { sessionId, projectId, contextIdMapping, userId, organizationId } =
		options;

	logger.info(
		`[WizardContextStore] Binding ${contextIdMapping.size} wizard embeddings to project ${projectId}`,
	);

	const errors: string[] = [];
	let boundCount = 0;

	try {
		const collectionName = await getWizardCollection(organizationId);

		// Build filter to find all wizard context points for this session
		const filter: {
			must: Array<
				| { key: string; match: { value: string | boolean } }
				| { is_null: { key: string } }
			>;
		} = {
			must: [
				{ key: "sessionId", match: { value: sessionId } },
				{ key: "userId", match: { value: userId } },
				{ key: "isWizardContext", match: { value: true } },
			],
		};

		if (organizationId) {
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			filter.must.push({
				is_null: { key: "organizationId" },
			});
		}

		// Scroll through all matching points
		// Note: ExtendedPointId can be string | number | Record<string, unknown>
		// but in practice Qdrant returns string/number offsets for scroll pagination
		let offset: string | number | Record<string, unknown> | undefined;

		do {
			const scrollResult = await qdrantClient.scroll(collectionName, {
				filter,
				limit: 100,
				offset,
				with_payload: true,
			});

			for (const point of scrollResult.points) {
				const oldContextId = point.payload?.contextId as string;
				const newContextId = contextIdMapping.get(oldContextId);

				if (newContextId) {
					try {
						// Update payload to bind to project
						await qdrantClient.setPayload(collectionName, {
							points: [point.id],
							payload: {
								contextId: newContextId,
								projectId,
								sessionId: null, // Clear session
								isWizardContext: false, // No longer a wizard context
							},
						});

						// Update database with qdrantId so deletion can find the point later
						const qdrantPointId = String(point.id);
						await db.projectContext.update({
							where: { id: newContextId },
							data: { qdrantId: qdrantPointId },
						});

						boundCount++;
					} catch (error) {
						const errorMsg = `Failed to bind point ${point.id}: ${error instanceof Error ? error.message : "Unknown error"}`;
						logger.warn(`[WizardContextStore] ${errorMsg}`);
						errors.push(errorMsg);
					}
				} else {
					logger.warn(
						`[WizardContextStore] No mapping found for context ${oldContextId}`,
					);
				}
			}

			offset = scrollResult.next_page_offset ?? undefined;
		} while (offset);

		logger.info(
			`[WizardContextStore] Bound ${boundCount} embeddings to project ${projectId}`,
		);

		return { boundCount, errors };
	} catch (error) {
		const errorMsg = `Failed to bind wizard embeddings: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[WizardContextStore] ${errorMsg}`);
		errors.push(errorMsg);
		return { boundCount, errors };
	}
}

/**
 * Delete a wizard context from Qdrant
 *
 * Deletes all chunks for a given context ID within a session.
 *
 * @param options - Delete options
 */
export async function deleteWizardContext(
	options: DeleteWizardContextOptions,
): Promise<void> {
	const { sessionId, contextId, organizationId } = options;

	logger.info(
		`[WizardContextStore] Deleting wizard context ${contextId} from session ${sessionId}`,
	);

	try {
		const collectionName = await getWizardCollection(organizationId);

		// Build filter to find all chunks for this context
		const filter: {
			must: Array<
				| { key: string; match: { value: string | boolean } }
				| { is_null: { key: string } }
			>;
		} = {
			must: [
				{ key: "sessionId", match: { value: sessionId } },
				{ key: "contextId", match: { value: contextId } },
				{ key: "isWizardContext", match: { value: true } },
			],
		};

		if (organizationId) {
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			filter.must.push({
				is_null: { key: "organizationId" },
			});
		}

		// Delete from Qdrant
		await qdrantClient.delete(collectionName, {
			wait: true,
			filter,
		});

		logger.info(
			`[WizardContextStore] Wizard context deleted: ${contextId}`,
		);
	} catch (error) {
		logger.error(`[WizardContextStore] Failed to delete context: ${error}`);
		throw new Error(
			`Failed to delete wizard context: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Options for deleting all wizard contexts for a session
 */
export interface DeleteAllWizardContextsOptions {
	sessionId: string;
	userId: string;
	organizationId?: string;
}

/**
 * Delete all wizard contexts for a session
 *
 * Used during cleanup of expired wizard sessions.
 * Includes userId filter for security to ensure only the session owner's
 * embeddings are deleted.
 *
 * @param options - Delete options
 * @returns Number of points deleted
 */
export async function deleteAllWizardContextsForSession(
	options: DeleteAllWizardContextsOptions,
): Promise<number> {
	const { sessionId, userId, organizationId } = options;

	logger.info(
		`[WizardContextStore] Deleting all wizard contexts for session: ${sessionId}`,
	);

	try {
		const collectionName = await getWizardCollection(organizationId);

		// Build filter to find all wizard contexts for this session
		// Include userId filter for security
		const filter: {
			must: Array<
				| { key: string; match: { value: string | boolean } }
				| { is_null: { key: string } }
			>;
		} = {
			must: [
				{ key: "sessionId", match: { value: sessionId } },
				{ key: "userId", match: { value: userId } },
				{ key: "isWizardContext", match: { value: true } },
			],
		};

		if (organizationId) {
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			filter.must.push({
				is_null: { key: "organizationId" },
			});
		}

		// Count points before deletion to return the count
		const countResult = await qdrantClient.count(collectionName, {
			filter,
			exact: true,
		});

		const pointCount = countResult.count;

		if (pointCount > 0) {
			// Delete from Qdrant
			await qdrantClient.delete(collectionName, {
				wait: true,
				filter,
			});

			logger.info(
				`[WizardContextStore] Deleted ${pointCount} wizard contexts for session: ${sessionId}`,
			);
		} else {
			logger.info(
				`[WizardContextStore] No wizard contexts found for session: ${sessionId}`,
			);
		}

		return pointCount;
	} catch (error) {
		logger.error(
			`[WizardContextStore] Failed to delete session contexts: ${error}`,
		);
		throw new Error(
			`Failed to delete wizard session contexts: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
