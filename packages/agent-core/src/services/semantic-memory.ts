/**
 * Semantic Memory Service
 *
 * Provides semantic search over past workflow executions using Qdrant embeddings.
 * This enables AI agents to learn from past task executions and apply successful patterns.
 *
 * The semantic memory stores:
 * - Task descriptions (for similarity matching)
 * - Execution outcomes (success/failure/partial)
 * - Tool and agent usage patterns
 * - Summarized insights from each execution
 *
 * @see @repo/rag for embedding generation and Qdrant operations
 */

import { AI_CALL_PURPOSES } from "@repo/ai/lib/call-purpose";
import { runWithAiCallPurpose } from "@repo/ai/lib/call-purpose-context";
import {
	type ExecutionSummary,
	generateEmbedding,
	searchSimilarExecutions,
} from "@repo/rag";

// ============================================================================
// Types
// ============================================================================

export interface SemanticSearchOptions {
	userId: string;
	organizationId?: string;
	/** Maximum number of results (default: 5) */
	topK?: number;
	/** Minimum similarity threshold 0-1 (default: 0.5) */
	minSimilarity?: number;
	/** Filter by outcome */
	outcomeFilter?: "success" | "partial" | "failure";
}

export interface SemanticMemoryResult {
	execution: ExecutionSummary;
	similarity: number;
}

export interface MemoryContext {
	/**
	 * The recalled executions, one dated entry each. Data only: the caller
	 * renders the instructions around it from the Prompt Library
	 * (`direct_chat_memory_context`).
	 */
	formattedMemories: string;
	/** Number of relevant memories found */
	memoryCount: number;
	/** Whether any high-similarity matches were found */
	hasHighSimilarityMatches: boolean;
}

// ============================================================================
// Semantic Search
// ============================================================================

/**
 * Search for semantically similar past executions.
 * Can be called from both Temporal activities and API routes.
 *
 * SECURITY: Credentials are fetched internally by generateEmbedding() using
 * getAIEmbeddingModelWithMetadata().
 */
export async function searchSemanticMemory(
	query: string,
	options: SemanticSearchOptions,
): Promise<SemanticMemoryResult[]> {
	const {
		userId,
		organizationId,
		topK = 5,
		minSimilarity = 0.5,
		outcomeFilter,
	} = options;

	try {
		// Generate embedding for query
		const embeddingResult = await runWithAiCallPurpose(
			AI_CALL_PURPOSES.executionSearchEmbedding,
			() =>
				generateEmbedding(query, {
					userId,
					organizationId,
					featureKey: "chat-agent",
					tags: ["semantic-search"],
				}),
		);

		// Search Qdrant
		const results = await searchSimilarExecutions({
			queryEmbedding: embeddingResult.embedding,
			userId,
			organizationId,
			topK,
			minSimilarity,
			outcomeFilter,
		});

		return results.map((r) => ({
			execution: r.execution,
			similarity: r.similarity,
		}));
	} catch (error) {
		console.error(`[SemanticMemory] Search failed: ${error}`);
		return [];
	}
}

/**
 * Recall the past executions most similar to `query`, formatted as dated
 * entries for a prompt. The instructions that frame them are the caller's.
 */
export async function generateMemoryContext(
	query: string,
	options: SemanticSearchOptions,
): Promise<MemoryContext> {
	const memories = await searchSemanticMemory(query, {
		...options,
		topK: options.topK ?? 3, // Default to 3 for context injection
		minSimilarity: options.minSimilarity ?? 0.6, // Higher threshold for context
	});

	if (memories.length === 0) {
		return {
			formattedMemories: "",
			memoryCount: 0,
			hasHighSimilarityMatches: false,
		};
	}

	const hasHighSimilarityMatches = memories.some((m) => m.similarity >= 0.8);

	const formattedMemories = memories
		.map((m, i) => {
			const similarity = Math.round(m.similarity * 100);
			const outcome = m.execution.outcome;
			const date = m.execution.timestamp?.slice(0, 10) || "undated";
			return `[Memory ${i + 1}] (${date}, ${similarity}% similar, ${outcome})
Task: ${m.execution.taskDescription}
Summary: ${m.execution.summary}
Tools: ${m.execution.toolsUsed.join(", ") || "none"}
Agents: ${m.execution.agentsUsed.join(", ") || "none"}`;
		})
		.join("\n\n");

	return {
		formattedMemories,
		memoryCount: memories.length,
		hasHighSimilarityMatches,
	};
}
