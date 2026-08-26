/**
 * Execution Pattern Recognition
 *
 * Phase 5.2: Recognize similar past executions for optimization.
 * Clusters execution patterns and suggests optimizations based on history.
 */

import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export interface ExecutionSignature {
	taskEmbedding?: number[];
	taskKeywords: string[];
	stepSequence: string[];
	executorSequence: string[];
	toolSequence: string[];
	stepCount: number;
	hasApprovals: boolean;
	hasErrors: boolean;
}

export interface ExecutionRecord {
	executionId: string;
	taskDescription: string;
	signature: ExecutionSignature;
	metrics: ExecutionMetrics;
	steps: ExecutionStepSummary[];
	timestamp: Date;
	userId: string;
	organizationId?: string;
	success: boolean;
}

export interface ExecutionMetrics {
	totalDurationMs: number;
	planningDurationMs: number;
	executionDurationMs: number;
	approvalWaitMs: number;
	totalTokens: number;
	stepCount: number;
	errorCount: number;
	retryCount: number;
}

export interface ExecutionStepSummary {
	stepId: string;
	stepType: string;
	executor: string;
	durationMs: number;
	success: boolean;
	wasParallel: boolean;
	dependsOn: string[];
}

export interface ExecutionPattern {
	patternId: string;
	signature: ExecutionSignature;
	occurrences: number;
	avgDurationMs: number;
	successRate: number;
	optimizations: PatternOptimization[];
	examples: string[];
	lastSeen: Date;
	createdAt: Date;
}

export interface PatternOptimization {
	id: string;
	type: "parallel" | "skip" | "combine" | "reorder" | "cache";
	description: string;
	affectedSteps: string[];
	estimatedImprovement: number;
	confidence: number;
	applied: number;
	successful: number;
}

export interface PatternMatch {
	pattern: ExecutionPattern;
	similarity: number;
	applicableOptimizations: PatternOptimization[];
}

export interface OptimizationSuggestion {
	type: PatternOptimization["type"];
	description: string;
	steps: string[];
	estimatedSavingsMs: number;
	confidence: number;
	basedOnPattern: string;
}

// =============================================================================
// Signature Generator
// =============================================================================

export function generateExecutionSignature(
	taskDescription: string,
	steps: ExecutionStepSummary[],
): ExecutionSignature {
	const taskKeywords = extractKeywords(taskDescription);
	const stepSequence = steps.map((s) => s.stepType);
	const executorSequence = steps.map((s) => s.executor);
	const toolSequence = steps
		.filter(
			(s) => s.stepType.includes("tool") || s.stepType.includes("mcp"),
		)
		.map((s) => s.stepType);

	return {
		taskKeywords,
		stepSequence,
		executorSequence,
		toolSequence,
		stepCount: steps.length,
		hasApprovals: steps.some((s) => s.stepType.includes("approval")),
		hasErrors: steps.some((s) => !s.success),
	};
}

function extractKeywords(text: string): string[] {
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

	return [...new Set(words.filter((w) => !stopWords.has(w)))].slice(0, 30);
}

// =============================================================================
// Pattern Store
// =============================================================================

export class InMemoryPatternStore {
	private patterns: Map<string, ExecutionPattern> = new Map();
	private executions: ExecutionRecord[] = [];
	private maxExecutions = 5000;

	async recordExecution(record: ExecutionRecord): Promise<void> {
		this.executions.push(record);
		if (this.executions.length > this.maxExecutions) {
			this.executions = this.executions.slice(-this.maxExecutions);
		}

		await this.updatePatterns(record);
	}

	private async updatePatterns(record: ExecutionRecord): Promise<void> {
		const patternId = this.computePatternId(record.signature);
		let pattern = this.patterns.get(patternId);

		if (!pattern) {
			pattern = {
				patternId,
				signature: record.signature,
				occurrences: 0,
				avgDurationMs: 0,
				successRate: 0,
				optimizations: [],
				examples: [],
				lastSeen: new Date(),
				createdAt: new Date(),
			};
		}

		// Update stats
		pattern.occurrences++;
		pattern.avgDurationMs =
			(pattern.avgDurationMs * (pattern.occurrences - 1) +
				record.metrics.totalDurationMs) /
			pattern.occurrences;
		pattern.successRate =
			(pattern.successRate * (pattern.occurrences - 1) +
				(record.success ? 1 : 0)) /
			pattern.occurrences;
		pattern.lastSeen = new Date();

		// Add example
		if (pattern.examples.length < 10) {
			pattern.examples.push(record.executionId);
		}

		// Generate optimizations if enough data
		if (pattern.occurrences >= 5) {
			pattern.optimizations = await this.analyzeOptimizations(
				pattern,
				record,
			);
		}

		this.patterns.set(patternId, pattern);
	}

	private computePatternId(signature: ExecutionSignature): string {
		const parts = [
			signature.stepSequence.join("-"),
			signature.executorSequence.join("-"),
			signature.stepCount.toString(),
		];
		return parts.join("|").slice(0, 100);
	}

	private async analyzeOptimizations(
		pattern: ExecutionPattern,
		latestRecord: ExecutionRecord,
	): Promise<PatternOptimization[]> {
		const optimizations: PatternOptimization[] = [];

		// Analyze parallelization opportunities
		const parallelOps = this.findParallelizationOpportunities(
			latestRecord.steps,
		);
		if (parallelOps.length > 0) {
			optimizations.push({
				id: `${pattern.patternId}-parallel`,
				type: "parallel",
				description: `Steps ${parallelOps.join(", ")} could run in parallel`,
				affectedSteps: parallelOps,
				estimatedImprovement: 0.2, // 20% improvement estimate
				confidence: 0.7,
				applied: 0,
				successful: 0,
			});
		}

		// Analyze skip opportunities
		const skipOps = this.findSkipOpportunities(latestRecord.steps);
		if (skipOps.length > 0) {
			optimizations.push({
				id: `${pattern.patternId}-skip`,
				type: "skip",
				description: `Steps ${skipOps.join(", ")} could potentially be skipped`,
				affectedSteps: skipOps,
				estimatedImprovement: 0.15,
				confidence: 0.5,
				applied: 0,
				successful: 0,
			});
		}

		// Analyze combine opportunities
		const combineOps = this.findCombineOpportunities(latestRecord.steps);
		if (combineOps.length > 0) {
			optimizations.push({
				id: `${pattern.patternId}-combine`,
				type: "combine",
				description: `Steps ${combineOps.join(", ")} could be combined`,
				affectedSteps: combineOps,
				estimatedImprovement: 0.1,
				confidence: 0.6,
				applied: 0,
				successful: 0,
			});
		}

		// Analyze caching opportunities
		const cacheOps = this.findCachingOpportunities(latestRecord.steps);
		if (cacheOps.length > 0) {
			optimizations.push({
				id: `${pattern.patternId}-cache`,
				type: "cache",
				description: `Results from ${cacheOps.join(", ")} could be cached`,
				affectedSteps: cacheOps,
				estimatedImprovement: 0.3,
				confidence: 0.6,
				applied: 0,
				successful: 0,
			});
		}

		return optimizations;
	}

	private findParallelizationOpportunities(
		steps: ExecutionStepSummary[],
	): string[] {
		const candidates: string[] = [];

		for (let i = 0; i < steps.length - 1; i++) {
			const current = steps[i];
			const next = steps[i + 1];

			// If next step doesn't depend on current and neither was parallel
			if (
				!next.wasParallel &&
				!current.wasParallel &&
				!next.dependsOn.includes(current.stepId)
			) {
				// Check if they use different executors or tools
				if (current.executor !== next.executor) {
					candidates.push(current.stepId, next.stepId);
				}
			}
		}

		return [...new Set(candidates)];
	}

	private findSkipOpportunities(steps: ExecutionStepSummary[]): string[] {
		const candidates: string[] = [];

		for (const step of steps) {
			// Very fast steps that always succeed might be skippable
			if (step.durationMs < 100 && step.success) {
				// Don't suggest skipping critical step types
				if (
					!step.stepType.includes("approval") &&
					!step.stepType.includes("validate")
				) {
					candidates.push(step.stepId);
				}
			}
		}

		return candidates;
	}

	private findCombineOpportunities(steps: ExecutionStepSummary[]): string[] {
		const candidates: string[] = [];

		for (let i = 0; i < steps.length - 1; i++) {
			const current = steps[i];
			const next = steps[i + 1];

			// Same executor, same type, sequential
			if (
				current.executor === next.executor &&
				current.stepType === next.stepType &&
				next.dependsOn.includes(current.stepId)
			) {
				candidates.push(current.stepId, next.stepId);
			}
		}

		return [...new Set(candidates)];
	}

	private findCachingOpportunities(steps: ExecutionStepSummary[]): string[] {
		const candidates: string[] = [];

		// Steps that are read-only and deterministic
		const cacheableTypes = ["read", "get", "list", "search", "fetch"];

		for (const step of steps) {
			if (
				cacheableTypes.some((t) =>
					step.stepType.toLowerCase().includes(t),
				)
			) {
				candidates.push(step.stepId);
			}
		}

		return candidates;
	}

	async findSimilarPatterns(
		signature: ExecutionSignature,
		limit = 5,
	): Promise<PatternMatch[]> {
		const matches: PatternMatch[] = [];

		for (const pattern of this.patterns.values()) {
			const similarity = this.computeSimilarity(
				signature,
				pattern.signature,
			);
			if (similarity > 0.3) {
				matches.push({
					pattern,
					similarity,
					applicableOptimizations: pattern.optimizations.filter(
						(o) => o.confidence > 0.5,
					),
				});
			}
		}

		return matches
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, limit);
	}

	private computeSimilarity(
		sig1: ExecutionSignature,
		sig2: ExecutionSignature,
	): number {
		let score = 0;
		let maxScore = 0;

		// Keyword overlap (weight: 0.3)
		const keywordOverlap =
			sig1.taskKeywords.filter((k) => sig2.taskKeywords.includes(k))
				.length /
			Math.max(sig1.taskKeywords.length, sig2.taskKeywords.length, 1);
		score += keywordOverlap * 0.3;
		maxScore += 0.3;

		// Step sequence similarity (weight: 0.3)
		const stepSimilarity = this.sequenceSimilarity(
			sig1.stepSequence,
			sig2.stepSequence,
		);
		score += stepSimilarity * 0.3;
		maxScore += 0.3;

		// Executor sequence similarity (weight: 0.2)
		const executorSimilarity = this.sequenceSimilarity(
			sig1.executorSequence,
			sig2.executorSequence,
		);
		score += executorSimilarity * 0.2;
		maxScore += 0.2;

		// Step count similarity (weight: 0.1)
		const countSimilarity =
			1 -
			Math.abs(sig1.stepCount - sig2.stepCount) /
				Math.max(sig1.stepCount, sig2.stepCount, 1);
		score += countSimilarity * 0.1;
		maxScore += 0.1;

		// Same flags (weight: 0.1)
		if (sig1.hasApprovals === sig2.hasApprovals) {
			score += 0.05;
		}
		if (sig1.hasErrors === sig2.hasErrors) {
			score += 0.05;
		}
		maxScore += 0.1;

		return score / maxScore;
	}

	private sequenceSimilarity(seq1: string[], seq2: string[]): number {
		if (seq1.length === 0 && seq2.length === 0) {
			return 1;
		}
		if (seq1.length === 0 || seq2.length === 0) {
			return 0;
		}

		// Longest Common Subsequence based similarity
		const lcs = this.longestCommonSubsequence(seq1, seq2);
		return (2 * lcs) / (seq1.length + seq2.length);
	}

	private longestCommonSubsequence(seq1: string[], seq2: string[]): number {
		const m = seq1.length;
		const n = seq2.length;
		const dp: number[][] = Array(m + 1)
			.fill(null)
			.map(() => Array(n + 1).fill(0));

		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (seq1[i - 1] === seq2[j - 1]) {
					dp[i][j] = dp[i - 1][j - 1] + 1;
				} else {
					dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
				}
			}
		}

		return dp[m][n];
	}

	async getPattern(patternId: string): Promise<ExecutionPattern | null> {
		return this.patterns.get(patternId) || null;
	}

	async getAllPatterns(): Promise<ExecutionPattern[]> {
		return Array.from(this.patterns.values());
	}

	async recordOptimizationResult(
		patternId: string,
		optimizationId: string,
		success: boolean,
	): Promise<void> {
		const pattern = this.patterns.get(patternId);
		if (!pattern) {
			return;
		}

		const opt = pattern.optimizations.find((o) => o.id === optimizationId);
		if (opt) {
			opt.applied++;
			if (success) {
				opt.successful++;
			}
			// Update confidence based on results
			opt.confidence = opt.successful / opt.applied;
		}

		this.patterns.set(patternId, pattern);
	}

	getStats(): {
		totalPatterns: number;
		totalExecutions: number;
		avgSuccessRate: number;
		topOptimizations: string[];
	} {
		const patterns = Array.from(this.patterns.values());
		const avgSuccessRate =
			patterns.length > 0
				? patterns.reduce((sum, p) => sum + p.successRate, 0) /
					patterns.length
				: 0;

		// Find top optimizations by confidence
		const allOptimizations = patterns.flatMap((p) => p.optimizations);
		const topOptimizations = allOptimizations
			.filter((o) => o.applied > 0)
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, 5)
			.map((o) => o.description);

		return {
			totalPatterns: patterns.length,
			totalExecutions: this.executions.length,
			avgSuccessRate,
			topOptimizations,
		};
	}
}

// =============================================================================
// Pattern Recognizer
// =============================================================================

export class PatternRecognizer {
	private store: InMemoryPatternStore;

	constructor(store?: InMemoryPatternStore) {
		this.store = store || new InMemoryPatternStore();
	}

	async recordExecution(
		executionId: string,
		taskDescription: string,
		steps: ExecutionStepSummary[],
		metrics: ExecutionMetrics,
		success: boolean,
		userId: string,
		organizationId?: string,
	): Promise<void> {
		const signature = generateExecutionSignature(taskDescription, steps);

		const record: ExecutionRecord = {
			executionId,
			taskDescription,
			signature,
			metrics,
			steps,
			timestamp: new Date(),
			userId,
			organizationId,
			success,
		};

		await this.store.recordExecution(record);

		logger.debug("[PatternRecognizer] Recorded execution", {
			executionId,
			patternId: this.computePatternId(signature),
			stepCount: steps.length,
			success,
		});
	}

	private computePatternId(signature: ExecutionSignature): string {
		const parts = [
			signature.stepSequence.join("-"),
			signature.executorSequence.join("-"),
			signature.stepCount.toString(),
		];
		return parts.join("|").slice(0, 100);
	}

	async findSimilarExecutions(
		taskDescription: string,
		plannedSteps?: Array<{ type: string; executor: string }>,
	): Promise<PatternMatch[]> {
		const signature: ExecutionSignature = {
			taskKeywords: extractKeywords(taskDescription),
			stepSequence: plannedSteps?.map((s) => s.type) || [],
			executorSequence: plannedSteps?.map((s) => s.executor) || [],
			toolSequence: [],
			stepCount: plannedSteps?.length || 0,
			hasApprovals: false,
			hasErrors: false,
		};

		return this.store.findSimilarPatterns(signature);
	}

	async suggestOptimizations(
		taskDescription: string,
		plannedSteps: Array<{
			id: string;
			type: string;
			executor: string;
			dependsOn?: string[];
		}>,
	): Promise<OptimizationSuggestion[]> {
		const matches = await this.findSimilarExecutions(
			taskDescription,
			plannedSteps,
		);

		const suggestions: OptimizationSuggestion[] = [];

		for (const match of matches) {
			for (const opt of match.applicableOptimizations) {
				// Map optimization to current plan's steps
				const relevantSteps = plannedSteps
					.filter(
						(s) =>
							opt.affectedSteps.some(
								(affected) =>
									s.type.includes(affected) ||
									s.id.includes(affected),
							) || opt.type === "parallel",
					)
					.map((s) => s.id);

				if (relevantSteps.length > 0) {
					suggestions.push({
						type: opt.type,
						description: opt.description,
						steps: relevantSteps,
						estimatedSavingsMs:
							match.pattern.avgDurationMs *
							opt.estimatedImprovement,
						confidence: opt.confidence * match.similarity,
						basedOnPattern: match.pattern.patternId,
					});
				}
			}
		}

		// Deduplicate and sort by confidence
		const seen = new Set<string>();
		return suggestions
			.filter((s) => {
				const key = `${s.type}-${s.steps.sort().join(",")}`;
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			})
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, 5);
	}

	async getPatternStats(): Promise<
		ReturnType<InMemoryPatternStore["getStats"]>
	> {
		return this.store.getStats();
	}

	async recordOptimizationResult(
		patternId: string,
		optimizationId: string,
		success: boolean,
	): Promise<void> {
		await this.store.recordOptimizationResult(
			patternId,
			optimizationId,
			success,
		);
	}

	getStore(): InMemoryPatternStore {
		return this.store;
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

export function createPatternRecognizer(): PatternRecognizer {
	return new PatternRecognizer();
}

export function optimizationToString(
	suggestion: OptimizationSuggestion,
): string {
	return `[${suggestion.type.toUpperCase()}] ${suggestion.description} (confidence: ${Math.round(suggestion.confidence * 100)}%, estimated savings: ${Math.round(suggestion.estimatedSavingsMs)}ms)`;
}
