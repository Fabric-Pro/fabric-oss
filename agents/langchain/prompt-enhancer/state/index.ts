/**
 * Prompt Enhancer State Module
 *
 * Defines the LangGraph state annotation for the Prompt Enhancer Agent.
 * Compatible with AG-UI protocol for predictive state updates.
 */

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { reasoningByTurnAnnotation } from "@repo/agent-core/reasoning-trace";
import type {
	EnhancementType,
	PromptCategory,
	PromptFormat,
} from "../types.js";

/**
 * Prompt Enhancer State Annotation
 *
 * State structure for prompt enhancement with predictive updates.
 */
export const PromptEnhancerState = Annotation.Root({
	/**
	 * ID of the prompt being enhanced
	 */
	promptId: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * Name of the prompt
	 */
	promptName: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * Description of the prompt
	 */
	promptDescription: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Format of the prompt (PLAIN_TEXT, MARKDOWN, etc.)
	 */
	format: Annotation<PromptFormat>({
		reducer: (x, y) => y ?? x,
		default: () => "PLAIN_TEXT",
	}),

	/**
	 * Category of the prompt
	 */
	category: Annotation<PromptCategory | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Tags associated with the prompt
	 */
	tags: Annotation<string[]>({
		reducer: (x, y) => y ?? x,
		default: () => [],
	}),

	/**
	 * Current content of the prompt
	 */
	currentContent: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * Type of enhancement to apply
	 */
	enhancementType: Annotation<EnhancementType>({
		reducer: (x, y) => y ?? x,
		default: () => "general",
	}),

	/**
	 * User instructions for enhancement
	 */
	userInstructions: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Enhanced content output
	 */
	enhancedContent: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * Explanation of changes made
	 */
	explanation: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * Streaming content for predictive updates
	 */
	streamingContent: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * Focus anchor for cursor positioning
	 */
	focusAnchor: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Retry count for error recovery
	 */
	retryCount: Annotation<number>({
		reducer: (x, y) => y ?? x,
		default: () => 0,
	}),

	/**
	 * Error message if any
	 */
	error: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Per-turn reasoning trace ("Thinking · X.Ys" UI affordance). Populated
	 * by enhance-node.ts via buildReasoningUpdate from
	 * @repo/agent-core/reasoning-trace when the bound model emits Anthropic
	 * thinking blocks, OpenAI reasoning blocks, or Vercel Gateway
	 * raw_response reasoning. Keyed by turnIndex (= count of human messages
	 * preceding the assistant turn). Ephemeral — reset with conversation.
	 *
	 * Only the main enhancement invocation emits. The post-confirmation
	 * branch (acknowledgment after Accept/Reject) does not invoke the model
	 * so it does not emit reasoning.
	 */
	reasoningByTurn: reasoningByTurnAnnotation(),

	// Inherit message handling from MessagesAnnotation
	...MessagesAnnotation.spec,
});

/**
 * Type for the Prompt Enhancer state
 */
export type PromptEnhancerStateType = typeof PromptEnhancerState.State;
