/**
 * Reasoning Module
 *
 * Provides configurable reasoning modes (lite/balanced/deep) for AI agents.
 */

export type {
	ReasoningInput,
	ReasoningNodeOptions,
	ReasoningOutput,
} from "./reasoning-node";
export {
	createReasoningNode,
	suggestReasoningMode,
} from "./reasoning-node";
export type {
	ReasoningMode,
	ReasoningModeConfig,
	ReasoningState,
	ReasoningStep,
} from "./types";
export {
	addReasoningStep,
	BALANCED_MODE_CONFIG,
	createInitialReasoningState,
	DEEP_MODE_CONFIG,
	DEFAULT_REASONING_MODE,
	getReasoningModeConfig,
	LITE_MODE_CONFIG,
	REASONING_MODE_CONFIGS,
} from "./types";
