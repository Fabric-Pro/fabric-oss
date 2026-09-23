import type { UiMode } from "@repo/database";

/**
 * Which engine answers a chat on the unified interface (Fizzy #2040).
 *
 * `research` is the Deep Research workflow, `orchestrator` the Temporal
 * orchestrator and `direct` the single-model Direct chat.
 */
export type ChatEngine = "direct" | "orchestrator" | "research";

export interface ChatEngineInput {
	uiMode: UiMode;
	/** The Orchestrator tab choice. Only consulted for a new advanced chat. */
	useOrchestrator: boolean;
	/** The Research tab choice. Only consulted for a new advanced chat. */
	deepResearch: boolean;
	/**
	 * The engine recorded in the open conversation's metadata, or `null` when
	 * no conversation is open (a new chat).
	 */
	conversationEngine: ChatEngine | null;
	/** An agent-instance chat (`?instanceId=`). */
	isAgentInstance: boolean;
}

/**
 * Agent-instance chats always run Direct: the instance's own instructions
 * drive tool selection from the first model call.
 *
 * An open conversation stays on the engine it was recorded with. Each engine
 * only knows how to hydrate its own threads, so opening a Direct thread on the
 * Orchestrator renders it blank — and the Orchestrator's persist effect would
 * then rewrite its metadata. The one exception is Research in simple mode:
 * simple mode offers no Research surface, and the Deep Research view cannot
 * replay a stored thread anyway, so such a thread opens on Direct, which
 * renders its stored messages.
 *
 * A new chat in simple mode runs the Orchestrator (its `iterative` preset is
 * applied by the caller). In advanced mode it follows the user's engine tab.
 */
export function resolveChatEngine(input: ChatEngineInput): ChatEngine {
	if (input.isAgentInstance) {
		return "direct";
	}

	if (input.conversationEngine) {
		if (
			input.conversationEngine === "research" &&
			input.uiMode === "simple"
		) {
			return "direct";
		}
		return input.conversationEngine;
	}

	if (input.uiMode === "simple") {
		return "orchestrator";
	}
	if (input.deepResearch) {
		return "research";
	}
	return input.useOrchestrator ? "orchestrator" : "direct";
}

/**
 * The engine a stored conversation was created on, read from its metadata.
 * A conversation without a recognised `mode` predates the field and was a
 * Direct thread, so it records as `direct`.
 */
export function conversationEngineFromMetadata(metadata: unknown): ChatEngine {
	const mode =
		metadata && typeof metadata === "object"
			? (metadata as { mode?: unknown }).mode
			: undefined;
	if (mode === "orchestrator" || mode === "research") {
		return mode;
	}
	return "direct";
}
