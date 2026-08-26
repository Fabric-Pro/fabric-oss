/**
 * Centralized AI Model Configuration
 *
 * This file defines all AI model configurations in a single place.
 * When adding new providers or models, update this file only.
 *
 * Model Selection Strategy:
 * - Complex tasks (document generation, analysis): Use larger, more capable models
 * - Simple tasks (title generation, summarization): Use faster, smaller models
 * - Reasoning tasks: Use specialized reasoning models
 * - Image generation: Use DALL-E or other image models
 *
 * All models are routed through Vercel AI Gateway for:
 * - Centralized monitoring and cost tracking
 * - Rate limiting and provider fallbacks
 * - Unified API across multiple providers
 */

/**
 * Supported AI Providers
 * Add new providers here when integrating with new AI services
 */
export const AI_PROVIDERS = {
	OPENAI: "openai",
	ANTHROPIC: "anthropic",
	DEEPSEEK: "deepseek",
	GROQ: "groq",
} as const;

export type AIProvider = (typeof AI_PROVIDERS)[keyof typeof AI_PROVIDERS];

/**
 * Task types for model selection
 */
export type AITaskType =
	| "simple" // Fast, lightweight tasks (title generation, summarization)
	| "complex" // Document generation, detailed analysis
	| "reasoning" // Tasks requiring deep reasoning
	| "chat" // Interactive chat
	| "tool_calling" // Tasks requiring function/tool calling (orchestrator, agents)
	| "embedding" // Text embeddings
	| "image" // Image generation
	| "audio"; // Audio transcription

/**
 * Model Configuration
 */
export interface ModelConfig {
	/** Model ID in gateway format (provider/model) */
	id: string;
	/** Human-readable name */
	name: string;
	/** Provider */
	provider: AIProvider;
	/** Task types this model is suitable for */
	taskTypes: AITaskType[];
	/** Description */
	description?: string;
	/** Maximum tokens (context window) */
	maxTokens?: number;
	/** Whether this is a default model for its task type */
	isDefault?: boolean;
}

// DEFAULT_MODELS removed - use getConfiguredModelString() from dynamic-model-selector.ts instead

// GROQ_MODELS removed - use getActiveModels() from @repo/database instead
// getDefaultModelForTask() removed - use getConfiguredModelString() instead
// getModelsForTask() removed - use getModelsForTask() from @repo/database instead
