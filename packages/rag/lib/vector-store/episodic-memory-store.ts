/**
 * Episodic Memory Vector Store
 *
 * Qdrant collection for semantic search of past conversations.
 * Enables the Orchestrator to find relevant past discussions based on
 * semantic similarity to the current query.
 *
 * Features:
 * - Store conversation summaries as vector embeddings
 * - Semantic search for similar past conversations
 * - Multi-tenant isolation (userId, organizationId, projectId, workspaceId)
 * - Physical isolation: Organization data in separate collections
 * - Graceful degradation if Qdrant unavailable
 */

import { logger } from "@repo/logs";
import { ensureCollection } from "../collection-manager";
import { generatePointId } from "../utils";
import { qdrantClient } from "./client";

// Collection configuration
const EPISODIC_MEMORY_COLLECTION_PREFIX = "fabric_episodic_memory";

/**
 * Get the collection name for episodic memory based on organization
 */
export async function getEpisodicMemoryCollection(
	organizationId?: string | null,
): Promise<string> {
	return ensureCollection(EPISODIC_MEMORY_COLLECTION_PREFIX, organizationId);
}

// ============================================================================
// Types
// ============================================================================

export interface EpisodeEmbedding {
	/** Unique episode ID (from EpisodicMemory table) */
	id: string;
	/** Conversation ID */
	conversationId: string;
	/** Episode title */
	title: string;
	/** Episode summary (used for embedding) */
	summary: string;
	/** Key topics for filtering */
	keyTopics: string[];
	/** User intents for filtering */
	userIntents: string[];
	/** Outcome of the conversation */
	outcome: string;
	/** User ID for multi-tenancy */
	userId: string;
	/** Organization ID for multi-tenancy */
	organizationId?: string | null;
	/** Project ID for scoping */
	projectId?: string | null;
	/** Workspace ID for scoping */
	workspaceId?: string | null;
	/** Agent ID (fabric-ai for orchestrator) */
	agentId?: string | null;
	/** Conversation end timestamp */
	conversationEndedAt: string;
}

export interface EpisodeSearchResult {
	/** Episode ID */
	id: string;
	/** Conversation ID */
	conversationId: string;
	/** Episode title */
	title: string;
	/** Episode summary */
	summary: string;
	/** Key topics */
	keyTopics: string[];
	/** Similarity score (0-1) */
	similarity: number;
	/** Project ID */
	projectId?: string | null;
	/** Workspace ID */
	workspaceId?: string | null;
}

export interface StoreEpisodeOptions {
	episode: EpisodeEmbedding;
	embedding: number[];
}

export interface SearchEpisodesOptions {
	queryEmbedding: number[];
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workspaceId?: string | null;
	agentId?: string | null;
	topK?: number;
	minSimilarity?: number;
	excludeConversationIds?: string[];
}

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Check if an episode already exists in the collection
 */
export async function episodeExists(
	episodeId: string,
	organizationId?: string | null,
): Promise<boolean> {
	try {
		const collectionName =
			await getEpisodicMemoryCollection(organizationId);
		const pointId = generatePointId(episodeId);

		const result = await qdrantClient.retrieve(collectionName, {
			ids: [pointId],
			with_payload: false,
			with_vector: false,
		});

		return result.length > 0;
	} catch (error) {
		logger.warn(
			`[EpisodicMemory] Failed to check episode existence: ${error}`,
		);
		return false;
	}
}

/**
 * Store an episode summary with its embedding
 * Physical isolation: Organization data is stored in separate collections
 */
export async function storeEpisodeEmbedding(
	options: StoreEpisodeOptions,
): Promise<{ success: boolean; pointId: string | null }> {
	const { episode, embedding } = options;

	try {
		const collectionName = await getEpisodicMemoryCollection(
			episode.organizationId,
		);
		const pointId = generatePointId(episode.id);

		// Build payload
		const payload: Record<string, unknown> = {
			episodeId: episode.id,
			conversationId: episode.conversationId,
			title: episode.title,
			summary: episode.summary,
			keyTopics: episode.keyTopics,
			userIntents: episode.userIntents,
			outcome: episode.outcome,
			userId: episode.userId,
			conversationEndedAt: episode.conversationEndedAt,
		};

		if (episode.organizationId) {
			payload.organizationId = episode.organizationId;
		}
		if (episode.projectId) {
			payload.projectId = episode.projectId;
		}
		if (episode.workspaceId) {
			payload.workspaceId = episode.workspaceId;
		}
		if (episode.agentId) {
			payload.agentId = episode.agentId;
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
			`[EpisodicMemory] Stored episode ${episode.id} (${episode.title})`,
		);
		return { success: true, pointId };
	} catch (error) {
		logger.error(`[EpisodicMemory] Failed to store episode: ${error}`);
		return { success: false, pointId: null };
	}
}

/**
 * Search for similar past episodes using semantic similarity
 */
export async function searchSimilarEpisodes(
	options: SearchEpisodesOptions,
): Promise<EpisodeSearchResult[]> {
	const {
		queryEmbedding,
		userId,
		organizationId,
		projectId,
		workspaceId,
		agentId,
		topK = 5,
		minSimilarity = 0.5,
		excludeConversationIds = [],
	} = options;

	try {
		const collectionName =
			await getEpisodicMemoryCollection(organizationId);

		// Build filter for multi-tenancy and scoping
		const mustConditions: Array<{ key: string; match: { value: string } }> =
			[];
		const shouldConditions: Array<{
			key: string;
			match: { value: string | null };
		}> = [];

		// User/org isolation
		if (organizationId) {
			mustConditions.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			mustConditions.push({
				key: "userId",
				match: { value: userId },
			});
		}

		// Optional scoping filters
		if (projectId) {
			shouldConditions.push({
				key: "projectId",
				match: { value: projectId },
			});
		}
		if (workspaceId) {
			shouldConditions.push({
				key: "workspaceId",
				match: { value: workspaceId },
			});
		}
		if (agentId) {
			mustConditions.push({
				key: "agentId",
				match: { value: agentId },
			});
		}

		// Build the filter object
		const filter: {
			must?: Array<{ key: string; match: { value: string } }>;
			should?: Array<{ key: string; match: { value: string | null } }>;
			must_not?: Array<{ key: string; match: { any: string[] } }>;
		} = {};

		if (mustConditions.length > 0) {
			filter.must = mustConditions;
		}
		if (shouldConditions.length > 0) {
			filter.should = shouldConditions;
		}
		if (excludeConversationIds.length > 0) {
			filter.must_not = [
				{
					key: "conversationId",
					match: { any: excludeConversationIds },
				},
			];
		}

		const searchResult = await qdrantClient.search(collectionName, {
			vector: queryEmbedding,
			limit: topK,
			score_threshold: minSimilarity,
			filter: Object.keys(filter).length > 0 ? filter : undefined,
		});

		if (searchResult.length === 0) {
			logger.info("[EpisodicMemory] No similar episodes found");
			return [];
		}

		const results: EpisodeSearchResult[] = searchResult.map((result) => ({
			id: result.payload?.episodeId as string,
			conversationId: result.payload?.conversationId as string,
			title: result.payload?.title as string,
			summary: result.payload?.summary as string,
			keyTopics: (result.payload?.keyTopics as string[]) || [],
			similarity: result.score,
			projectId: result.payload?.projectId as string | null,
			workspaceId: result.payload?.workspaceId as string | null,
		}));

		logger.info(
			`[EpisodicMemory] Found ${results.length} similar episodes (top: ${results[0]?.similarity.toFixed(3)})`,
		);

		return results;
	} catch (error) {
		logger.error(`[EpisodicMemory] Failed to search episodes: ${error}`);
		return [];
	}
}

/**
 * Delete an episode from the vector store
 */
export async function deleteEpisodeEmbedding(
	episodeId: string,
	organizationId?: string | null,
): Promise<boolean> {
	try {
		const collectionName =
			await getEpisodicMemoryCollection(organizationId);
		const pointId = generatePointId(episodeId);

		await qdrantClient.delete(collectionName, {
			wait: true,
			points: [pointId],
		});

		logger.info(`[EpisodicMemory] Deleted episode ${episodeId}`);
		return true;
	} catch (error) {
		logger.error(`[EpisodicMemory] Failed to delete episode: ${error}`);
		return false;
	}
}

/**
 * Delete all episodes for a conversation
 */
export async function deleteConversationEpisodes(
	conversationId: string,
	organizationId?: string | null,
): Promise<boolean> {
	try {
		const collectionName =
			await getEpisodicMemoryCollection(organizationId);

		await qdrantClient.delete(collectionName, {
			wait: true,
			filter: {
				must: [
					{
						key: "conversationId",
						match: { value: conversationId },
					},
				],
			},
		});

		logger.info(
			`[EpisodicMemory] Deleted episodes for conversation ${conversationId}`,
		);
		return true;
	} catch (error) {
		logger.error(
			`[EpisodicMemory] Failed to delete conversation episodes: ${error}`,
		);
		return false;
	}
}

/**
 * Delete all episodes for a user (GDPR compliance)
 */
export async function deleteUserEpisodes(userId: string): Promise<boolean> {
	try {
		const collectionName = await getEpisodicMemoryCollection(null);

		await qdrantClient.delete(collectionName, {
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

		logger.info(`[EpisodicMemory] Deleted all episodes for user ${userId}`);
		return true;
	} catch (error) {
		logger.error(
			`[EpisodicMemory] Failed to delete user episodes: ${error}`,
		);
		return false;
	}
}

/**
 * Get episode IDs from search results
 * Helper for integrating with PostgreSQL queries
 */
export function getEpisodeIdsFromSearchResults(
	results: EpisodeSearchResult[],
): string[] {
	return results.map((r) => r.id);
}
