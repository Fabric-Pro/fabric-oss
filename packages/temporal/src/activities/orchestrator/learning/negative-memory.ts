/**
 * Negative Memory
 *
 * Phase 5.3: Remember failures to avoid repeating mistakes.
 * Stores and queries failure records to warn about similar potential issues.
 */

import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export interface FailureRecord {
	id: string;
	taskDescription: string;
	taskKeywords: string[];
	failurePoint: string;
	errorType: string;
	errorMessage: string;
	rootCause?: string;
	avoidanceStrategy?: string;
	context: FailureContext;
	resolution?: FailureResolution;
	timestamp: Date;
	userId: string;
	organizationId?: string;
}

export interface FailureContext {
	stepId?: string;
	stepType?: string;
	executor?: string;
	toolName?: string;
	planId?: string;
	inputSummary?: string;
	precedingSteps?: string[];
}

export interface FailureResolution {
	resolved: boolean;
	resolvedAt?: Date;
	resolution: string;
	preventionHint?: string;
}

export interface SimilarFailure {
	failure: FailureRecord;
	similarity: number;
	warning: string;
	suggestion: string;
}

export interface FailureQuery {
	taskDescription: string;
	stepType?: string;
	executor?: string;
	toolName?: string;
}

export interface FailureCluster {
	id: string;
	errorType: string;
	commonKeywords: string[];
	failures: string[];
	frequency: number;
	avgTimeBetween: number;
	suggestedPrevention?: string;
}

// =============================================================================
// Negative Memory Store
// =============================================================================

export class InMemoryNegativeMemoryStore {
	private failures: Map<string, FailureRecord> = new Map();
	private clusters: Map<string, FailureCluster> = new Map();
	private maxFailures = 5000;

	async recordFailure(failure: FailureRecord): Promise<void> {
		this.failures.set(failure.id, failure);

		// Limit size
		if (this.failures.size > this.maxFailures) {
			const oldest = Array.from(this.failures.entries())
				.sort(
					(a, b) =>
						a[1].timestamp.getTime() - b[1].timestamp.getTime(),
				)
				.slice(0, 500);
			for (const [id] of oldest) {
				this.failures.delete(id);
			}
		}

		// Update clusters
		await this.updateClusters(failure);

		logger.debug("[NegativeMemory] Recorded failure", {
			id: failure.id,
			errorType: failure.errorType,
			failurePoint: failure.failurePoint,
		});
	}

	private async updateClusters(failure: FailureRecord): Promise<void> {
		const clusterId = `${failure.errorType}-${failure.context.stepType || "unknown"}`;
		let cluster = this.clusters.get(clusterId);

		if (!cluster) {
			cluster = {
				id: clusterId,
				errorType: failure.errorType,
				commonKeywords: [],
				failures: [],
				frequency: 0,
				avgTimeBetween: 0,
			};
		}

		cluster.failures.push(failure.id);
		cluster.frequency++;

		// Update common keywords
		const keywordCounts = new Map<string, number>();
		for (const fid of cluster.failures.slice(-100)) {
			const f = this.failures.get(fid);
			if (f) {
				for (const kw of f.taskKeywords) {
					keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
				}
			}
		}
		cluster.commonKeywords = Array.from(keywordCounts.entries())
			.filter(([_, count]) => count > cluster.failures.length * 0.3)
			.map(([kw]) => kw)
			.slice(0, 10);

		// Calculate avg time between failures
		if (cluster.failures.length >= 2) {
			const times = cluster.failures
				.slice(-10)
				.map((fid) => this.failures.get(fid)?.timestamp.getTime())
				.filter((t): t is number => t !== undefined)
				.sort();

			if (times.length >= 2) {
				const diffs = times.slice(1).map((t, i) => t - times[i]);
				cluster.avgTimeBetween =
					diffs.reduce((a, b) => a + b, 0) / diffs.length;
			}
		}

		this.clusters.set(clusterId, cluster);
	}

	async findSimilarFailures(query: FailureQuery): Promise<SimilarFailure[]> {
		const queryKeywords = this.extractKeywords(query.taskDescription);
		const results: SimilarFailure[] = [];

		for (const failure of this.failures.values()) {
			const similarity = this.computeSimilarity(
				queryKeywords,
				query,
				failure,
			);

			if (similarity > 0.3) {
				results.push({
					failure,
					similarity,
					warning: this.generateWarning(failure),
					suggestion: this.generateSuggestion(failure),
				});
			}
		}

		return results.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
	}

	private extractKeywords(text: string): string[] {
		const words = text
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
			"please",
			"help",
			"want",
			"need",
		]);

		return [...new Set(words.filter((w) => !stopWords.has(w)))];
	}

	private computeSimilarity(
		queryKeywords: string[],
		query: FailureQuery,
		failure: FailureRecord,
	): number {
		let score = 0;
		let maxScore = 0;

		// Keyword overlap (weight: 0.4)
		const keywordOverlap =
			queryKeywords.filter((k) => failure.taskKeywords.includes(k))
				.length / Math.max(queryKeywords.length, 1);
		score += keywordOverlap * 0.4;
		maxScore += 0.4;

		// Step type match (weight: 0.2)
		if (query.stepType && failure.context.stepType) {
			score += query.stepType === failure.context.stepType ? 0.2 : 0;
		}
		maxScore += 0.2;

		// Executor match (weight: 0.2)
		if (query.executor && failure.context.executor) {
			score += query.executor === failure.context.executor ? 0.2 : 0;
		}
		maxScore += 0.2;

		// Tool name match (weight: 0.2)
		if (query.toolName && failure.context.toolName) {
			score += query.toolName === failure.context.toolName ? 0.2 : 0;
		}
		maxScore += 0.2;

		return score / maxScore;
	}

	private generateWarning(failure: FailureRecord): string {
		const parts = [`Previous failure: ${failure.errorType}`];

		if (failure.context.stepType) {
			parts.push(`during ${failure.context.stepType}`);
		}

		if (failure.context.executor) {
			parts.push(`with ${failure.context.executor}`);
		}

		return parts.join(" ");
	}

	private generateSuggestion(failure: FailureRecord): string {
		if (failure.avoidanceStrategy) {
			return failure.avoidanceStrategy;
		}

		if (failure.resolution?.preventionHint) {
			return failure.resolution.preventionHint;
		}

		// Generate generic suggestion based on error type
		const suggestions: Record<string, string> = {
			timeout:
				"Consider increasing timeout or breaking into smaller steps",
			rate_limit: "Add delays between API calls or implement backoff",
			permission_denied:
				"Verify user has required permissions before executing",
			validation_error: "Validate inputs match expected schema",
			not_found: "Verify resource exists before attempting operation",
			network_error: "Implement retry logic with exponential backoff",
			auth_error:
				"Check authentication credentials are valid and not expired",
		};

		return (
			suggestions[failure.errorType] ||
			"Review the error context and add appropriate error handling"
		);
	}

	async getFailure(id: string): Promise<FailureRecord | null> {
		return this.failures.get(id) || null;
	}

	async updateResolution(
		failureId: string,
		resolution: FailureResolution,
	): Promise<void> {
		const failure = this.failures.get(failureId);
		if (failure) {
			failure.resolution = resolution;
			this.failures.set(failureId, failure);
		}
	}

	async addAvoidanceStrategy(
		failureId: string,
		strategy: string,
	): Promise<void> {
		const failure = this.failures.get(failureId);
		if (failure) {
			failure.avoidanceStrategy = strategy;
			this.failures.set(failureId, failure);
		}
	}

	async getCluster(clusterId: string): Promise<FailureCluster | null> {
		return this.clusters.get(clusterId) || null;
	}

	async getAllClusters(): Promise<FailureCluster[]> {
		return Array.from(this.clusters.values()).sort(
			(a, b) => b.frequency - a.frequency,
		);
	}

	async getRecentFailures(limit = 10): Promise<FailureRecord[]> {
		return Array.from(this.failures.values())
			.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
			.slice(0, limit);
	}

	async getFailuresByType(errorType: string): Promise<FailureRecord[]> {
		return Array.from(this.failures.values())
			.filter((f) => f.errorType === errorType)
			.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
	}

	getStats(): {
		totalFailures: number;
		totalClusters: number;
		topErrorTypes: Array<{ type: string; count: number }>;
		recentTrend: "increasing" | "stable" | "decreasing";
	} {
		const failures = Array.from(this.failures.values());

		// Count error types
		const errorCounts = new Map<string, number>();
		for (const f of failures) {
			errorCounts.set(
				f.errorType,
				(errorCounts.get(f.errorType) || 0) + 1,
			);
		}
		const topErrorTypes = Array.from(errorCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([type, count]) => ({ type, count }));

		// Calculate trend
		const now = Date.now();
		const lastWeek = failures.filter(
			(f) => now - f.timestamp.getTime() < 7 * 24 * 60 * 60 * 1000,
		).length;
		const prevWeek = failures.filter(
			(f) =>
				now - f.timestamp.getTime() >= 7 * 24 * 60 * 60 * 1000 &&
				now - f.timestamp.getTime() < 14 * 24 * 60 * 60 * 1000,
		).length;

		let recentTrend: "increasing" | "stable" | "decreasing" = "stable";
		if (lastWeek > prevWeek * 1.2) {
			recentTrend = "increasing";
		} else if (lastWeek < prevWeek * 0.8) {
			recentTrend = "decreasing";
		}

		return {
			totalFailures: failures.length,
			totalClusters: this.clusters.size,
			topErrorTypes,
			recentTrend,
		};
	}
}

// =============================================================================
// Negative Memory Manager
// =============================================================================

export class NegativeMemoryManager {
	private store: InMemoryNegativeMemoryStore;

	constructor(store?: InMemoryNegativeMemoryStore) {
		this.store = store || new InMemoryNegativeMemoryStore();
	}

	async recordFailure(
		taskDescription: string,
		errorType: string,
		errorMessage: string,
		context: FailureContext,
		userId: string,
		organizationId?: string,
		rootCause?: string,
	): Promise<string> {
		const id = `failure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const failure: FailureRecord = {
			id,
			taskDescription,
			taskKeywords: this.extractKeywords(taskDescription),
			failurePoint: context.stepId || context.stepType || "unknown",
			errorType,
			errorMessage,
			rootCause,
			context,
			timestamp: new Date(),
			userId,
			organizationId,
		};

		await this.store.recordFailure(failure);
		return id;
	}

	private extractKeywords(text: string): string[] {
		const words = text
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
			"please",
			"help",
			"want",
			"need",
		]);

		return [...new Set(words.filter((w) => !stopWords.has(w)))];
	}

	async checkForSimilarFailures(
		query: FailureQuery,
	): Promise<SimilarFailure[]> {
		return this.store.findSimilarFailures(query);
	}

	async resolveFailure(
		failureId: string,
		resolution: string,
		preventionHint?: string,
	): Promise<void> {
		await this.store.updateResolution(failureId, {
			resolved: true,
			resolvedAt: new Date(),
			resolution,
			preventionHint,
		});
	}

	async addAvoidanceStrategy(
		failureId: string,
		strategy: string,
	): Promise<void> {
		await this.store.addAvoidanceStrategy(failureId, strategy);
	}

	async getFailureClusters(): Promise<FailureCluster[]> {
		return this.store.getAllClusters();
	}

	async getFailureStats(): Promise<
		ReturnType<InMemoryNegativeMemoryStore["getStats"]>
	> {
		return this.store.getStats();
	}

	getStore(): InMemoryNegativeMemoryStore {
		return this.store;
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

export function createNegativeMemoryManager(): NegativeMemoryManager {
	return new NegativeMemoryManager();
}

export function classifyErrorType(error: string): string {
	const lowerError = error.toLowerCase();

	if (lowerError.includes("timeout")) {
		return "timeout";
	}
	if (lowerError.includes("rate limit") || lowerError.includes("429")) {
		return "rate_limit";
	}
	if (
		lowerError.includes("permission") ||
		lowerError.includes("forbidden") ||
		lowerError.includes("403")
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
		lowerError.includes("network") ||
		lowerError.includes("econnrefused")
	) {
		return "network_error";
	}
	if (
		lowerError.includes("authentication") ||
		lowerError.includes("401") ||
		lowerError.includes("unauthorized")
	) {
		return "auth_error";
	}
	if (lowerError.includes("conflict") || lowerError.includes("409")) {
		return "conflict";
	}
	if (lowerError.includes("unavailable") || lowerError.includes("503")) {
		return "service_unavailable";
	}

	return "unknown";
}

export function generateFailureWarnings(
	similarFailures: SimilarFailure[],
): string {
	if (similarFailures.length === 0) {
		return "";
	}

	const warnings = similarFailures
		.slice(0, 3)
		.map((sf) => `- ${sf.warning}. ${sf.suggestion}`)
		.join("\n");

	return `\n\n## Previous Failure Warnings\nSimilar tasks have failed before:\n${warnings}\n`;
}
