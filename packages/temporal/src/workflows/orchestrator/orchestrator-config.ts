/**
 * Orchestrator Configuration
 *
 * Centralized configuration constants for the orchestrator workflow.
 * All tunable parameters are defined here to avoid magic numbers scattered
 * across workflow phases.
 *
 * Issue #7: Centralize magic numbers into config
 */

// =============================================================================
// Circuit Breaker
// =============================================================================

export const CIRCUIT_BREAKER = {
	/** Number of consecutive failures required to open the circuit */
	failureThreshold: 3,
	/** Number of failures tolerated in HALF_OPEN state before re-opening */
	halfOpenMaxFailures: 1,
	/** Cooldown duration before transitioning from OPEN → HALF_OPEN */
	cooldownMs: 60_000,
} as const;

// =============================================================================
// Context Management
// =============================================================================

export const CONTEXT = {
	/** Summarize context every N completed trajectory steps */
	summarizeEveryNSteps: 5,
	/** Number of recent steps to keep with full detail in context */
	recentStepsFull: 3,
	/** Maximum token budget for formatted step context (approx 4 chars/token) */
	maxContextTokens: 32_000,
	charsPerToken: 4,
} as const;

/** Derived constant: max chars for context */
export const MAX_CONTEXT_CHARS =
	CONTEXT.maxContextTokens * CONTEXT.charsPerToken;

// =============================================================================
// Tool Results & Pruning
// =============================================================================

export const TOOL_RESULTS = {
	/** Max characters per tool result before LLM summarization */
	maxChars: 12_000,
	/** Don't prune results smaller than this */
	pruneMinChars: 500,
	/** Max chars for the pruned result placeholder */
	prunedPlaceholderMax: 300,
	/** Number of recent iterations whose tool results are kept in full */
	recentIterationsToKeep: 2,
} as const;

/**
 * How focused-agent preloaded tools get exposed to the LLM.
 *
 * Each tool whose inputSchema rides along in the `tools` parameter costs
 * ~440 input tokens per iteration (typical for Azure DevOps / GitHub MCP
 * servers). With a 110-tool preload that's ~48K tokens *per iteration* —
 * observed in a production workflow run
 * (2026-04-29), where iterations consumed ~55K input tokens and the 500K
 * budget was exhausted after only 9 iterations of trivial repo browsing.
 *
 * Two modes:
 *   • Eager (preloaded count ≤ `eagerLoadThreshold`): attach every tool's
 *     full inputSchema to the `tools` parameter so the model can call
 *     directly. Cheaper than a search_tools roundtrip when the catalog is
 *     small.
 *   • Stub-catalog (count > threshold): inject a name+description list into
 *     the system prompt; do NOT ship inputSchemas. The model uses
 *     search_tools to load schemas on demand. Each call is one round-trip
 *     but the per-iteration overhead drops by 10–20×.
 *
 * 30 is empirically the inflection point: below it, eager beats stub-catalog
 * even on iteration 1 (~13K tokens vs. one ~5K-token search_tools call); at
 * 30+ tools, stub-catalog wins from the start and the gap widens with each
 * iteration.
 */
export const TOOLS = {
	/** Below this count, attach every preloaded tool's inputSchema eagerly. */
	eagerLoadThreshold: 30,
} as const;

// =============================================================================
// Budget & Token Limits
// =============================================================================

export const BUDGET = {
	/** Fraction of effective budget at which the LLM gets a "wrap up" warning */
	warningThreshold: 0.85,
	/** Tokens reserved for the final synthesis call when budget is exceeded */
	synthesisReserveTokens: 8_000,
	/** Iterations reserved for synthesis (prevents iteration count from blocking it) */
	synthesisIterationReserve: 1,
	/** Default max iterations for iterative mode */
	defaultMaxIterations: 25,
	/** Default max total tokens for iterative mode */
	defaultMaxTotalTokens: 200_000,
	/** Default max steps per iteration in iterative mode */
	defaultMaxStepsPerIteration: 3,
	/** Reduced steps per iteration when approaching budget limit */
	budgetWarningStepsPerIteration: 1,
} as const;

/**
 * Conversation compaction — proactive mid-execution history summarization.
 *
 * Once cumulative token usage crosses `triggerThresholdPct` of the budget,
 * older turns in `iterativeConversationHistory` are replaced with a single
 * "PROGRESS SO FAR" summary block. Buys ~7–15 more iterations on long runs
 * (each compacted iteration sends ~10–20K fewer input tokens) at the cost
 * of one ~5K-token summarization call per compaction cycle.
 */
export const COMPACTION = {
	/** Budget percentage (0–100) at which compaction first fires */
	triggerThresholdPct: 70,
	/**
	 * Minimum iterations between compactions. Prevents thrashing once we're
	 * sustainably above the threshold.
	 */
	cooldownIterations: 3,
	/**
	 * Number of most-recent turns to keep verbatim. Older turns are folded
	 * into the summary block. The original user message at index 0 is
	 * always preserved separately.
	 */
	keepRecentTurns: 6,
	/**
	 * Below this many compactable turns, compaction is a no-op. Compacting
	 * a tiny set of old turns saves negligible tokens vs. the cost of the
	 * summarization call itself.
	 */
	minTurnsToCompact: 4,
	/** Hard cap on summary output (~1500 words) */
	maxSummaryTokens: 4_000,
} as const;

// =============================================================================
// Trajectory & Replay
// =============================================================================

export const TRAJECTORY = {
	/** Minimum success rate to reuse a trajectory */
	reuseMinSuccessRate: 0.8,
} as const;

// =============================================================================
// Workflow Execution
// =============================================================================

export const WORKFLOW = {
	/** After this many completed steps, issue a continueAsNew */
	continueAsNewStepThreshold: 50,
	/** Maximum retry attempts for step recovery */
	maxRecoveryRetries: 2,
	/** Max retry delay cap in ms */
	maxRetryDelayMs: 10_000,
} as const;

// =============================================================================
// Output Truncation (Temporal 2MB payload limit)
// =============================================================================

export const OUTPUT = {
	/** Maximum size for individual result fields */
	maxResultSize: 5_000,
	/** Maximum size for artifact content */
	maxArtifactSize: 8_000,
	/** Maximum number of tool calls in output */
	maxToolCalls: 50,
	/** Maximum number of step results in output */
	maxStepResults: 20,
	/** Maximum number of artifacts in output */
	maxArtifacts: 30,
	/** Maximum response length */
	maxResponseLength: 50_000,
	/** Maximum key output items extracted from a step */
	maxKeyOutputItems: 10,
} as const;
