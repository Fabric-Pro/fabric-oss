/**
 * Learning Module Exports
 *
 * Phase 5: Advanced Learning
 * - Tool Usage Learning (5.1) - Both in-memory and persistent (Qdrant)
 * - Execution Pattern Recognition (5.2)
 * - Negative Memory (5.3)
 */

// Negative Memory (Phase 5.3)
export {
	classifyErrorType,
	createNegativeMemoryManager,
	type FailureCluster,
	type FailureContext,
	type FailureQuery,
	type FailureRecord,
	type FailureResolution,
	generateFailureWarnings,
	InMemoryNegativeMemoryStore,
	NegativeMemoryManager,
	type SimilarFailure,
} from "./negative-memory";
// Execution Pattern Recognition (Phase 5.2)
export {
	createPatternRecognizer,
	type ExecutionMetrics,
	type ExecutionPattern,
	type ExecutionRecord,
	type ExecutionSignature,
	type ExecutionStepSummary,
	generateExecutionSignature,
	InMemoryPatternStore,
	type OptimizationSuggestion,
	optimizationToString,
	type PatternMatch,
	type PatternOptimization,
	PatternRecognizer,
} from "./pattern-recognition";
// Tool Usage Learning (Phase 5.1) - Persistent (Qdrant)
export {
	getToolPatternActivity,
	QdrantToolUsageStore,
	queryToolLearningsActivity,
	recordToolUsageActivity,
	searchSimilarToolContextsActivity,
} from "./qdrant-tool-store";
// Tool Usage Learning (Phase 5.1) - In-Memory
export {
	type ArgumentSuggestion,
	createToolUsageTracker,
	type ErrorPattern,
	InMemoryToolUsageStore,
	injectLearningsIntoPrompt,
	type SuccessfulCallPattern,
	type ToolCallRecord,
	type ToolHint,
	type ToolLearningQuery,
	type ToolLearningResult,
	type ToolUsagePattern,
	type ToolUsageStats,
	ToolUsageTracker,
} from "./tool-usage-learning";
