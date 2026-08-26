/**
 * LimitSignal — cross-cutting domain type that describes an AI token/budget
 * exhaustion event detected anywhere in the stack (internal orchestrator
 * budget, LLM provider rate limits, quota exhaustion, context-length errors).
 *
 * Produced by `classifyLimitError()` and propagated through:
 *   - Temporal activity return values (run-agent-iteration)
 *   - Workflow output (OrchestratorWorkflowOutput.limitSignals)
 *   - SSE events (event: limit_signal)
 *   - Streaming chat onError handlers (AiChat, AgentBuilderSidekick)
 *
 * The UI branches on `kind` (+ billing permission) to pick copy and actions.
 */

export type LimitKind =
	| "internal_budget"
	| "provider_quota"
	| "provider_rate_limit"
	| "context_length"
	| "provider_overloaded";

export interface TokenBudgetStatus {
	used: number;
	total: number;
	usagePercentage: number;
	warning?: string;
	estimatedCost?: number;
}

export interface LimitSignal {
	kind: LimitKind;
	/** Provider slug when known: "openai" | "anthropic" | "azure" | "groq" | etc. */
	provider?: string;
	/** Sanitized message suitable for internal logging (not raw shown to end user). */
	message: string;
	/** Retry hint in milliseconds when the provider supplies a Retry-After header. */
	retryAfterMs?: number;
	/** Populated only when kind === "internal_budget". */
	budget?: TokenBudgetStatus;
}
