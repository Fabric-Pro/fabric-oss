/**
 * Memory Types
 *
 * Defines semantic memory types for Qdrant integration.
 * Used for execution history, similarity matching, and learning.
 */

// =============================================================================
// Execution Memory Summary
// =============================================================================

/**
 * Execution summary for semantic memory storage in Qdrant.
 * This is a lightweight representation optimized for vector search.
 */
export interface ExecutionMemorySummary {
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

// =============================================================================
// Semantic Memory Result
// =============================================================================

/**
 * Semantic search result from Qdrant
 */
export interface SemanticMemoryResult {
	/** Execution summary */
	execution: ExecutionMemorySummary;
	/** Similarity score (0-1) */
	similarity: number;
}

// =============================================================================
// Failure Warning
// =============================================================================

/**
 * Failure warning from negative memory
 */
export interface FailureWarning {
	/** Summary of what failed */
	message: string;
	/** The task that failed */
	failedTask: string;
	/** Error summary from the failure */
	errorSummary?: string;
	/** How similar this failure is to current task (0-1) */
	similarity: number;
	/** When the failure occurred */
	timestamp: string;
	/** Execution ID for reference */
	executionId: string;
}

// =============================================================================
// Hybrid Routing
// =============================================================================

/**
 * Combined routing suggestion from Letta + Qdrant
 */
export interface HybridRoutingSuggestion {
	/** Suggested agents to use */
	agents: string[];
	/** Suggested tools to use */
	tools: string[];
	/** Confidence score (0-100) */
	confidence: number;
	/** Source of suggestion */
	source: "letta" | "qdrant" | "hybrid";
	/** Original task pattern that matched */
	pattern?: string;
	/** Execution ID if from semantic memory */
	executionId?: string;
}

/**
 * Enhanced routing result with suggestions and warnings
 */
export interface HybridRoutingResult {
	/** Positive suggestions from successful executions */
	suggestions: HybridRoutingSuggestion[];
	/** Warnings from similar failed executions (negative memory) */
	warnings: FailureWarning[];
	/** Summary statistics */
	stats: {
		lettaMatches: number;
		semanticMatches: number;
		failureMatches: number;
	};
}
