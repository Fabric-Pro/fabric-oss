/**
 * Tool Usage Learning
 *
 * Phase 5.1: Learn from tool usage patterns to improve future calls.
 * Tracks successful and failed tool invocations, extracts patterns,
 * and generates hints for future planning.
 */

import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export interface ToolCallRecord {
	toolId: string;
	toolName: string;
	args: Record<string, unknown>;
	context: string;
	taskDescription?: string;
	result: {
		success: boolean;
		output?: unknown;
		error?: string;
		durationMs: number;
	};
	timestamp: Date;
	userId: string;
	organizationId?: string;
}

export interface ToolUsagePattern {
	toolId: string;
	toolName: string;
	successfulCalls: SuccessfulCallPattern[];
	errorPatterns: ErrorPattern[];
	hints: ToolHint[];
	stats: ToolUsageStats;
	lastUpdated: Date;
}

export interface SuccessfulCallPattern {
	argsSignature: string;
	argKeys: string[];
	contextKeywords: string[];
	frequency: number;
	avgDurationMs: number;
	lastUsed: Date;
}

export interface ErrorPattern {
	errorType: string;
	errorMessage: string;
	argsSignature: string;
	solution?: string;
	frequency: number;
	lastOccurred: Date;
}

export interface ToolHint {
	id: string;
	condition: string;
	suggestion: string;
	confidence: number;
	source: "learned" | "manual" | "inferred";
	usageCount: number;
	successRate: number;
	createdAt: Date;
}

export interface ToolUsageStats {
	totalCalls: number;
	successfulCalls: number;
	failedCalls: number;
	avgDurationMs: number;
	successRate: number;
	mostCommonErrors: string[];
	peakUsageHour?: number;
}

export interface ArgumentSuggestion {
	argName: string;
	suggestedValue: unknown;
	confidence: number;
	reason: string;
	source: "pattern" | "context" | "default";
}

export interface ToolLearningQuery {
	toolId: string;
	taskContext: string;
	partialArgs?: Record<string, unknown>;
}

export interface ToolLearningResult {
	hints: ToolHint[];
	argumentSuggestions: ArgumentSuggestion[];
	warnings: string[];
	relatedPatterns: SuccessfulCallPattern[];
	estimatedSuccessRate: number;
}

// =============================================================================
// In-Memory Tool Usage Store
// =============================================================================

export class InMemoryToolUsageStore {
	private patterns: Map<string, ToolUsagePattern> = new Map();
	private callHistory: ToolCallRecord[] = [];
	private maxHistorySize = 10000;

	async recordCall(record: ToolCallRecord): Promise<void> {
		this.callHistory.push(record);
		if (this.callHistory.length > this.maxHistorySize) {
			this.callHistory = this.callHistory.slice(-this.maxHistorySize);
		}

		await this.updatePattern(record);
	}

	private async updatePattern(record: ToolCallRecord): Promise<void> {
		let pattern = this.patterns.get(record.toolId);
		if (!pattern) {
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
			await this.updateSuccessfulPattern(pattern, record);
		} else {
			pattern.stats.failedCalls++;
			await this.updateErrorPattern(pattern, record);
		}

		// Recalculate averages
		pattern.stats.successRate =
			pattern.stats.successfulCalls / pattern.stats.totalCalls;
		pattern.stats.avgDurationMs =
			(pattern.stats.avgDurationMs * (pattern.stats.totalCalls - 1) +
				record.result.durationMs) /
			pattern.stats.totalCalls;

		pattern.lastUpdated = new Date();
		this.patterns.set(record.toolId, pattern);
	}

	private async updateSuccessfulPattern(
		pattern: ToolUsagePattern,
		record: ToolCallRecord,
	): Promise<void> {
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
			// Merge context keywords
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
		if (pattern.successfulCalls.length > 100) {
			pattern.successfulCalls = pattern.successfulCalls.slice(0, 100);
		}
	}

	private async updateErrorPattern(
		pattern: ToolUsagePattern,
		record: ToolCallRecord,
	): Promise<void> {
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

	private computeArgsSignature(args: Record<string, unknown>): string {
		const keys = Object.keys(args).sort();
		const normalized = keys.map((k) => {
			const v = args[k];
			const type = Array.isArray(v) ? "array" : typeof v;
			return `${k}:${type}`;
		});
		return normalized.join(",");
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
			lowerError.includes("validation") ||
			lowerError.includes("required")
		) {
			return "validation_error";
		}
		if (
			lowerError.includes("connection") ||
			lowerError.includes("network")
		) {
			return "network_error";
		}
		if (
			lowerError.includes("authentication") ||
			lowerError.includes("401")
		) {
			return "auth_error";
		}

		return "unknown";
	}

	async getPattern(toolId: string): Promise<ToolUsagePattern | null> {
		return this.patterns.get(toolId) || null;
	}

	async queryLearnings(
		query: ToolLearningQuery,
	): Promise<ToolLearningResult> {
		const pattern = this.patterns.get(query.toolId);

		if (!pattern) {
			return {
				hints: [],
				argumentSuggestions: [],
				warnings: [],
				relatedPatterns: [],
				estimatedSuccessRate: 0.5, // Unknown tool
			};
		}

		const hints = this.findRelevantHints(pattern, query.taskContext);
		const argumentSuggestions = this.suggestArguments(
			pattern,
			query.taskContext,
			query.partialArgs,
		);
		const warnings = this.generateWarnings(pattern, query.partialArgs);
		const relatedPatterns = this.findRelatedPatterns(
			pattern,
			query.taskContext,
		);

		return {
			hints,
			argumentSuggestions,
			warnings,
			relatedPatterns,
			estimatedSuccessRate: pattern.stats.successRate,
		};
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

	private suggestArguments(
		pattern: ToolUsagePattern,
		context: string,
		partialArgs?: Record<string, unknown>,
	): ArgumentSuggestion[] {
		const suggestions: ArgumentSuggestion[] = [];
		const contextKeywords = this.extractContextKeywords(context);

		// Find patterns with matching context
		const matchingPatterns = pattern.successfulCalls.filter((p) =>
			p.contextKeywords.some((kw) => contextKeywords.includes(kw)),
		);

		if (matchingPatterns.length === 0) {
			return suggestions;
		}

		// Analyze common argument patterns
		const argFrequency = new Map<string, number>();
		for (const p of matchingPatterns) {
			for (const key of p.argKeys) {
				argFrequency.set(
					key,
					(argFrequency.get(key) || 0) + p.frequency,
				);
			}
		}

		// Suggest missing required args
		const providedArgs = new Set(Object.keys(partialArgs || {}));
		for (const [arg, freq] of argFrequency.entries()) {
			if (
				!providedArgs.has(arg) &&
				freq > matchingPatterns.length * 0.5
			) {
				suggestions.push({
					argName: arg,
					suggestedValue: undefined, // Value inference would require more context
					confidence: freq / matchingPatterns.length,
					reason: `Commonly used in similar contexts (${Math.round((freq / matchingPatterns.length) * 100)}% of cases)`,
					source: "pattern",
				});
			}
		}

		return suggestions.slice(0, 5);
	}

	private generateWarnings(
		pattern: ToolUsagePattern,
		partialArgs?: Record<string, unknown>,
	): string[] {
		const warnings: string[] = [];

		// Low success rate warning
		if (pattern.stats.successRate < 0.7) {
			warnings.push(
				`This tool has a ${Math.round(pattern.stats.successRate * 100)}% success rate. Common errors: ${pattern.stats.mostCommonErrors.slice(0, 3).join(", ")}`,
			);
		}

		// Check for known problematic arg combinations
		if (partialArgs) {
			const argsSignature = this.computeArgsSignature(partialArgs);
			const matchingErrors = pattern.errorPatterns.filter(
				(ep) =>
					ep.argsSignature === argsSignature ||
					argsSignature.includes(ep.argsSignature),
			);

			if (matchingErrors.length > 0) {
				const mostCommon = matchingErrors.sort(
					(a, b) => b.frequency - a.frequency,
				)[0];
				warnings.push(
					`Similar arguments have caused "${mostCommon.errorType}" errors ${mostCommon.frequency} times${mostCommon.solution ? `. Suggestion: ${mostCommon.solution}` : ""}`,
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
			.map((p) => ({
				pattern: p,
				score: p.contextKeywords.filter((kw) =>
					contextKeywords.includes(kw),
				).length,
			}))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((x) => x.pattern)
			.slice(0, 5);
	}

	async generateHints(toolId: string): Promise<ToolHint[]> {
		const pattern = this.patterns.get(toolId);
		if (!pattern || pattern.successfulCalls.length < 10) {
			return []; // Not enough data
		}

		const hints: ToolHint[] = [];

		// Generate hints from successful patterns
		for (const sp of pattern.successfulCalls.slice(0, 10)) {
			if (sp.frequency >= 5 && sp.contextKeywords.length > 0) {
				hints.push({
					id: `${toolId}-${sp.argsSignature.slice(0, 20)}`,
					condition: `When the task involves: ${sp.contextKeywords.slice(0, 3).join(", ")}`,
					suggestion: `Use arguments: ${sp.argKeys.join(", ")}`,
					confidence: Math.min(0.9, sp.frequency / 20),
					source: "learned",
					usageCount: sp.frequency,
					successRate: pattern.stats.successRate,
					createdAt: new Date(),
				});
			}
		}

		// Generate hints from error patterns
		for (const ep of pattern.errorPatterns.slice(0, 5)) {
			if (ep.frequency >= 3 && ep.solution) {
				hints.push({
					id: `${toolId}-error-${ep.errorType}`,
					condition: `To avoid ${ep.errorType} errors`,
					suggestion: ep.solution,
					confidence: 0.8,
					source: "learned",
					usageCount: ep.frequency,
					successRate: 1 - ep.frequency / pattern.stats.totalCalls,
					createdAt: new Date(),
				});
			}
		}

		// Update pattern with generated hints
		pattern.hints = hints;
		this.patterns.set(toolId, pattern);

		return hints;
	}

	async addErrorSolution(
		toolId: string,
		errorType: string,
		solution: string,
	): Promise<void> {
		const pattern = this.patterns.get(toolId);
		if (!pattern) {
			return;
		}

		for (const ep of pattern.errorPatterns) {
			if (ep.errorType === errorType) {
				ep.solution = solution;
			}
		}
		this.patterns.set(toolId, pattern);
	}

	async getCallHistory(
		toolId: string,
		limit = 100,
	): Promise<ToolCallRecord[]> {
		return this.callHistory
			.filter((r) => r.toolId === toolId)
			.slice(-limit);
	}

	async getAllPatterns(): Promise<ToolUsagePattern[]> {
		return Array.from(this.patterns.values());
	}

	getStats(): {
		totalTools: number;
		totalCalls: number;
		avgSuccessRate: number;
	} {
		const patterns = Array.from(this.patterns.values());
		const totalCalls = patterns.reduce(
			(sum, p) => sum + p.stats.totalCalls,
			0,
		);
		const avgSuccessRate =
			patterns.length > 0
				? patterns.reduce((sum, p) => sum + p.stats.successRate, 0) /
					patterns.length
				: 0;

		return {
			totalTools: patterns.length,
			totalCalls,
			avgSuccessRate,
		};
	}
}

// =============================================================================
// Tool Usage Tracker
// =============================================================================

export class ToolUsageTracker {
	private store: InMemoryToolUsageStore;

	constructor(store?: InMemoryToolUsageStore) {
		this.store = store || new InMemoryToolUsageStore();
	}

	async trackToolCall(
		toolId: string,
		toolName: string,
		args: Record<string, unknown>,
		context: string,
		result: { success: boolean; output?: unknown; error?: string },
		durationMs: number,
		userId: string,
		organizationId?: string,
	): Promise<void> {
		const record: ToolCallRecord = {
			toolId,
			toolName,
			args,
			context,
			result: {
				...result,
				durationMs,
			},
			timestamp: new Date(),
			userId,
			organizationId,
		};

		await this.store.recordCall(record);

		logger.debug("[ToolUsageTracker] Recorded tool call", {
			toolId,
			success: result.success,
			durationMs,
		});
	}

	async getLearnings(query: ToolLearningQuery): Promise<ToolLearningResult> {
		return this.store.queryLearnings(query);
	}

	async getToolPattern(toolId: string): Promise<ToolUsagePattern | null> {
		return this.store.getPattern(toolId);
	}

	async refreshHints(toolId: string): Promise<ToolHint[]> {
		return this.store.generateHints(toolId);
	}

	async recordSolution(
		toolId: string,
		errorType: string,
		solution: string,
	): Promise<void> {
		await this.store.addErrorSolution(toolId, errorType, solution);
	}

	getStore(): InMemoryToolUsageStore {
		return this.store;
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

export function createToolUsageTracker(): ToolUsageTracker {
	return new ToolUsageTracker();
}

export function injectLearningsIntoPrompt(
	learnings: ToolLearningResult,
	toolName: string,
): string {
	const sections: string[] = [];

	if (learnings.warnings.length > 0) {
		sections.push(
			`**Warnings for ${toolName}:**\n${learnings.warnings.map((w) => `- ${w}`).join("\n")}`,
		);
	}

	if (learnings.hints.length > 0) {
		sections.push(
			`**Tips for ${toolName}:**\n${learnings.hints.map((h) => `- ${h.condition}: ${h.suggestion}`).join("\n")}`,
		);
	}

	if (learnings.argumentSuggestions.length > 0) {
		sections.push(
			`**Commonly used arguments:**\n${learnings.argumentSuggestions.map((s) => `- ${s.argName}: ${s.reason}`).join("\n")}`,
		);
	}

	if (sections.length === 0) {
		return "";
	}

	return `\n\n## Tool Usage Learnings\n${sections.join("\n\n")}\n`;
}
