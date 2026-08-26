/**
 * Document Generator State Module
 *
 * Defines the LangGraph state annotation for the Document Generator Agent.
 * Compatible with AG-UI protocol for predictive state updates.
 */

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { reasoningByTurnAnnotation } from "@repo/agent-core/reasoning-trace";
import type { DocumentType, ProjectContext } from "@repo/agent-types";

/**
 * Document Generator State Annotation
 *
 * State structure for document generation with predictive updates.
 * Supports project context and RAG contexts for improved document quality.
 */
export const AgentStateAnnotation = Annotation.Root({
	/**
	 * The document content being generated/edited
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
	 * Type of document being generated
	 */
	documentType: Annotation<DocumentType>({
		reducer: (x, y) => y ?? x,
		default: () => "general",
	}),

	/**
	 * Project context information (optional)
	 * Provides project details like name, tech stack, and features for context-aware generation
	 */
	projectContext: Annotation<ProjectContext | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * RAG contexts for document generation (optional)
	 * Retrieved contexts from knowledge base to improve accuracy and consistency
	 */
	ragContexts: Annotation<string[]>({
		reducer: (x, y) => y ?? x,
		default: () => [],
	}),

	/**
	 * Optional custom system prompt from Prompt Library
	 */
	systemPrompt: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * CopilotKit tools available to the agent
	 */
	tools: Annotation<any[]>(),

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
	// by chat-node.ts via buildReasoningUpdate from @repo/agent-core/reasoning-trace
	// when the bound model emits Anthropic thinking blocks, OpenAI reasoning
	// blocks, or Vercel Gateway raw_response reasoning. Keyed by turnIndex
	// (= count of human messages preceding the assistant turn). Ephemeral.
	reasoningByTurn: reasoningByTurnAnnotation(),

	// Inherit message handling from MessagesAnnotation
	...MessagesAnnotation.spec,
});

/**
 * Type for the Document Generator state
 */
export type AgentState = typeof AgentStateAnnotation.State;
