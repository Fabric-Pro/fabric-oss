/**
 * Reflection Node Types
 *
 * Types for the reusable reflection module that enables LangGraph agents
 * to self-evaluate and correct their outputs.
 */

/**
 * Quality dimension for evaluation
 */
export type QualityDimension =
	| "accuracy"
	| "completeness"
	| "relevance"
	| "coherence"
	| "safety"
	| "format"
	| "custom";

/**
 * Evaluation result for a single dimension
 */
export interface DimensionEvaluation {
	dimension: QualityDimension;
	score: number; // 0-100
	feedback: string;
	suggestions: string[];
}

/**
 * Overall reflection result
 */
export interface ReflectionResult {
	/** Whether the output passes quality threshold */
	passed: boolean;
	/** Overall confidence score (0-100) */
	overallScore: number;
	/** Individual dimension evaluations */
	evaluations: DimensionEvaluation[];
	/** Summary of issues found */
	issues: string[];
	/** Suggested improvements */
	improvements: string[];
	/** Number of reflection iterations performed */
	iterationCount: number;
	/** Whether max iterations was reached */
	maxIterationsReached: boolean;
}

/**
 * Configuration for reflection node
 */
export interface ReflectionConfig {
	/** Model to use for reflection (defaults to same as agent) */
	model?: string;
	/** Temperature for reflection model (lower = more consistent) */
	temperature?: number;
	/** Minimum score to pass (0-100, default: 70) */
	passThreshold?: number;
	/** Maximum reflection iterations (default: 3) */
	maxIterations?: number;
	/** Dimensions to evaluate */
	dimensions?: QualityDimension[];
	/** Custom evaluation criteria */
	customCriteria?: string;
	/** Whether to include detailed feedback */
	verbose?: boolean;
	/** Timeout per reflection call in ms */
	timeout?: number;
}

/**
 * Default reflection configuration
 */
export const DEFAULT_REFLECTION_CONFIG: Required<ReflectionConfig> = {
	model: "gpt-4o-mini",
	temperature: 0.1,
	passThreshold: 70,
	maxIterations: 3,
	dimensions: ["accuracy", "completeness", "relevance", "coherence"],
	customCriteria: "",
	verbose: false,
	timeout: 30000,
};

/**
 * State required for reflection
 */
export interface ReflectionState {
	/** The output to evaluate */
	outputToEvaluate: string;
	/** Original input/context for evaluation */
	originalInput: string;
	/** Expected output format or criteria */
	expectedFormat?: string;
	/** Current reflection result */
	reflectionResult?: ReflectionResult;
	/** Current iteration count */
	reflectionIteration: number;
	/** Whether reflection is complete */
	reflectionComplete: boolean;
}

/**
 * Reflection node input
 */
export interface ReflectionInput {
	output: string;
	input: string;
	context?: string;
	expectedFormat?: string;
}

/**
 * Reflection node output
 */
export interface ReflectionOutput {
	result: ReflectionResult;
	correctedOutput?: string;
	shouldRetry: boolean;
}
