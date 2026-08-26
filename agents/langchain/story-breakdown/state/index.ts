/**
 * Story Breakdown State Module
 *
 * Defines the LangGraph state annotation for the Story Breakdown Agent.
 * Compatible with AG-UI protocol for predictive state updates.
 */

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { reasoningByTurnAnnotation } from "@repo/agent-core/reasoning-trace";

/**
 * Story Breakdown State Annotation
 *
 * State structure for breaking down PRDs into features.
 */
export const StoryBreakdownState = Annotation.Root({
	// Inherit message handling from MessagesAnnotation
	...MessagesAnnotation.spec,

	/**
	 * Project name for context
	 */
	projectName: Annotation<string>,

	/**
	 * Optional project description
	 */
	projectDescription: Annotation<string | undefined>,

	/**
	 * PRD content to break down
	 */
	prdContent: Annotation<string>,

	/**
	 * Optional custom system prompt from Prompt Library
	 */
	systemPrompt: Annotation<string | undefined>,

	/**
	 * CopilotKit tools available to the agent
	 */
	tools: Annotation<any[]>({
		reducer: (x, y) => y ?? x,
		default: () => [],
	}),

	/**
	 * Output document (AG-UI protocol requires this for predictive updates)
	 */
	document: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Focus anchor for cursor positioning
	 */
	focusAnchor: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Error message if any
	 */
	error: Annotation<string | undefined>({
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

	// Per-turn reasoning trace ("Thinking · X.Ys" UI affordance). Populated
	// by breakdown-node.ts via buildReasoningUpdate from @repo/agent-core/reasoning-trace
	// when the bound model emits Anthropic thinking blocks, OpenAI reasoning
	// blocks, or Vercel Gateway raw_response reasoning. Keyed by turnIndex
	// (= count of human messages preceding the assistant turn). Ephemeral.
	reasoningByTurn: reasoningByTurnAnnotation(),
});

/**
 * Type for the Story Breakdown state
 */
export type StoryBreakdownStateType = typeof StoryBreakdownState.State;
