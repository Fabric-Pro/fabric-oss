/**
 * Context Summarization
 *
 * Phase 4.3: Intelligent context compression for long executions.
 * Manages token budgets and preserves important information.
 */

import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export interface TrajectoryStep {
	stepId: string;
	description: string;
	status: "pending" | "in_progress" | "complete" | "failed" | "skipped";
	startTime?: Date;
	endTime?: Date;
	input?: unknown;
	output?: unknown;
	error?: string;
	tokenCount?: number;
	hasArtifacts?: boolean;
	artifacts?: Array<{ id: string; type: string }>;
	importance?: "low" | "medium" | "high" | "critical";
}

export interface SummarizationStrategy {
	// Sliding window: keep recent, summarize old
	slidingWindow: {
		recentSteps: number; // Number of recent steps to keep in full
		summarizeAfter: number; // Summarize steps older than this
	};

	// Importance-based retention
	importanceBased: {
		keepHighImpact: boolean;
		keepWithArtifacts: boolean;
		keepWithErrors: boolean;
		keepMilestones: boolean;
	};

	// Token budget
	tokenBudget: {
		maxTokens: number;
		reserveForResponse: number;
		warningThreshold: number; // Warn when this % of budget is used
	};
}

export interface SummarizationResult {
	fullContext: TrajectoryStep[]; // Recent steps kept in full
	summarizedContext: string; // Older steps summarized as text
	keyFacts: string[]; // Important facts extracted
	preservedArtifacts: Array<{ id: string; type: string; stepId: string }>;
	tokenEstimate: number;
	compressionRatio: number;
}

export interface ContextWindow {
	steps: TrajectoryStep[];
	summary?: string;
	keyFacts: string[];
	totalTokens: number;
	lastSummarizedAt?: Date;
}

// =============================================================================
// Default Strategy
// =============================================================================

export const DEFAULT_STRATEGY: SummarizationStrategy = {
	slidingWindow: {
		recentSteps: 5,
		summarizeAfter: 10,
	},
	importanceBased: {
		keepHighImpact: true,
		keepWithArtifacts: true,
		keepWithErrors: true,
		keepMilestones: true,
	},
	tokenBudget: {
		maxTokens: 8000,
		reserveForResponse: 2000,
		warningThreshold: 0.8,
	},
};

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Estimate token count for text (rough approximation: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Estimate token count for a trajectory step.
 */
export function estimateStepTokens(step: TrajectoryStep): number {
	let tokens = 0;

	// Description
	tokens += estimateTokens(step.description);

	// Input (if present)
	if (step.input) {
		tokens += estimateTokens(JSON.stringify(step.input));
	}

	// Output (if present)
	if (step.output) {
		const outputStr = JSON.stringify(step.output);
		// Truncate large outputs in estimate
		tokens += estimateTokens(outputStr.slice(0, 2000));
	}

	// Error (if present)
	if (step.error) {
		tokens += estimateTokens(step.error);
	}

	// Overhead for formatting
	tokens += 50;

	return tokens;
}

// =============================================================================
// Context Summarizer
// =============================================================================

export class ContextSummarizer {
	private strategy: SummarizationStrategy;

	constructor(strategy: SummarizationStrategy = DEFAULT_STRATEGY) {
		this.strategy = strategy;
	}

	/**
	 * Summarize execution context based on strategy.
	 */
	summarize(steps: TrajectoryStep[]): SummarizationResult {
		if (steps.length === 0) {
			return {
				fullContext: [],
				summarizedContext: "",
				keyFacts: [],
				preservedArtifacts: [],
				tokenEstimate: 0,
				compressionRatio: 1,
			};
		}

		// Calculate original token count
		const originalTokens = steps.reduce(
			(sum, step) => sum + estimateStepTokens(step),
			0,
		);

		// Determine which steps to keep in full
		const { fullSteps, stepsToSummarize } = this.partitionSteps(steps);

		// Extract key facts from steps to summarize
		const keyFacts = this.extractKeyFacts(stepsToSummarize);

		// Generate summary text
		const summarizedContext = this.generateSummary(
			stepsToSummarize,
			keyFacts,
		);

		// Collect preserved artifacts
		const preservedArtifacts = this.collectArtifacts(steps);

		// Calculate new token count
		const fullContextTokens = fullSteps.reduce(
			(sum, step) => sum + estimateStepTokens(step),
			0,
		);
		const summaryTokens = estimateTokens(summarizedContext);
		const factsTokens = keyFacts.reduce(
			(sum, fact) => sum + estimateTokens(fact),
			0,
		);
		const tokenEstimate = fullContextTokens + summaryTokens + factsTokens;

		const compressionRatio =
			originalTokens > 0 ? tokenEstimate / originalTokens : 1;

		logger.debug("[ContextSummarizer] Summarization complete", {
			originalSteps: steps.length,
			fullSteps: fullSteps.length,
			summarizedSteps: stepsToSummarize.length,
			originalTokens,
			tokenEstimate,
			compressionRatio: compressionRatio.toFixed(2),
		});

		return {
			fullContext: fullSteps,
			summarizedContext,
			keyFacts,
			preservedArtifacts,
			tokenEstimate,
			compressionRatio,
		};
	}

	/**
	 * Partition steps into those to keep in full and those to summarize.
	 */
	private partitionSteps(steps: TrajectoryStep[]): {
		fullSteps: TrajectoryStep[];
		stepsToSummarize: TrajectoryStep[];
	} {
		const { slidingWindow, importanceBased } = this.strategy;
		const fullSteps: TrajectoryStep[] = [];
		const stepsToSummarize: TrajectoryStep[] = [];

		// Keep recent steps
		const recentCutoff = steps.length - slidingWindow.recentSteps;

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			const isRecent = i >= recentCutoff;

			// Check if step should be kept based on importance
			const shouldKeep =
				isRecent ||
				(importanceBased.keepHighImpact &&
					step.importance === "critical") ||
				(importanceBased.keepWithArtifacts && step.hasArtifacts) ||
				(importanceBased.keepWithErrors && step.status === "failed") ||
				(importanceBased.keepMilestones && this.isMilestone(step));

			if (shouldKeep) {
				fullSteps.push(step);
			} else {
				stepsToSummarize.push(step);
			}
		}

		return { fullSteps, stepsToSummarize };
	}

	/**
	 * Check if a step is a milestone (significant progress point).
	 */
	private isMilestone(step: TrajectoryStep): boolean {
		const desc = step.description.toLowerCase();
		const milestoneKeywords = [
			"complete",
			"finish",
			"deploy",
			"publish",
			"release",
			"milestone",
			"phase",
			"stage",
		];
		return milestoneKeywords.some((kw) => desc.includes(kw));
	}

	/**
	 * Extract key facts from steps.
	 */
	private extractKeyFacts(steps: TrajectoryStep[]): string[] {
		const facts: string[] = [];

		// Group steps by outcome
		const completed = steps.filter((s) => s.status === "complete");
		const failed = steps.filter((s) => s.status === "failed");
		const skipped = steps.filter((s) => s.status === "skipped");

		// Summary facts
		if (completed.length > 0) {
			facts.push(`Completed ${completed.length} step(s) successfully`);
		}
		if (failed.length > 0) {
			facts.push(`${failed.length} step(s) failed`);
			// Add specific failure info
			for (const step of failed.slice(0, 3)) {
				facts.push(
					`- Failed: ${step.description}${step.error ? ` (${step.error.slice(0, 100)})` : ""}`,
				);
			}
		}
		if (skipped.length > 0) {
			facts.push(`${skipped.length} step(s) were skipped`);
		}

		// Extract important outputs
		for (const step of completed) {
			if (step.output && typeof step.output === "object") {
				const output = step.output as Record<string, unknown>;
				// Look for common important fields
				if (output.url) {
					facts.push(`Created: ${output.url}`);
				}
				if (output.id) {
					facts.push(`Created resource with ID: ${output.id}`);
				}
				if (output.path) {
					facts.push(`Created file: ${output.path}`);
				}
			}
		}

		// Extract artifact information
		for (const step of steps) {
			if (step.artifacts && step.artifacts.length > 0) {
				facts.push(
					`Step '${step.stepId}' produced ${step.artifacts.length} artifact(s)`,
				);
			}
		}

		return facts.slice(0, 10); // Limit to top 10 facts
	}

	/**
	 * Generate a text summary of steps.
	 */
	private generateSummary(
		steps: TrajectoryStep[],
		keyFacts: string[],
	): string {
		if (steps.length === 0) {
			return "";
		}

		const lines: string[] = ["## Previous Steps Summary", ""];

		// Timeline overview
		lines.push(`### Timeline (${steps.length} steps)`);
		for (const step of steps) {
			const status =
				step.status === "complete"
					? "✓"
					: step.status === "failed"
						? "✗"
						: "○";
			lines.push(`${status} ${step.description}`);
		}
		lines.push("");

		// Key facts
		if (keyFacts.length > 0) {
			lines.push("### Key Facts");
			for (const fact of keyFacts) {
				lines.push(`- ${fact}`);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Collect all artifacts from steps.
	 */
	private collectArtifacts(
		steps: TrajectoryStep[],
	): Array<{ id: string; type: string; stepId: string }> {
		const artifacts: Array<{ id: string; type: string; stepId: string }> =
			[];

		for (const step of steps) {
			if (step.artifacts) {
				for (const artifact of step.artifacts) {
					artifacts.push({
						id: artifact.id,
						type: artifact.type,
						stepId: step.stepId,
					});
				}
			}
		}

		return artifacts;
	}

	/**
	 * Check if context exceeds token budget.
	 */
	checkBudget(tokenCount: number): {
		withinBudget: boolean;
		warning: boolean;
		available: number;
	} {
		const { maxTokens, reserveForResponse, warningThreshold } =
			this.strategy.tokenBudget;
		const available = maxTokens - reserveForResponse;
		const usageRatio = tokenCount / available;

		return {
			withinBudget: tokenCount <= available,
			warning: usageRatio >= warningThreshold,
			available: available - tokenCount,
		};
	}

	/**
	 * Update strategy.
	 */
	updateStrategy(updates: Partial<SummarizationStrategy>): void {
		this.strategy = {
			...this.strategy,
			...updates,
			slidingWindow: {
				...this.strategy.slidingWindow,
				...updates.slidingWindow,
			},
			importanceBased: {
				...this.strategy.importanceBased,
				...updates.importanceBased,
			},
			tokenBudget: {
				...this.strategy.tokenBudget,
				...updates.tokenBudget,
			},
		};
	}
}

// Global instance
export const contextSummarizer = new ContextSummarizer();

// =============================================================================
// Incremental Summarization
// =============================================================================

/**
 * Manages incremental context summarization for long-running executions.
 */
export class IncrementalSummarizer {
	private window: ContextWindow = {
		steps: [],
		keyFacts: [],
		totalTokens: 0,
	};
	private summarizer: ContextSummarizer;
	private maxStepsBeforeSummarize: number;

	constructor(
		summarizer: ContextSummarizer = contextSummarizer,
		maxSteps = 20,
	) {
		this.summarizer = summarizer;
		this.maxStepsBeforeSummarize = maxSteps;
	}

	/**
	 * Add a new step to the context window.
	 */
	addStep(step: TrajectoryStep): void {
		this.window.steps.push(step);
		this.window.totalTokens += estimateStepTokens(step);

		// Check if we need to summarize
		if (this.window.steps.length >= this.maxStepsBeforeSummarize) {
			this.compressWindow();
		}
	}

	/**
	 * Compress the context window by summarizing older steps.
	 */
	private compressWindow(): void {
		const result = this.summarizer.summarize(this.window.steps);

		// Update window
		this.window = {
			steps: result.fullContext,
			summary: this.combineSummaries(
				this.window.summary,
				result.summarizedContext,
			),
			keyFacts: [
				...new Set([...this.window.keyFacts, ...result.keyFacts]),
			],
			totalTokens: result.tokenEstimate,
			lastSummarizedAt: new Date(),
		};

		logger.debug("[IncrementalSummarizer] Window compressed", {
			stepsKept: this.window.steps.length,
			keyFactsCount: this.window.keyFacts.length,
			totalTokens: this.window.totalTokens,
		});
	}

	/**
	 * Combine old and new summaries.
	 */
	private combineSummaries(
		oldSummary: string | undefined,
		newSummary: string,
	): string {
		if (!oldSummary) {
			return newSummary;
		}
		if (!newSummary) {
			return oldSummary;
		}

		return `${oldSummary}\n\n---\n\n${newSummary}`;
	}

	/**
	 * Get the current context window.
	 */
	getContext(): ContextWindow {
		return { ...this.window };
	}

	/**
	 * Get formatted context for LLM.
	 */
	getFormattedContext(): string {
		const parts: string[] = [];

		if (this.window.summary) {
			parts.push(this.window.summary);
		}

		if (this.window.keyFacts.length > 0) {
			parts.push("## Key Facts");
			parts.push(this.window.keyFacts.map((f) => `- ${f}`).join("\n"));
		}

		if (this.window.steps.length > 0) {
			parts.push("## Recent Steps");
			for (const step of this.window.steps) {
				const status =
					step.status === "complete"
						? "✓"
						: step.status === "failed"
							? "✗"
							: "○";
				parts.push(`### ${status} ${step.description}`);
				if (step.output) {
					const outputStr = JSON.stringify(step.output, null, 2);
					parts.push("```json");
					parts.push(outputStr.slice(0, 500));
					if (outputStr.length > 500) {
						parts.push("...(truncated)");
					}
					parts.push("```");
				}
			}
		}

		return parts.join("\n\n");
	}

	/**
	 * Reset the context window.
	 */
	reset(): void {
		this.window = {
			steps: [],
			keyFacts: [],
			totalTokens: 0,
		};
	}
}

// =============================================================================
// Activity Functions
// =============================================================================

/**
 * Summarize execution context.
 */
export async function summarizeContextActivity(
	steps: TrajectoryStep[],
	strategy?: Partial<SummarizationStrategy>,
): Promise<SummarizationResult> {
	const summarizer = new ContextSummarizer({
		...DEFAULT_STRATEGY,
		...strategy,
	});
	return summarizer.summarize(steps);
}

/**
 * Check if context is within token budget.
 */
export async function checkContextBudgetActivity(
	tokenCount: number,
	maxTokens?: number,
): Promise<{
	withinBudget: boolean;
	warning: boolean;
	available: number;
}> {
	const summarizer = new ContextSummarizer({
		...DEFAULT_STRATEGY,
		tokenBudget: {
			...DEFAULT_STRATEGY.tokenBudget,
			maxTokens: maxTokens || DEFAULT_STRATEGY.tokenBudget.maxTokens,
		},
	});
	return summarizer.checkBudget(tokenCount);
}

/**
 * Estimate tokens for a step.
 */
export async function estimateStepTokensActivity(
	step: TrajectoryStep,
): Promise<number> {
	return estimateStepTokens(step);
}
