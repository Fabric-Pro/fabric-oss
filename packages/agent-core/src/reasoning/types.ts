/**
 * Reasoning Modes Types
 *
 * Configurable reasoning levels for AI agents inspired by CUGA's
 * lite/balanced/deep reasoning modes.
 */

/**
 * Available reasoning modes
 */
export type ReasoningMode = "lite" | "balanced" | "deep";

/**
 * Configuration for a specific reasoning mode
 */
export interface ReasoningModeConfig {
	/** Mode identifier */
	mode: ReasoningMode;
	/** Human-readable description */
	description: string;
	/** Model temperature (lower = more deterministic) */
	temperature: number;
	/** Maximum tokens for response */
	maxTokens: number;
	/** Number of reflection iterations */
	reflectionIterations: number;
	/** Whether to enable self-correction */
	selfCorrection: boolean;
	/** Whether to enable chain-of-thought reasoning */
	chainOfThought: boolean;
	/** Whether to enable step-by-step verification */
	stepVerification: boolean;
	/** Timeout multiplier (1.0 = base timeout) */
	timeoutMultiplier: number;
	/** Quality threshold for reflection (0-100) */
	qualityThreshold: number;
	/** Whether to include detailed reasoning trace */
	includeTrace: boolean;
	/** Preferred model override (optional) */
	preferredModel?: string;
}

/**
 * Lite mode: Fast, minimal reasoning
 * Best for: Simple queries, quick lookups, straightforward tasks
 */
export const LITE_MODE_CONFIG: ReasoningModeConfig = {
	mode: "lite",
	description:
		"Fast mode with minimal reasoning - best for simple, straightforward tasks",
	temperature: 0.3,
	maxTokens: 2048,
	reflectionIterations: 0,
	selfCorrection: false,
	chainOfThought: false,
	stepVerification: false,
	timeoutMultiplier: 0.5,
	qualityThreshold: 50,
	includeTrace: false,
};

/**
 * Balanced mode: Default reasoning level
 * Best for: Most tasks, good balance of speed and quality
 */
export const BALANCED_MODE_CONFIG: ReasoningModeConfig = {
	mode: "balanced",
	description: "Balanced mode with moderate reasoning - best for most tasks",
	temperature: 0.5,
	maxTokens: 4096,
	reflectionIterations: 1,
	selfCorrection: true,
	chainOfThought: true,
	stepVerification: false,
	timeoutMultiplier: 1.0,
	qualityThreshold: 70,
	includeTrace: false,
};

/**
 * Deep mode: Extended thinking with thorough verification
 * Best for: Complex problems, critical decisions, code generation
 */
export const DEEP_MODE_CONFIG: ReasoningModeConfig = {
	mode: "deep",
	description:
		"Deep mode with extended reasoning - best for complex problems requiring thorough analysis",
	temperature: 0.2,
	maxTokens: 8192,
	reflectionIterations: 3,
	selfCorrection: true,
	chainOfThought: true,
	stepVerification: true,
	timeoutMultiplier: 2.0,
	qualityThreshold: 85,
	includeTrace: true,
	preferredModel: "gpt-4o", // Use more capable model for deep reasoning
};

/**
 * Map of all reasoning mode configurations
 */
export const REASONING_MODE_CONFIGS: Record<
	ReasoningMode,
	ReasoningModeConfig
> = {
	lite: LITE_MODE_CONFIG,
	balanced: BALANCED_MODE_CONFIG,
	deep: DEEP_MODE_CONFIG,
};

/**
 * Default reasoning mode
 */
export const DEFAULT_REASONING_MODE: ReasoningMode = "balanced";

/**
 * Get configuration for a reasoning mode
 */
export function getReasoningModeConfig(
	mode: ReasoningMode,
): ReasoningModeConfig {
	return REASONING_MODE_CONFIGS[mode] || BALANCED_MODE_CONFIG;
}

/**
 * Reasoning state to be added to agent state
 */
export interface ReasoningState {
	/** Current reasoning mode */
	reasoningMode: ReasoningMode;
	/** Current iteration in deep reasoning */
	reasoningIteration: number;
	/** Reasoning trace (for deep mode) */
	reasoningTrace: ReasoningStep[];
	/** Whether reasoning is complete */
	reasoningComplete: boolean;
}

/**
 * A single step in the reasoning trace
 */
export interface ReasoningStep {
	/** Step number */
	step: number;
	/** Type of reasoning step */
	type: "think" | "verify" | "reflect" | "correct" | "conclude";
	/** Content of this reasoning step */
	content: string;
	/** Confidence score (0-100) */
	confidence: number;
	/** Timestamp */
	timestamp: number;
}

/**
 * Create initial reasoning state
 */
export function createInitialReasoningState(
	mode: ReasoningMode = DEFAULT_REASONING_MODE,
): ReasoningState {
	return {
		reasoningMode: mode,
		reasoningIteration: 0,
		reasoningTrace: [],
		reasoningComplete: false,
	};
}

/**
 * Add a step to the reasoning trace
 */
export function addReasoningStep(
	state: ReasoningState,
	type: ReasoningStep["type"],
	content: string,
	confidence: number,
): ReasoningState {
	const newStep: ReasoningStep = {
		step: state.reasoningTrace.length + 1,
		type,
		content,
		confidence,
		timestamp: Date.now(),
	};

	return {
		...state,
		reasoningTrace: [...state.reasoningTrace, newStep],
	};
}
