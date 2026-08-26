/**
 * Limit Configuration
 *
 * Token budgets, step limits, and context size limits.
 */

/**
 * Token limits for various operations.
 */
export const TOKEN_LIMITS = {
	/** Maximum tokens for context window */
	MAX_CONTEXT_TOKENS: 32_000,
	/** Approximate characters per token */
	CHARS_PER_TOKEN: 4,
	/** Maximum context size in characters */
	MAX_CONTEXT_CHARS: 32_000 * 4, // 128K chars
	/** Maximum tokens per step */
	MAX_TOKENS_PER_STEP: 8_000,
	/** Reserved tokens for system prompt */
	SYSTEM_PROMPT_RESERVE: 2_000,
	/** Reserved tokens for tool definitions */
	TOOL_DEFINITIONS_RESERVE: 4_000,
} as const;

/**
 * Step limits for execution.
 */
export const STEP_LIMITS = {
	/** Maximum steps in a task plan */
	MAX_PLAN_STEPS: 20,
	/** Maximum LLM generation steps per execution */
	MAX_LLM_STEPS_FAST: 5,
	MAX_LLM_STEPS_BALANCED: 8,
	MAX_LLM_STEPS_ACCURATE: 12,
	/** Maximum retry attempts per step */
	MAX_RETRIES_FAST: 1,
	MAX_RETRIES_BALANCED: 2,
	MAX_RETRIES_ACCURATE: 3,
	/** Maximum bulk operation items */
	MAX_BULK_ITEMS: 50,
} as const;

/**
 * Context size limits.
 */
export const CONTEXT_LIMITS = {
	/** Maximum previous step results to include in context */
	MAX_PREVIOUS_STEPS: 10,
	/** Maximum length of truncated step response */
	MAX_STEP_RESPONSE_LENGTH: 2_000,
	/** Maximum cached tool results to include */
	MAX_CACHED_RESULTS: 5,
	/** Maximum conversation history entries */
	MAX_HISTORY_ENTRIES: 20,
} as const;
