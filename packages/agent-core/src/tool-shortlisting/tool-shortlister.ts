/**
 * Tool Shortlister
 *
 * Intelligent tool ranking and filtering based on task relevance.
 * Uses keyword matching, description similarity, and category matching.
 */

import type {
	CacheEntry,
	RankedTool,
	ShortlistConfig,
	ShortlistResult,
	TaskContext,
	ToolInfo,
} from "./types";
import { DEFAULT_SHORTLIST_CONFIG } from "./types";

/**
 * Tool Shortlister class
 */
export class ToolShortlister {
	private config: ShortlistConfig;
	private cache: Map<string, CacheEntry> = new Map();
	private tools: ToolInfo[] = [];

	constructor(config: Partial<ShortlistConfig> = {}) {
		this.config = { ...DEFAULT_SHORTLIST_CONFIG, ...config };
	}

	/**
	 * Register tools for shortlisting
	 */
	registerTools(tools: ToolInfo[]): void {
		this.tools = tools;
		// Clear cache when tools change
		this.cache.clear();
	}

	/**
	 * Add a single tool
	 */
	addTool(tool: ToolInfo): void {
		this.tools.push(tool);
		this.cache.clear();
	}

	/**
	 * Get shortlisted tools for a task
	 */
	shortlist(context: TaskContext): ShortlistResult {
		const startTime = Date.now();
		const taskHash = this.hashTask(context);

		// Check cache
		if (this.config.enableCache) {
			const cached = this.cache.get(taskHash);
			if (
				cached &&
				Date.now() - cached.timestamp < this.config.cacheTTL
			) {
				return {
					...cached.result,
					cacheHit: true,
					executionTime: Date.now() - startTime,
				};
			}
		}

		// Rank all tools
		const rankedTools = this.tools
			.map((tool) => this.rankTool(tool, context))
			.filter((ranked) => ranked.score >= this.config.minScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, this.config.maxTools);

		const result: ShortlistResult = {
			tools: rankedTools,
			totalToolsConsidered: this.tools.length,
			executionTime: Date.now() - startTime,
			cacheHit: false,
		};

		// Cache result
		if (this.config.enableCache) {
			this.cache.set(taskHash, {
				result,
				timestamp: Date.now(),
				taskHash,
			});
		}

		return result;
	}

	/**
	 * Rank a single tool against the task context
	 */
	private rankTool(tool: ToolInfo, context: TaskContext): RankedTool {
		const taskTokens = this.tokenize(context.task);
		const matchedKeywords: string[] = [];
		let keywordScore = 0;
		let descriptionScore = 0;
		let categoryScore = 0;

		// Keyword matching
		const toolKeywords = tool.keywords || [];
		for (const keyword of toolKeywords) {
			const keywordLower = keyword.toLowerCase();
			if (
				taskTokens.some(
					(token) =>
						token.includes(keywordLower) ||
						keywordLower.includes(token),
				)
			) {
				matchedKeywords.push(keyword);
				keywordScore += 1;
			}
		}
		if (toolKeywords.length > 0) {
			keywordScore = keywordScore / toolKeywords.length;
		}

		// Description matching
		const descTokens = this.tokenize(tool.description);
		const descMatches = taskTokens.filter((token) =>
			descTokens.some(
				(desc) => desc.includes(token) || token.includes(desc),
			),
		);
		descriptionScore = descMatches.length / Math.max(taskTokens.length, 1);

		// Category matching
		if (context.category && tool.category) {
			categoryScore =
				tool.category.toLowerCase() === context.category.toLowerCase()
					? 1
					: 0;
		}

		// Calculate weighted score
		const score =
			keywordScore * this.config.keywordWeight +
			descriptionScore * this.config.descriptionWeight +
			categoryScore * this.config.categoryWeight;

		// Generate match reason
		const reasons: string[] = [];
		if (matchedKeywords.length > 0) {
			reasons.push(`Keywords: ${matchedKeywords.join(", ")}`);
		}
		if (descriptionScore > 0) {
			reasons.push(
				`Description match: ${Math.round(descriptionScore * 100)}%`,
			);
		}
		if (categoryScore > 0) {
			reasons.push(`Category match: ${tool.category}`);
		}

		return {
			tool,
			score: Math.min(score, 1), // Cap at 1
			matchedKeywords,
			matchReason: reasons.join("; ") || "Low relevance",
		};
	}

	/**
	 * Tokenize text into lowercase words
	 */
	private tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((token) => token.length > 2);
	}

	/**
	 * Create hash for task context (for caching)
	 */
	private hashTask(context: TaskContext): string {
		return `${context.task}|${context.category || ""}|${context.previousTools?.join(",") || ""}`;
	}

	/**
	 * Clear the cache
	 */
	clearCache(): void {
		this.cache.clear();
	}

	/**
	 * Get cache statistics
	 */
	getCacheStats(): { size: number; entries: string[] } {
		return {
			size: this.cache.size,
			entries: Array.from(this.cache.keys()),
		};
	}
}
