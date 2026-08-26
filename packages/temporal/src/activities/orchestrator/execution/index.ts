/**
 * Execution Module
 *
 * Handles step execution, MCP tool execution, agent-as-tool execution,
 * and strategy-based plan execution.
 *
 * The step execution system uses a modular handler architecture:
 * - handlers/ - Capability-specific step handlers
 * - context/ - Execution context building and tool loading
 */

// Conversation Compaction (mid-execution history summarization)
export {
	type CompactConversationInput,
	type CompactConversationResult,
	compactConversationHistoryActivity,
} from "./compact-conversation";
// Context and tool loading exports
export {
	buildExecutionContext,
	extractArtifactsFromResults,
	filterToolsByRiskLevel,
	filterToolsByStepEntity,
	formatDate,
	formatItem,
	formatListResponse,
	formatToolResultsAsDirectResponse,
	inferItemType,
	loadMcpTools,
} from "./context";
export { executeAgentAsTool } from "./execute-agent-as-tool";
export { executeMcpTool } from "./execute-mcp-tool";
export type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./execute-step";
export { executeStep } from "./execute-step";
// Handler system exports
export {
	AgentHandler,
	FabricAiHandler,
	getDefaultHandlerRegistry,
	HandlerRegistry,
	LlmHandler,
	McpToolHandler,
	WebHandler,
	WorkflowHandler,
} from "./handlers";
// Phase 2: Recovery Management
export {
	type AttemptRecord,
	classifyFailure,
	// Activity wrappers for Temporal workflow compatibility
	classifyFailureActivity,
	createCheckpoint,
	type ExecutionCheckpoint,
	type FailureClassification,
	type FailureType,
	formatRecoveryError,
	getRecoveryStrategies,
	getRetryDelay,
	getRetryDelayActivity,
	type RecoveryAction,
	type RecoveryContext,
	type RecoveryDecision,
	type RecoveryStrategy,
	restoreFromCheckpoint,
	selectRecoveryStrategy,
	shouldRetry,
	shouldRetryActivity,
} from "./recovery-manager";
// Iterative Agent Execution
export {
	type AgentIterationResult,
	type AgentToolCall,
	type RunAgentIterationInput,
	runAgentIteration,
} from "./run-agent-iteration";
export {
	type ExecuteStrategyInput,
	type ExecuteStrategyOutput,
	executeDirectStrategy,
	executeStrategy,
	type PhaseResult,
} from "./strategy-executor";
// Large Tool Result Summarization
export { summarizeLargeToolResult } from "./summarize-tool-result";
// Token Budget Enforcement
export {
	type BudgetCheckResult,
	checkIterationBudget,
	checkTokenBudgetActivity,
	cleanupTokenBudgetActivity,
	DEFAULT_TOKEN_BUDGET_CONFIG,
	getAdaptiveBudgetActivity,
	getTokenBudgetSummaryActivity,
	type IterationBudgetResult,
	type IterationCost,
	type IterativeBudgetConfig,
	initializeTokenBudgetActivity,
	recordTokenUsageActivity,
	type StepTokenUsage,
	type TokenBudgetConfig,
	TokenBudgetManager,
	type TokenBudgetState,
	type TokenBudgetSummary,
	type TokenUsage,
} from "./token-budget";
// Destructive Operation Verification (legacy)
export {
	createRetryStep,
	extractEntityType as extractEntityTypeDestructive,
	extractExpectedCountFromContext,
	findVerificationTool,
	isBulkOperation,
	isDestructiveStep,
	type VerificationInput,
	type VerificationResult,
	verifyDestructiveOperation,
} from "./verify-destructive-operation";
// Generic Operation Verification (new comprehensive system)
export {
	detectOperationType,
	detectOperationTypeFromTool,
	extractCountFromResult,
	extractEntityType,
	extractTargetEntityName,
	isEmptyOrNotFound,
	isSpecificItemOperation,
	type OperationType,
	type VerificationInput as GenericVerificationInput,
	type VerificationResult as GenericVerificationResult,
	verifyOperation,
} from "./verify-operation";
