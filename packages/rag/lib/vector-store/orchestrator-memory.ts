/**
 * Orchestrator Memory Vector Store
 *
 * Qdrant collection for semantic search of orchestrator execution history.
 * Complements Letta's structured memory with vector-based similarity search.
 *
 * Features:
 * - Store execution summaries as vector embeddings
 * - Semantic search for similar past tasks
 * - Multi-tenant isolation (userId, organizationId)
 * - Physical isolation: Organization data in separate collections
 * - Graceful degradation if Qdrant unavailable
 */

import { logger } from "@repo/logs";
import { ensureCollection } from "../collection-manager";
import { generatePointId } from "../utils";
import { qdrantClient } from "./client";

// Collection configuration
export const ORCHESTRATOR_MEMORY_COLLECTION = "fabric_orchestrator_memory";

/**
 * Get the collection name for orchestrator memory based on organization
 */
async function getOrchestratorCollection(
	organizationId?: string | null,
): Promise<string> {
	return ensureCollection("fabric_orchestrator_memory", organizationId);
}

/**
 * Initialize orchestrator memory collection
 * Creates the collection if it doesn't exist
 * @deprecated Use getOrchestratorCollection() instead which handles collection per org
 */
export async function initializeOrchestratorMemoryCollection(): Promise<boolean> {
	try {
		// Initialize the shared collection for personal data (orgId = null)
		await getOrchestratorCollection(null);
		return true;
	} catch (error) {
		logger.error(
			`[OrchestratorMemory] Failed to initialize collection: ${error}`,
		);
		return false;
	}
}

// ============================================================================
// Types
// ============================================================================

export interface ExecutionSummary {
	/** Unique execution ID */
	id: string;
	/** Original task description from user */
	taskDescription: string;
	/** Hash for deduplication */
	taskHash: string;
	/** LLM-generated summary for embedding */
	summary: string;
	/** Agents used in execution */
	agentsUsed: string[];
	/** Tools used in execution */
	toolsUsed: string[];
	/** Execution outcome */
	outcome: "success" | "partial" | "failure";
	/** Duration in milliseconds */
	durationMs: number;
	/** Number of steps */
	stepCount: number;
	/** User ID for multi-tenancy */
	userId: string;
	/** Organization ID for multi-tenancy */
	organizationId?: string;
	/** Timestamp */
	timestamp: string;
}

export interface SemanticSearchResult {
	/** Execution summary */
	execution: ExecutionSummary;
	/** Similarity score (0-1) */
	similarity: number;
}

export interface StoreExecutionOptions {
	execution: ExecutionSummary;
	embedding: number[];
}

export interface SearchExecutionsOptions {
	queryEmbedding: number[];
	userId: string;
	organizationId?: string;
	topK?: number;
	minSimilarity?: number;
	outcomeFilter?: "success" | "partial" | "failure";
}

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Check if an execution already exists in the collection
 * Used to avoid duplicate embedding generation during Temporal replays
 */
export async function executionExists(
	executionId: string,
	organizationId?: string | null,
): Promise<boolean> {
	try {
		const collectionName = await getOrchestratorCollection(organizationId);

		const pointId = generatePointId(executionId);
		const result = await qdrantClient.retrieve(collectionName, {
			ids: [pointId],
			with_payload: false,
			with_vector: false,
		});

		return result.length > 0;
	} catch (error) {
		logger.warn(
			`[OrchestratorMemory] Failed to check execution existence: ${error}`,
		);
		return false;
	}
}

/**
 * Store an execution summary with its embedding
 * Physical isolation: Organization data is stored in separate collections
 */
export async function storeExecutionSummary(
	options: StoreExecutionOptions,
): Promise<boolean> {
	const { execution, embedding } = options;

	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getOrchestratorCollection(
			execution.organizationId,
		);

		const pointId = generatePointId(execution.id);

		// Build payload
		const payload: Record<string, unknown> = {
			executionId: execution.id,
			taskDescription: execution.taskDescription,
			taskHash: execution.taskHash,
			summary: execution.summary,
			agentsUsed: execution.agentsUsed,
			toolsUsed: execution.toolsUsed,
			outcome: execution.outcome,
			durationMs: execution.durationMs,
			stepCount: execution.stepCount,
			userId: execution.userId,
			timestamp: execution.timestamp,
		};

		if (execution.organizationId) {
			payload.organizationId = execution.organizationId;
		}

		await qdrantClient.upsert(collectionName, {
			wait: true,
			points: [
				{
					id: pointId,
					vector: embedding,
					payload,
				},
			],
		});

		logger.info(
			`[OrchestratorMemory] Stored execution ${execution.id} (${execution.outcome})`,
		);
		return true;
	} catch (error) {
		logger.error(
			`[OrchestratorMemory] Failed to store execution: ${error}`,
		);
		return false;
	}
}

/**
 * Search for similar past executions using semantic similarity
 * Physical isolation: Organization data is in separate collections
 */
export async function searchSimilarExecutions(
	options: SearchExecutionsOptions,
): Promise<SemanticSearchResult[]> {
	const {
		queryEmbedding,
		userId,
		organizationId,
		topK = 5,
		minSimilarity = 0.5,
		outcomeFilter,
	} = options;

	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getOrchestratorCollection(organizationId);

		// Build filter for multi-tenancy (additional safety layer within collection)
		const filter: {
			must: Array<{ key: string; match: { value: string } }>;
		} = {
			must: [],
		};

		// User/org isolation - match either userId OR organizationId
		if (organizationId) {
			// For org users, match on organizationId
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			// For personal users, match on userId
			filter.must.push({
				key: "userId",
				match: { value: userId },
			});
		}

		// Optional outcome filter
		if (outcomeFilter) {
			filter.must.push({
				key: "outcome",
				match: { value: outcomeFilter },
			});
		}

		const searchResult = await qdrantClient.search(collectionName, {
			vector: queryEmbedding,
			limit: topK,
			score_threshold: minSimilarity,
			filter: filter.must.length > 0 ? filter : undefined,
		});

		if (searchResult.length === 0) {
			logger.info("[OrchestratorMemory] No similar executions found");
			return [];
		}

		// Map results to ExecutionSummary
		const results: SemanticSearchResult[] = searchResult.map((result) => ({
			execution: {
				id: result.payload?.executionId as string,
				taskDescription: result.payload?.taskDescription as string,
				taskHash: result.payload?.taskHash as string,
				summary: result.payload?.summary as string,
				agentsUsed: result.payload?.agentsUsed as string[],
				toolsUsed: result.payload?.toolsUsed as string[],
				outcome: result.payload?.outcome as
					| "success"
					| "partial"
					| "failure",
				durationMs: result.payload?.durationMs as number,
				stepCount: result.payload?.stepCount as number,
				userId: result.payload?.userId as string,
				organizationId: result.payload?.organizationId as
					| string
					| undefined,
				timestamp: result.payload?.timestamp as string,
			},
			similarity: result.score,
		}));

		logger.info(
			`[OrchestratorMemory] Found ${results.length} similar executions (top: ${results[0]?.similarity.toFixed(3)})`,
		);

		return results;
	} catch (error) {
		logger.error(
			`[OrchestratorMemory] Failed to search executions: ${error}`,
		);
		return [];
	}
}

/**
 * Delete all executions for a user (for GDPR compliance)
 * Note: This only deletes from personal collection
 */
export async function deleteUserExecutions(userId: string): Promise<number> {
	try {
		// Delete from personal collection (no organizationId)
		const collectionName = await getOrchestratorCollection(null);

		const result = await qdrantClient.delete(collectionName, {
			wait: true,
			filter: {
				must: [
					{
						key: "userId",
						match: { value: userId },
					},
				],
			},
		});

		logger.info(
			`[OrchestratorMemory] Deleted executions for user ${userId}`,
		);
		return typeof result === "object" ? 1 : 0;
	} catch (error) {
		logger.error(
			`[OrchestratorMemory] Failed to delete user executions: ${error}`,
		);
		return 0;
	}
}
