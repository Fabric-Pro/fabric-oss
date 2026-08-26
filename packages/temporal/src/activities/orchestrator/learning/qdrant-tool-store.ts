/**
 * Qdrant Tool Learning Store
 *
 * Persistent storage for tool usage patterns using Qdrant vector database.
 * Enables semantic search for similar tool usage contexts and pattern retrieval.
 *
 * This replaces the in-memory store with persistent, searchable storage.
 */

import { logger } from "@repo/logs";
import {
	generateEmbedding,
	ORCHESTRATOR_MEMORY_COLLECTION,
	qdrantClient,
} from "@repo/rag";
import type {
	ArgumentSuggestion,
	SuccessfulCallPattern,
	ToolCallRecord,
	ToolHint,
	ToolLearningQuery,
	ToolLearningResult,
	ToolUsagePattern,
} from "./tool-usage-learning";

// =============================================================================
// Types
// =============================================================================

interface QdrantToolPatternPayload {
	type: "tool_pattern";
	toolId: string;
	toolName: string;
	organizationId?: string;
	userId: string;
	pattern: ToolUsagePattern;
	contextEmbeddingText: string;
	createdAt: string;
	updatedAt: string;
}

interface QdrantToolCallPayload {
	type: "tool_call";
	toolId: string;
	toolName: string;
	organizationId?: string;
	userId: string;
	args: Record<string, unknown>;
	context: string;
	taskDescription?: string;
	success: boolean;
	error?: string;
	durationMs: number;
	timestamp: string;
}

// =============================================================================
// Qdrant Tool Usage Store
// =============================================================================

export class QdrantToolUsageStore {
	private apiKey: string;
	private organizationId?: string;

	constructor(apiKey: string, organizationId?: string) {
		this.apiKey = apiKey;
		this.organizationId = organizationId;
	}

	/**
	 * Record a tool call to Qdrant for learning.
	 */
	async recordCall(record: ToolCallRecord): Promise<void> {
		try {
			if (!qdrantClient) {
				logger.debug(
					"[QdrantToolStore] Qdrant not available, skipping",
				);
				return;
			}

			// Generate embedding for the context
			const embeddingText = `Tool: ${record.toolName}\nContext: ${record.context}\nTask: ${record.taskDescription || ""}`;
			const embeddingResult = await generateEmbedding(
				embeddingText,
				{ userId: record.userId, organizationId: this.organizationId },
				this.apiKey,
			);
			if (!embeddingResult.embedding) {
				logger.warn("[QdrantToolStore] Failed to generate embedding");
				return;
			}
			const embedding = embeddingResult.embedding;

			// Store the tool call
			const payload: QdrantToolCallPayload = {
				type: "tool_call",
				toolId: record.toolId,
				toolName: record.toolName,
				organizationId: this.organizationId,
				userId: record.userId,
				args: record.args,
				context: record.context,
				taskDescription: record.taskDescription,
				success: record.result.success,
				error: record.result.error,
				durationMs: record.result.durationMs,
				timestamp: record.timestamp.toISOString(),
			};

			const pointId = `tool-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

			await qdrantClient.upsert(ORCHESTRATOR_MEMORY_COLLECTION, {
				wait: false,
				points: [
					{
						id: pointId,
						vector: embedding,
						payload: payload as unknown as Record<string, unknown>,
					},
				],
			});

			logger.debug("[QdrantToolStore] Tool call recorded", {
				toolName: record.toolName,
				success: record.result.success,
			});

			// Update aggregated pattern
			await this.updatePattern(record);
		} catch (error) {
			logger.warn("[QdrantToolStore] Failed to record tool call", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	/**
	 * Update or create aggregated pattern for a tool.
	 */
	private async updatePattern(record: ToolCallRecord): Promise<void> {
		try {
			if (!qdrantClient) {
				return;
			}

			// Try to find existing pattern
			const existingPattern = await this.getPattern(record.toolId);

			let pattern: ToolUsagePattern;
			if (existingPattern) {
				pattern = existingPattern;
			} else {
				pattern = {
					toolId: record.toolId,
					toolName: record.toolName,
					successfulCalls: [],
					errorPatterns: [],
					hints: [],
					stats: {
						totalCalls: 0,
						successfulCalls: 0,
						failedCalls: 0,
						avgDurationMs: 0,
						successRate: 0,
						mostCommonErrors: [],
					},
					lastUpdated: new Date(),
				};
			}

			// Update stats
			pattern.stats.totalCalls++;
			if (record.result.success) {
				pattern.stats.successfulCalls++;
				this.updateSuccessfulPattern(pattern, record);
			} else {
				pattern.stats.failedCalls++;
				this.updateErrorPattern(pattern, record);
			}

			// Recalculate averages
			pattern.stats.successRate =
				pattern.stats.successfulCalls / pattern.stats.totalCalls;
			pattern.stats.avgDurationMs =
				(pattern.stats.avgDurationMs * (pattern.stats.totalCalls - 1) +
					record.result.durationMs) /
				pattern.stats.totalCalls;
			pattern.lastUpdated = new Date();

			// Store updated pattern
			const embeddingText = `Tool pattern for ${record.toolName}: ${pattern.successfulCalls
				.slice(0, 5)
				.map((p) => p.contextKeywords.join(" "))
				.join(", ")}`;
			const embeddingResult = await generateEmbedding(
				embeddingText,
				{ userId: record.userId, organizationId: this.organizationId },
				this.apiKey,
			);
			if (!embeddingResult.embedding) {
				return;
			}
			const embedding = embeddingResult.embedding;

			const payload: QdrantToolPatternPayload = {
				type: "tool_pattern",
				toolId: record.toolId,
				toolName: record.toolName,
				organizationId: this.organizationId,
				userId: record.userId,
				pattern,
				contextEmbeddingText: embeddingText,
				createdAt: existingPattern
					? pattern.lastUpdated.toISOString()
					: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			// Use deterministic ID for pattern to enable updates
			const patternId = `tool-pattern-${record.toolId}-${this.organizationId || "global"}`;

			await qdrantClient.upsert(ORCHESTRATOR_MEMORY_COLLECTION, {
				wait: true,
				points: [
					{
						id: patternId,
						vector: embedding,
						payload: payload as unknown as Record<string, unknown>,
					},
				],
			});
		} catch (error) {
			logger.warn("[QdrantToolStore] Failed to update pattern", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	private updateSuccessfulPattern(
		pattern: ToolUsagePattern,
		record: ToolCallRecord,
	): void {
		const argsSignature = this.computeArgsSignature(record.args);
		const contextKeywords = this.extractContextKeywords(record.context);

		const existing = pattern.successfulCalls.find(
			(p) => p.argsSignature === argsSignature,
		);

		if (existing) {
			existing.frequency++;
			existing.avgDurationMs =
				(existing.avgDurationMs * (existing.frequency - 1) +
					record.result.durationMs) /
				existing.frequency;
			existing.lastUsed = new Date();
			for (const kw of contextKeywords) {
				if (!existing.contextKeywords.includes(kw)) {
					existing.contextKeywords.push(kw);
				}
			}
		} else {
			pattern.successfulCalls.push({
				argsSignature,
				argKeys: Object.keys(record.args),
				contextKeywords,
				frequency: 1,
				avgDurationMs: record.result.durationMs,
				lastUsed: new Date(),
			});
		}

		// Keep only top patterns
		pattern.successfulCalls.sort((a, b) => b.frequency - a.frequency);
		if (pattern.successfulCalls.length > 50) {
			pattern.successfulCalls = pattern.successfulCalls.slice(0, 50);
		}
	}

	private updateErrorPattern(
		pattern: ToolUsagePattern,
		record: ToolCallRecord,
	): void {
		const errorType = this.classifyError(record.result.error || "");
		const argsSignature = this.computeArgsSignature(record.args);

		const existing = pattern.errorPatterns.find(
			(p) =>
				p.errorType === errorType && p.argsSignature === argsSignature,
		);

		if (existing) {
			existing.frequency++;
			existing.lastOccurred = new Date();
		} else {
			pattern.errorPatterns.push({
				errorType,
				errorMessage: record.result.error || "Unknown error",
				argsSignature,
				frequency: 1,
				lastOccurred: new Date(),
			});
		}

		// Update most common errors
		const errorCounts = new Map<string, number>();
		for (const ep of pattern.errorPatterns) {
			errorCounts.set(
				ep.errorType,
				(errorCounts.get(ep.errorType) || 0) + ep.frequency,
			);
		}
		pattern.stats.mostCommonErrors = Array.from(errorCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([type]) => type);
	}

	/**
	 * Get pattern for a specific tool.
	 */
	async getPattern(toolId: string): Promise<ToolUsagePattern | null> {
		try {
			if (!qdrantClient) {
				return null;
			}

			const patternId = `tool-pattern-${toolId}-${this.organizationId || "global"}`;

			const result = await qdrantClient.retrieve(
				ORCHESTRATOR_MEMORY_COLLECTION,
				{
					ids: [patternId],
					with_payload: true,
				},
			);

			if (result.length > 0 && result[0].payload) {
				const payload = result[0]
					.payload as unknown as QdrantToolPatternPayload;
				if (payload.type === "tool_pattern") {
					return payload.pattern;
				}
			}

			return null;
		} catch (error) {
			logger.warn("[QdrantToolStore] Failed to get pattern", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
			return null;
		}
	}

	/**
	 * Query learnings for a tool with semantic search.
	 */
	async queryLearnings(
		query: ToolLearningQuery,
	): Promise<ToolLearningResult> {
		try {
			if (!qdrantClient) {
				return this.emptyResult();
			}

			// Get the tool's pattern
			const pattern = await this.getPattern(query.toolId);

			// Also do semantic search for similar contexts
			const embeddingResult = await generateEmbedding(
				`Tool: ${query.toolId}\nContext: ${query.taskContext}`,
				undefined,
				this.apiKey,
			);

			let similarCalls: QdrantToolCallPayload[] = [];
			if (embeddingResult.embedding) {
				const searchResult = await qdrantClient.search(
					ORCHESTRATOR_MEMORY_COLLECTION,
					{
						vector: embeddingResult.embedding,
						limit: 10,
						filter: {
							must: [
								{ key: "type", match: { value: "tool_call" } },
								{
									key: "toolId",
									match: { value: query.toolId },
								},
								{ key: "success", match: { value: true } },
							],
						},
						with_payload: true,
					},
				);

				similarCalls = searchResult
					.filter((r) => r.score > 0.7 && r.payload)
					.map((r) => r.payload as unknown as QdrantToolCallPayload);
			}

			if (!pattern && similarCalls.length === 0) {
				return this.emptyResult();
			}

			const hints = pattern
				? this.findRelevantHints(pattern, query.taskContext)
				: [];
			const argumentSuggestions = this.suggestArgumentsFromSimilar(
				similarCalls,
				query.partialArgs,
			);
			const warnings = pattern
				? this.generateWarnings(pattern, query.partialArgs)
				: [];
			const relatedPatterns = pattern
				? this.findRelatedPatterns(pattern, query.taskContext)
				: [];

			return {
				hints,
				argumentSuggestions,
				warnings,
				relatedPatterns,
				estimatedSuccessRate: pattern?.stats.successRate ?? 0.5,
			};
		} catch (error) {
			logger.warn("[QdrantToolStore] Failed to query learnings", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
			return this.emptyResult();
		}
	}

	/**
	 * Search for similar tool usage contexts.
	 */
	async searchSimilarContexts(
		context: string,
		toolId?: string,
		limit = 5,
	): Promise<
		Array<{
			context: string;
			args: Record<string, unknown>;
			success: boolean;
		}>
	> {
		try {
			if (!qdrantClient) {
				return [];
			}

			const embeddingResult = await generateEmbedding(
				context,
				undefined,
				this.apiKey,
			);
			if (!embeddingResult.embedding) {
				return [];
			}

			const filter: {
				must: Array<{ key: string; match: { value: string } }>;
			} = {
				must: [{ key: "type", match: { value: "tool_call" } }],
			};

			if (toolId) {
				filter.must.push({ key: "toolId", match: { value: toolId } });
			}

			const results = await qdrantClient.search(
				ORCHESTRATOR_MEMORY_COLLECTION,
				{
					vector: embeddingResult.embedding,
					limit,
					filter,
					with_payload: true,
				},
			);

			return results
				.filter((r) => r.score > 0.6 && r.payload)
				.map((r) => {
					const payload =
						r.payload as unknown as QdrantToolCallPayload;
					return {
						context: payload.context,
						args: payload.args,
						success: payload.success,
					};
				});
		} catch (error) {
			logger.warn("[QdrantToolStore] Failed to search similar contexts", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
			return [];
		}
	}

	// Helper methods
	private emptyResult(): ToolLearningResult {
		return {
			hints: [],
			argumentSuggestions: [],
			warnings: [],
			relatedPatterns: [],
			estimatedSuccessRate: 0.5,
		};
	}

	private computeArgsSignature(args: Record<string, unknown>): string {
		const keys = Object.keys(args).sort();
		return keys
			.map((k) => {
				const v = args[k];
				const type = Array.isArray(v) ? "array" : typeof v;
				return `${k}:${type}`;
			})
			.join(",");
	}

	private extractContextKeywords(context: string): string[] {
		const words = context
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 3);

		const stopWords = new Set([
			"the",
			"and",
			"for",
			"that",
			"this",
			"with",
			"from",
			"have",
			"will",
			"would",
			"could",
			"should",
			"been",
			"being",
			"into",
			"about",
		]);

		return [...new Set(words.filter((w) => !stopWords.has(w)))].slice(
			0,
			20,
		);
	}

	private classifyError(error: string): string {
		const lowerError = error.toLowerCase();
		if (lowerError.includes("timeout")) {
			return "timeout";
		}
		if (lowerError.includes("rate limit")) {
			return "rate_limit";
		}
		if (
			lowerError.includes("permission") ||
			lowerError.includes("forbidden")
		) {
			return "permission_denied";
		}
		if (lowerError.includes("not found") || lowerError.includes("404")) {
			return "not_found";
		}
		if (
			lowerError.includes("invalid") ||
			lowerError.includes("validation")
		) {
			return "validation_error";
		}
		if (
			lowerError.includes("connection") ||
			lowerError.includes("network")
		) {
			return "network_error";
		}
		return "unknown";
	}

	private findRelevantHints(
		pattern: ToolUsagePattern,
		context: string,
	): ToolHint[] {
		const contextKeywords = this.extractContextKeywords(context);
		return pattern.hints
			.filter((hint) => {
				const conditionKeywords = this.extractContextKeywords(
					hint.condition,
				);
				return conditionKeywords.some((kw) =>
					contextKeywords.includes(kw),
				);
			})
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, 5);
	}

	private suggestArgumentsFromSimilar(
		similarCalls: QdrantToolCallPayload[],
		partialArgs?: Record<string, unknown>,
	): ArgumentSuggestion[] {
		const suggestions: ArgumentSuggestion[] = [];
		const argCounts = new Map<string, Map<string, number>>();

		// Count argument values from similar successful calls
		for (const call of similarCalls) {
			for (const [key, value] of Object.entries(call.args)) {
				if (partialArgs && key in partialArgs) {
					continue;
				}

				if (!argCounts.has(key)) {
					argCounts.set(key, new Map());
				}
				const valueStr = JSON.stringify(value);
				// biome-ignore lint/style/noNonNullAssertion: counts map is populated for all keys in argCounts
				const counts = argCounts.get(key)!;
				counts.set(valueStr, (counts.get(valueStr) || 0) + 1);
			}
		}

		// Create suggestions from most common values
		for (const [argName, valueCounts] of argCounts) {
			const topValue = Array.from(valueCounts.entries()).sort(
				(a, b) => b[1] - a[1],
			)[0];

			if (topValue && topValue[1] >= 2) {
				try {
					suggestions.push({
						argName,
						suggestedValue: JSON.parse(topValue[0]),
						confidence: Math.min(
							topValue[1] / similarCalls.length,
							1,
						),
						reason: `Used in ${topValue[1]} similar successful calls`,
						source: "pattern",
					});
				} catch {
					// Skip invalid JSON
				}
			}
		}

		return suggestions
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, 5);
	}

	private generateWarnings(
		pattern: ToolUsagePattern,
		_partialArgs?: Record<string, unknown>,
	): string[] {
		const warnings: string[] = [];

		// Warn about common errors
		if (pattern.stats.successRate < 0.5) {
			warnings.push(
				`This tool has a low success rate (${(pattern.stats.successRate * 100).toFixed(0)}%). Consider alternatives.`,
			);
		}

		// Warn about specific error patterns
		for (const errorPattern of pattern.errorPatterns.slice(0, 3)) {
			if (errorPattern.frequency >= 3) {
				warnings.push(
					`Common error: ${errorPattern.errorType} - ${errorPattern.errorMessage.slice(0, 100)}`,
				);
			}
		}

		return warnings;
	}

	private findRelatedPatterns(
		pattern: ToolUsagePattern,
		context: string,
	): SuccessfulCallPattern[] {
		const contextKeywords = this.extractContextKeywords(context);

		return pattern.successfulCalls
			.filter((p) =>
				p.contextKeywords.some((kw) => contextKeywords.includes(kw)),
			)
			.sort((a, b) => b.frequency - a.frequency)
			.slice(0, 5);
	}
}

// =============================================================================
// Activity Functions
// =============================================================================

/**
 * Record tool usage to persistent storage.
 */
export async function recordToolUsageActivity(
	record: ToolCallRecord & { apiKey: string },
): Promise<void> {
	const store = new QdrantToolUsageStore(
		record.apiKey,
		record.organizationId,
	);
	await store.recordCall(record);
}

/**
 * Query tool learnings from persistent storage.
 */
export async function queryToolLearningsActivity(
	query: ToolLearningQuery & { apiKey: string; organizationId?: string },
): Promise<ToolLearningResult> {
	const store = new QdrantToolUsageStore(query.apiKey, query.organizationId);
	return store.queryLearnings(query);
}

/**
 * Get tool pattern from persistent storage.
 */
export async function getToolPatternActivity(input: {
	toolId: string;
	apiKey: string;
	organizationId?: string;
}): Promise<ToolUsagePattern | null> {
	const store = new QdrantToolUsageStore(input.apiKey, input.organizationId);
	return store.getPattern(input.toolId);
}

/**
 * Search for similar tool usage contexts.
 */
export async function searchSimilarToolContextsActivity(input: {
	context: string;
	toolId?: string;
	apiKey: string;
	organizationId?: string;
	limit?: number;
}): Promise<
	Array<{ context: string; args: Record<string, unknown>; success: boolean }>
> {
	const store = new QdrantToolUsageStore(input.apiKey, input.organizationId);
	return store.searchSimilarContexts(
		input.context,
		input.toolId,
		input.limit,
	);
}
