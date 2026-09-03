/**
 * Token Budget Enforcement
 *
 * End-to-end token tracking and budget enforcement for orchestrator executions.
 * Prevents runaway executions by enforcing configurable limits.
 *
 * Features:
 * - Per-execution token budgets
 * - Per-step token tracking
 * - Warning thresholds before hard limits
 * - Budget allocation strategies
 * - Usage analytics
 */

import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export interface TokenBudgetConfig {
	/** Maximum tokens for entire execution (0 = unlimited) */
	maxTotalTokens: number;
	/** Maximum tokens per individual step */
	maxTokensPerStep: number;
	/** Warning threshold (percentage of max, 0-1) */
	warningThreshold: number;
	/** Action when budget exceeded */
	onBudgetExceeded: "stop" | "warn" | "throttle";
	/** Reserve tokens for final response synthesis */
	reserveForSynthesis: number;
	/** Enable adaptive budgeting based on step importance */
	adaptiveBudgeting: boolean;
}

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	model?: string;
	timestamp: Date;
}

export interface StepTokenUsage extends TokenUsage {
	stepId: string;
	stepType: string;
	executor?: string;
}

export interface TokenBudgetState {
	config: TokenBudgetConfig;
	totalUsed: number;
	stepUsage: Map<string, StepTokenUsage>;
	warningIssued: boolean;
	budgetExceeded: boolean;
	remainingBudget: number;
	usageHistory: TokenUsage[];
}

export interface BudgetCheckResult {
	allowed: boolean;
	reason?: string;
	remainingTokens: number;
	usagePercentage: number;
	warning?: string;
	suggestedLimit?: number;
}

export interface TokenBudgetSummary {
	totalUsed: number;
	totalBudget: number;
	usagePercentage: number;
	stepBreakdown: Array<{
		stepId: string;
		stepType: string;
		tokens: number;
		percentage: number;
	}>;
	modelBreakdown: Array<{
		model: string;
		tokens: number;
		percentage: number;
	}>;
	peakUsageStep?: string;
	averageTokensPerStep: number;
	estimatedCost?: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = {
	maxTotalTokens: 200000, // 200k tokens (models support 200K+ context; pruning keeps growth sublinear)
	maxTokensPerStep: 32000, // 32k per step (allows larger tool results)
	warningThreshold: 0.8, // Warn at 80%
	onBudgetExceeded: "warn",
	reserveForSynthesis: 8000, // Reserve 8k for final response synthesis
	adaptiveBudgeting: true,
};

// Cost estimates per 1k tokens (in USD)
const TOKEN_COSTS: Record<string, { input: number; output: number }> = {
	"gpt-4": { input: 0.03, output: 0.06 },
	"gpt-4-turbo": { input: 0.01, output: 0.03 },
	"gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
	"claude-3-opus": { input: 0.015, output: 0.075 },
	"claude-3-sonnet": { input: 0.003, output: 0.015 },
	"claude-3-haiku": { input: 0.00025, output: 0.00125 },
	default: { input: 0.001, output: 0.002 },
};

// =============================================================================
// Token Budget Manager
// =============================================================================

export class TokenBudgetManager {
	private state: TokenBudgetState;

	constructor(config: Partial<TokenBudgetConfig> = {}) {
		const mergedConfig = { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
		this.state = {
			config: mergedConfig,
			totalUsed: 0,
			stepUsage: new Map(),
			warningIssued: false,
			budgetExceeded: false,
			remainingBudget: mergedConfig.maxTotalTokens,
			usageHistory: [],
		};
	}

	/**
	 * Check if a step can proceed within budget.
	 */
	checkBudget(estimatedTokens: number, _stepId: string): BudgetCheckResult {
		const { config, totalUsed } = this.state;
		const effectiveBudget =
			config.maxTotalTokens - config.reserveForSynthesis;
		const remaining = effectiveBudget - totalUsed;
		const usagePercentage =
			config.maxTotalTokens > 0 ? totalUsed / config.maxTotalTokens : 0;

		// Check if budget is unlimited
		if (config.maxTotalTokens === 0) {
			return {
				allowed: true,
				remainingTokens: Number.MAX_SAFE_INTEGER,
				usagePercentage: 0,
			};
		}

		// Check per-step limit
		if (estimatedTokens > config.maxTokensPerStep) {
			return {
				allowed: config.onBudgetExceeded !== "stop",
				reason: `Estimated tokens (${estimatedTokens}) exceeds per-step limit (${config.maxTokensPerStep})`,
				remainingTokens: remaining,
				usagePercentage,
				suggestedLimit: config.maxTokensPerStep,
			};
		}

		// Check total budget
		if (totalUsed + estimatedTokens > effectiveBudget) {
			this.state.budgetExceeded = true;

			if (config.onBudgetExceeded === "stop") {
				return {
					allowed: false,
					reason: `Total budget would be exceeded (${totalUsed + estimatedTokens} > ${effectiveBudget})`,
					remainingTokens: remaining,
					usagePercentage,
				};
			}

			return {
				allowed: true,
				warning:
					"Budget will be exceeded. Consider stopping execution.",
				remainingTokens: remaining,
				usagePercentage,
				suggestedLimit: remaining,
			};
		}

		// Check warning threshold
		if (
			!this.state.warningIssued &&
			usagePercentage >= config.warningThreshold
		) {
			this.state.warningIssued = true;
			return {
				allowed: true,
				warning: `Token usage at ${(usagePercentage * 100).toFixed(1)}% of budget`,
				remainingTokens: remaining,
				usagePercentage,
			};
		}

		return {
			allowed: true,
			remainingTokens: remaining,
			usagePercentage,
		};
	}

	/**
	 * Record token usage for a step.
	 */
	recordUsage(usage: StepTokenUsage): void {
		this.state.stepUsage.set(usage.stepId, usage);
		this.state.totalUsed += usage.totalTokens;
		this.state.remainingBudget =
			this.state.config.maxTotalTokens - this.state.totalUsed;
		this.state.usageHistory.push(usage);

		logger.debug("[TokenBudget] Usage recorded", {
			stepId: usage.stepId,
			tokens: usage.totalTokens,
			totalUsed: this.state.totalUsed,
			remainingBudget: this.state.remainingBudget,
		});
	}

	/**
	 * Get adaptive budget for a step based on its importance.
	 */
	getAdaptiveBudget(
		_stepId: string,
		stepType: string,
		totalSteps: number,
		currentStepIndex: number,
	): number {
		const { config } = this.state;

		if (!config.adaptiveBudgeting || config.maxTotalTokens === 0) {
			return config.maxTokensPerStep;
		}

		const effectiveBudget =
			config.maxTotalTokens - config.reserveForSynthesis;
		const remainingSteps = totalSteps - currentStepIndex;
		const baseAllocation =
			(effectiveBudget - this.state.totalUsed) /
			Math.max(remainingSteps, 1);

		// Adjust based on step type
		const typeMultipliers: Record<string, number> = {
			research: 1.5, // Research steps may need more tokens
			generate: 1.2, // Generation is token-heavy
			verify: 0.8, // Verification is lighter
			api: 0.5, // API calls are minimal
			browser: 0.7, // Browser actions are moderate
		};

		const multiplier = typeMultipliers[stepType] || 1.0;
		const adaptiveBudget = Math.min(
			baseAllocation * multiplier,
			config.maxTokensPerStep,
		);

		return Math.floor(adaptiveBudget);
	}

	/**
	 * Get current budget state.
	 */
	getState(): Readonly<TokenBudgetState> {
		return { ...this.state };
	}

	/**
	 * Get usage summary.
	 */
	getSummary(): TokenBudgetSummary {
		const { config, totalUsed, stepUsage, usageHistory } = this.state;

		// Step breakdown
		const stepBreakdown = Array.from(stepUsage.values())
			.map((usage) => ({
				stepId: usage.stepId,
				stepType: usage.stepType,
				tokens: usage.totalTokens,
				percentage: totalUsed > 0 ? usage.totalTokens / totalUsed : 0,
			}))
			.sort((a, b) => b.tokens - a.tokens);

		// Model breakdown
		const modelMap = new Map<string, number>();
		for (const usage of usageHistory) {
			const model = usage.model || "unknown";
			modelMap.set(model, (modelMap.get(model) || 0) + usage.totalTokens);
		}
		const modelBreakdown = Array.from(modelMap.entries())
			.map(([model, tokens]) => ({
				model,
				tokens,
				percentage: totalUsed > 0 ? tokens / totalUsed : 0,
			}))
			.sort((a, b) => b.tokens - a.tokens);

		// Peak usage step
		const peakStep = stepBreakdown[0];

		// Average tokens per step
		const averageTokensPerStep =
			stepUsage.size > 0 ? totalUsed / stepUsage.size : 0;

		// Estimate cost
		const estimatedCost = this.estimateCost(usageHistory);

		return {
			totalUsed,
			totalBudget: config.maxTotalTokens,
			usagePercentage:
				config.maxTotalTokens > 0
					? totalUsed / config.maxTotalTokens
					: 0,
			stepBreakdown,
			modelBreakdown,
			peakUsageStep: peakStep?.stepId,
			averageTokensPerStep: Math.floor(averageTokensPerStep),
			estimatedCost,
		};
	}

	/**
	 * Estimate cost based on usage.
	 */
	private estimateCost(usageHistory: TokenUsage[]): number {
		let totalCost = 0;

		for (const usage of usageHistory) {
			const model = usage.model || "default";
			const costs = TOKEN_COSTS[model] || TOKEN_COSTS.default;

			totalCost +=
				(usage.promptTokens / 1000) * costs.input +
				(usage.completionTokens / 1000) * costs.output;
		}

		return Math.round(totalCost * 10000) / 10000; // Round to 4 decimal places
	}

	/**
	 * Reset the budget manager.
	 */
	reset(): void {
		this.state = {
			config: this.state.config,
			totalUsed: 0,
			stepUsage: new Map(),
			warningIssued: false,
			budgetExceeded: false,
			remainingBudget: this.state.config.maxTotalTokens,
			usageHistory: [],
		};
	}
}

// =============================================================================
// Activity Functions
// =============================================================================

// Global budget managers per execution
const executionBudgets = new Map<string, TokenBudgetManager>();

/**
 * Initialize token budget for an execution.
 */
export function initializeTokenBudgetActivity(
	executionId: string,
	config?: Partial<TokenBudgetConfig>,
): { success: boolean; config: TokenBudgetConfig } {
	const manager = new TokenBudgetManager(config);
	executionBudgets.set(executionId, manager);

	logger.info("[TokenBudget] Initialized budget for execution", {
		executionId,
		config: manager.getState().config,
	});

	return {
		success: true,
		config: manager.getState().config,
	};
}

/**
 * Check if a step can proceed within budget.
 */
export function checkTokenBudgetActivity(
	executionId: string,
	stepId: string,
	estimatedTokens: number,
): BudgetCheckResult {
	const manager = executionBudgets.get(executionId);
	if (!manager) {
		return {
			allowed: true,
			remainingTokens: Number.MAX_SAFE_INTEGER,
			usagePercentage: 0,
			warning: "No budget manager found - proceeding without limits",
		};
	}

	return manager.checkBudget(estimatedTokens, stepId);
}

/**
 * Record token usage for a step.
 */
export function recordTokenUsageActivity(
	executionId: string,
	usage: StepTokenUsage,
): { success: boolean; state: TokenBudgetState } {
	const manager = executionBudgets.get(executionId);
	if (!manager) {
		return {
			success: false,
			state: {} as TokenBudgetState,
		};
	}

	manager.recordUsage(usage);

	return {
		success: true,
		state: manager.getState(),
	};
}

/**
 * Get adaptive budget for a step.
 */
export function getAdaptiveBudgetActivity(
	executionId: string,
	stepId: string,
	stepType: string,
	totalSteps: number,
	currentStepIndex: number,
): number {
	const manager = executionBudgets.get(executionId);
	if (!manager) {
		return DEFAULT_TOKEN_BUDGET_CONFIG.maxTokensPerStep;
	}

	return manager.getAdaptiveBudget(
		stepId,
		stepType,
		totalSteps,
		currentStepIndex,
	);
}

/**
 * Get token budget summary for an execution.
 */
export function getTokenBudgetSummaryActivity(
	executionId: string,
): TokenBudgetSummary | null {
	const manager = executionBudgets.get(executionId);
	if (!manager) {
		return null;
	}

	return manager.getSummary();
}

/**
 * Cleanup token budget for completed execution.
 */
export function cleanupTokenBudgetActivity(executionId: string): void {
	executionBudgets.delete(executionId);
	logger.debug("[TokenBudget] Cleaned up budget for execution", {
		executionId,
	});
}

// =============================================================================
// Iterative Mode Budget Checking
// =============================================================================

/**
 * Iteration cost tracking for iterative execution mode
 */
export interface IterationCost {
	iteration: number;
	toolName?: string;
	inputTokens: number;
	outputTokens: number;
	timestamp?: string;
}

/**
 * Budget configuration for iterative mode
 */
export interface IterativeBudgetConfig {
	/** Maximum total tokens across all iterations (default: 100000) */
	maxTotalTokens: number;
	/** Maximum number of iterations (default: 15) */
	maxIterations: number;
}

/**
 * Result of iteration budget check
 */
export interface IterationBudgetResult {
	withinBudget: boolean;
	reason?: string;
	totalTokensUsed: number;
	iterationsUsed: number;
	remainingTokens: number;
	remainingIterations: number;
}

/**
 * Check if the iterative execution is within budget.
 *
 * This function is used by the iterative execution phase to enforce
 * cost and iteration limits during the agent loop.
 *
 * @param iterationCosts - Array of costs from previous iterations
 * @param budgetConfig - Configuration with max tokens and max iterations
 * @returns Budget check result with remaining capacity
 */
export function checkIterationBudget(
	iterationCosts: IterationCost[],
	budgetConfig: Partial<IterativeBudgetConfig> = {},
): IterationBudgetResult {
	const maxTokens = budgetConfig.maxTotalTokens ?? 200000;
	const maxIterations = budgetConfig.maxIterations ?? 25;

	const totalTokensUsed = iterationCosts.reduce(
		(sum, ic) => sum + ic.inputTokens + ic.outputTokens,
		0,
	);
	const iterationsUsed = iterationCosts.length;

	// Check token budget
	if (totalTokensUsed > maxTokens) {
		return {
			withinBudget: false,
			// Pinned to en-US rather than the host's locale. This string is
			// recorded on a run and read by whoever is working out why an agent
			// stopped, so it must not change shape with the machine that
			// produced it — a Russian-locale host formats the same number as
			// "12 000" with a narrow no-break space, which reads as a different
			// value and does not match a search for "12,000". Same convention as
			// `ai-chat-attachment.ts`, whose marker is parsed back.
			reason: `Token budget exceeded: ${totalTokensUsed.toLocaleString("en-US")}/${maxTokens.toLocaleString("en-US")} tokens used`,
			totalTokensUsed,
			iterationsUsed,
			remainingTokens: 0,
			remainingIterations: maxIterations - iterationsUsed,
		};
	}

	// Check iteration limit
	if (iterationsUsed >= maxIterations) {
		return {
			withinBudget: false,
			reason: `Iteration limit reached: ${iterationsUsed}/${maxIterations} iterations`,
			totalTokensUsed,
			iterationsUsed,
			remainingTokens: maxTokens - totalTokensUsed,
			remainingIterations: 0,
		};
	}

	return {
		withinBudget: true,
		totalTokensUsed,
		iterationsUsed,
		remainingTokens: maxTokens - totalTokensUsed,
		remainingIterations: maxIterations - iterationsUsed,
	};
}
