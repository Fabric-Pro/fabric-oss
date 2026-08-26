/**
 * Context Module
 *
 * Handles context analysis, synthesis, and management for the orchestrator.
 * This module enables intelligent pre-planning research and context flow
 * between execution phases.
 */

export { analyzeContextRequirements } from "./analyze-requirements";
export {
	addResearchResults,
	createContextBag,
	formatContextForDelegation,
	getRelevantContext,
	hasResearch,
	hasSynthesizedContext,
	setSynthesizedContext,
	updateContextBag,
} from "./context-bag";
// Phase 4.3: Context Summarization for Long Executions
export {
	// Classes
	ContextSummarizer,
	type ContextWindow,
	checkContextBudgetActivity,
	contextSummarizer,
	// Constants
	DEFAULT_STRATEGY,
	estimateStepTokens,
	estimateStepTokensActivity,
	// Functions
	estimateTokens,
	IncrementalSummarizer,
	type SummarizationResult,
	type SummarizationStrategy,
	// Activity functions
	summarizeContextActivity,
	// Types
	type TrajectoryStep,
} from "./context-summarizer";
export { synthesizeContext } from "./synthesize-context";
// Variable Extraction
export {
	DEFAULT_EXTRACTION_PATTERNS,
	type ExtractedVariable,
	type ExtractionConfig,
	type ExtractionPattern,
	extractVariablesFromOutput,
	mergeVariables,
	toAgentVariables,
} from "./variable-extractor";
