/**
 * Types for Tool Shortlisting
 */

/**
 * Tool definition for shortlisting
 */
export interface ToolInfo {
	name: string;
	description: string;
	category?: string;
	keywords?: string[];
	parameters?: Record<string, unknown>;
}

/**
 * Ranked tool with relevance score
 */
export interface RankedTool {
	tool: ToolInfo;
	score: number;
	matchedKeywords: string[];
	matchReason: string;
}

/**
 * Shortlisting configuration
 */
export interface ShortlistConfig {
	/** Maximum number of tools to return */
	maxTools: number;
	/** Minimum relevance score (0-1) */
	minScore: number;
	/** Weight for keyword matching (0-1) */
	keywordWeight: number;
	/** Weight for description matching (0-1) */
	descriptionWeight: number;
	/** Weight for category matching (0-1) */
	categoryWeight: number;
	/** Enable caching of results */
	enableCache: boolean;
	/** Cache TTL in milliseconds */
	cacheTTL: number;
}

/**
 * Default shortlisting configuration
 */
export const DEFAULT_SHORTLIST_CONFIG: ShortlistConfig = {
	maxTools: 10,
	minScore: 0.1,
	keywordWeight: 0.4,
	descriptionWeight: 0.4,
	categoryWeight: 0.2,
	enableCache: true,
	cacheTTL: 5 * 60 * 1000, // 5 minutes
};

/**
 * Task context for shortlisting
 */
export interface TaskContext {
	task: string;
	category?: string;
	previousTools?: string[];
	userPreferences?: string[];
}

/**
 * Shortlisting result
 */
export interface ShortlistResult {
	tools: RankedTool[];
	totalToolsConsidered: number;
	executionTime: number;
	cacheHit: boolean;
}

/**
 * Cache entry
 */
export interface CacheEntry {
	result: ShortlistResult;
	timestamp: number;
	taskHash: string;
}
