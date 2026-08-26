/**
 * Reasoning-trace module.
 *
 * Shared extraction + emission helpers for surfacing model reasoning text
 * ("Thinking · X.Ys" UI affordance) across LangGraph agents. Promoted from
 * the inline implementation in
 * `agents/langchain/project-document-generator/nodes/chat-node-reasoning.ts`
 * so future bugfixes (new converter shapes, gateway normalization changes)
 * land in one place.
 *
 * Distinct from the unrelated `@repo/agent-core/reasoning` module which
 * provides reasoning-mode helpers (lite/balanced/deep planning depth).
 */

export type {
	BuildReasoningUpdateArgs,
	ReasoningByTurnUpdate,
} from "./emit";
export {
	buildReasoningUpdate,
	stripRawResponseEnvelope,
} from "./emit";
export {
	countHumanMessages,
	extractReasoningFromContent,
	extractReasoningFromMessage,
	extractReasoningTokens,
	extractTextFromContent,
	isHumanMessage,
} from "./extract";
export type { ReasoningTurnEntry } from "./state";
export { reasoningByTurnAnnotation } from "./state";
