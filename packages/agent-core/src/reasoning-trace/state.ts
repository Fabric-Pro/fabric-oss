import { Annotation } from "@langchain/langgraph";

export type ReasoningTurnEntry = {
	text: string;
	durationMs: number;
	startedAt: number;
	completedAt: number;
};

/**
 * Factory for the `reasoningByTurn` LangGraph state annotation.
 *
 * The reducer overwrites a single key at a time — the chat-node coalesces
 * with prior in-turn reasoning text BEFORE writing so continuity within
 * the same turn isn't lost. See {@link buildReasoningUpdate} for the
 * coalescing logic.
 *
 * Ephemeral by design: lives only in in-memory LangGraph state and is reset
 * on conversation reload along with the rest of the agent's state.
 *
 * Usage:
 *   import { reasoningByTurnAnnotation } from "@repo/agent-core/reasoning-trace";
 *
 *   export const MyAgentStateAnnotation = Annotation.Root({
 *     ...MessagesAnnotation.spec,
 *     reasoningByTurn: reasoningByTurnAnnotation(),
 *   });
 */
export function reasoningByTurnAnnotation() {
	return Annotation<Record<number, ReasoningTurnEntry>>({
		reducer: (existing, incoming) => ({
			...(existing ?? {}),
			...(incoming ?? {}),
		}),
		default: () => ({}),
	});
}
