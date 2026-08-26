/**
 * Document Evaluation Activities
 *
 * Temporal activities for evaluating documents using Mastra-powered evaluations.
 *
 * Main workflow activity:
 * - The documentEvalWorkflow (in workflows/document-eval.ts) is the primary entry point
 * - It orchestrates NLP metrics, LLM metrics, and storage activities
 *
 * Standalone activity (for direct use):
 * - evaluateDocumentWithMastra: Legacy comprehensive evaluation in a single activity
 *
 * Features:
 * - NLP-based metrics: completeness, similarity, keywords, structure
 * - LLM-based metrics: quality, coherence, alignment (when model available)
 * - Hybrid scoring: combines NLP (35-45%) + LLM (55-65%) scores (document-type specific)
 * - Golden reference comparison
 * - Cost tracking for LLM evaluations
 * - Evaluation caching for performance
 */

export { isOverBudget, recordEvalCost } from "./cost-tracker";
export { generateContentHash, getCachedEval } from "./eval-cache";
// Storage activities (for workflow orchestration)
export {
	type CheckEvalCacheInput,
	type CheckEvalCacheOutput,
	checkEvalCache,
	type GetGoldenReferenceInput,
	type GetGoldenReferenceOutput,
	getGoldenReference,
	type LLMScores,
	type NLPScores,
	type SaveEvalResultInput,
	type SaveEvalResultOutput,
	saveEvalResult,
} from "./eval-storage";
export { resolveEvalModel, toMastraModelConfig } from "./mastra-config";
export type { MastraEvalInput, MastraEvalResult } from "./mastra-evaluate";
// Legacy activity (for backwards compatibility)
export { evaluateDocumentWithMastra } from "./mastra-evaluate";
// LLM metric activities
export {
	type LLMEvalResult,
	type RunLLMMetricsWorkflowInput,
	runLLMMetrics,
	runLLMMetricsActivity,
} from "./mastra-llm-metrics";
// NLP metric activities (for workflow use)
export { runNLPMetrics } from "./mastra-nlp-metrics";
