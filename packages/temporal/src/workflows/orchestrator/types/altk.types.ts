/**
 * ALTK Types
 *
 * Agent Lifecycle Toolkit configuration types.
 * Controls reasoning quality, tool invocation, output guardrails, and reflection.
 */

// =============================================================================
// ALTK Configuration
// =============================================================================

export interface ALTKConfig {
	/** Enable reasoning quality checks */
	reasoningQuality: {
		enabled: boolean;
		/** Minimum confidence threshold */
		minConfidence: number;
		/** Enable chain-of-thought validation */
		validateChainOfThought: boolean;
	};
	/** Enable tool invocation error reduction */
	toolInvocation: {
		enabled: boolean;
		/** Validate tool inputs before execution */
		validateInputs: boolean;
		/** Retry with different parameters on failure */
		smartRetry: boolean;
		/** Maximum retry attempts */
		maxRetries: number;
	};
	/** Enable output guardrails */
	outputGuardrails: {
		enabled: boolean;
		/** Check for PII in outputs */
		piiDetection: boolean;
		/** Check for sensitive data */
		sensitiveDataDetection: boolean;
		/** Validate output format */
		formatValidation: boolean;
		/** Custom validation rules */
		customRules: string[];
	};
	/** Enable reflection/self-evaluation */
	reflection: {
		enabled: boolean;
		/** Reflect after each step */
		afterEachStep: boolean;
		/** Reflect on final output */
		onFinalOutput: boolean;
		/** Auto-correct on reflection failure */
		autoCorrect: boolean;
	};
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_ALTK_CONFIG: ALTKConfig = {
	reasoningQuality: {
		enabled: true,
		minConfidence: 0.7,
		validateChainOfThought: true,
	},
	toolInvocation: {
		enabled: true,
		validateInputs: true,
		smartRetry: true,
		maxRetries: 3,
	},
	outputGuardrails: {
		enabled: true,
		piiDetection: true,
		sensitiveDataDetection: true,
		formatValidation: true,
		customRules: [],
	},
	reflection: {
		enabled: true,
		afterEachStep: false, // Only in accurate mode
		onFinalOutput: true,
		autoCorrect: true,
	},
};
