/**
 * Execution Mode Types
 *
 * Defines execution modes and their configurations for the orchestrator.
 * Modes control task decomposition, reflection, retries, and timeouts.
 */

// =============================================================================
// Execution Modes
// =============================================================================

export type ExecutionMode =
	| "fast"
	| "balanced"
	| "accurate"
	| "save_reuse"
	| "iterative"
	| "weave";

export interface ExecutionModeConfig {
	mode: ExecutionMode;
	/** Enable task decomposition into subtasks (not used in iterative mode) */
	taskDecomposition: boolean;
	/** Enable reflection/self-evaluation after each step */
	reflection: boolean;
	/** Enable detailed reasoning thoughts */
	detailedThoughts: boolean;
	/** Maximum retry attempts per step */
	maxRetries: number;
	/** Step timeout in milliseconds */
	stepTimeoutMs: number;
	/** Overall workflow timeout in milliseconds */
	workflowTimeoutMs: number;
	/** Maximum iterations for iterative mode */
	maxIterations?: number;
	/** Iteration timeout in milliseconds (for iterative mode) */
	iterationTimeoutMs?: number;
	/** Maximum total tokens for iterative mode (cost control) */
	maxTotalTokens?: number;
}

export const EXECUTION_MODE_CONFIGS: Record<
	ExecutionMode,
	ExecutionModeConfig
> = {
	fast: {
		mode: "fast",
		taskDecomposition: false,
		reflection: false,
		detailedThoughts: false,
		maxRetries: 1,
		stepTimeoutMs: 30000,
		workflowTimeoutMs: 300000, // 5 minutes
		// Iterative settings: Quick execution, fewer iterations
		maxIterations: 5,
		iterationTimeoutMs: 60000, // 1 minute per iteration
		maxTotalTokens: 250000,
	},
	balanced: {
		mode: "balanced",
		taskDecomposition: true,
		reflection: true,
		detailedThoughts: false,
		maxRetries: 2,
		stepTimeoutMs: 60000,
		workflowTimeoutMs: 600000, // 10 minutes
		// Iterative settings: Moderate limits
		maxIterations: 15,
		iterationTimeoutMs: 120000, // 2 minutes per iteration
		maxTotalTokens: 500000,
	},
	accurate: {
		mode: "accurate",
		taskDecomposition: true,
		reflection: true,
		detailedThoughts: true,
		maxRetries: 3,
		stepTimeoutMs: 120000,
		workflowTimeoutMs: 1800000, // 30 minutes
		// Iterative settings: Thorough execution, more iterations allowed
		maxIterations: 30,
		iterationTimeoutMs: 180000, // 3 minutes per iteration
		maxTotalTokens: 1000000,
	},
	save_reuse: {
		mode: "save_reuse",
		taskDecomposition: true,
		reflection: true,
		detailedThoughts: false,
		maxRetries: 2,
		stepTimeoutMs: 60000,
		workflowTimeoutMs: 600000,
		// Iterative settings: Same as balanced
		maxIterations: 15,
		iterationTimeoutMs: 120000,
		maxTotalTokens: 500000,
	},
	iterative: {
		mode: "iterative",
		taskDecomposition: false, // Not used - LLM decides each step
		reflection: false, // Reflection happens naturally in the loop
		detailedThoughts: true,
		maxRetries: 2,
		stepTimeoutMs: 60000,
		workflowTimeoutMs: 900000, // 15 minutes - longer for discovery tasks
		maxIterations: 15, // Safety limit
		iterationTimeoutMs: 120000, // 2 minutes per iteration
		maxTotalTokens: 500000, // Cost control
	},
	weave: {
		mode: "weave",
		taskDecomposition: true, // Plan is pre-built from WeavePlan checkboxes
		reflection: true,
		detailedThoughts: false,
		maxRetries: 2,
		stepTimeoutMs: 720000, // 12 minutes per step — Shuttle CodingRun bridge polls up to 10 min
		workflowTimeoutMs: 1800000, // 30 minutes — multi-agent plans take time
		maxIterations: 50, // Weave plans can have many checkboxes
		iterationTimeoutMs: 120000,
		maxTotalTokens: 1000000,
	},
};
