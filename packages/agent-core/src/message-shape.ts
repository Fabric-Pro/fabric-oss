/**
 * Conversation-shape invariants every agent's message history must satisfy
 * before it reaches an Anthropic-backed provider.
 *
 * ## Why this is shared rather than per-agent
 *
 * Each agent grew its own `sanitizeMessagesForModel`, and all six can emit the
 * same invalid tail. The rule they violate is not a quirk of one graph — it is
 * a property of the model:
 *
 *   > This model does not support assistant message prefill.
 *   > The conversation must end with a user message.
 *
 * Claude enforces it wherever it is served (Databricks, Bedrock, Anthropic
 * direct), so the check belongs next to the other cross-agent provider
 * compatibility code, not copied into six graphs that will drift.
 *
 * ## How the bad tail is produced
 *
 * Nothing writes a trailing assistant turn deliberately. The sanitizers strip
 * tool results whose `tool_use` was lost (a CopilotKit round-trip, a reducer,
 * an aborted run), and stripping the results that followed the final assistant
 * turn leaves that turn last. Observed in production on 2026-08-06: the
 * sanitizer logged `inputCount: 13, outputCount: 10` and the surviving shape
 * ended `…,'human','human','ai'`. Every model call on that thread then failed
 * with a 400 until the user typed again, which is the "the chat died" report.
 */

import { type BaseMessage, HumanMessage } from "@langchain/core/messages";

/**
 * Normalized role for a message that may arrive as a LangChain class instance,
 * an AG-UI `type`-tagged object, or an OpenAI `role`-tagged wire object
 * round-tripped through CopilotKit. Mirrors each agent's local `getMessageType`
 * so a shared check reads the same roles the agent-local passes do.
 */
export function readMessageRole(message: unknown): string | undefined {
	const m = message as {
		_getType?: () => string;
		type?: unknown;
		role?: unknown;
	};
	if (typeof m?._getType === "function") {
		return m._getType();
	}
	if (typeof m?.type === "string") {
		return m.type;
	}
	if (typeof m?.role === "string") {
		if (m.role === "user") {
			return "human";
		}
		if (m.role === "assistant") {
			return "ai";
		}
		return m.role;
	}
	return undefined;
}

/**
 * True when `messages` ends on an assistant turn — the shape Claude refuses.
 * An empty array is reported as valid: "nothing to send" is a different problem
 * and belongs to the caller, not to this check.
 */
export function endsOnAssistantTurn(messages: BaseMessage[]): boolean {
	if (messages.length === 0) {
		return false;
	}
	return readMessageRole(messages[messages.length - 1]) === "ai";
}

/**
 * Drop trailing assistant turns so the history ends on a user (or tool) turn.
 *
 * Dropping — rather than appending a synthetic user turn — is what the provider
 * semantics call for. A trailing assistant turn reaching here is one of:
 *
 *   - an orphaned tool-calling turn whose results were just stripped, so its
 *     text is a partial preamble the model regenerates on this very call; or
 *   - a completed answer with no new user input after it, in which case there
 *     is nothing for the model to respond to and the call should not be
 *     happening at all.
 *
 * In both cases the turn carries no instruction the model needs, and appending
 * a fabricated user message would put words in the user's mouth that persist in
 * the transcript. The loop runs to fixpoint because stripping one assistant
 * turn can expose another beneath it.
 *
 * Returns the same array instance when nothing needed removing, so callers can
 * cheaply detect a no-op.
 */
export function dropTrailingAssistantTurns(
	messages: BaseMessage[],
): BaseMessage[] {
	let end = messages.length;
	while (end > 0 && readMessageRole(messages[end - 1]) === "ai") {
		end--;
	}
	return end === messages.length ? messages : messages.slice(0, end);
}

/**
 * Last-resort user turn for a history that contains none.
 *
 * Deliberately generic. The tempting alternative — reusing the dropped
 * assistant text as the user turn — puts the model's own words in the user's
 * mouth, and the model then answers as though the user had asked for whatever
 * it last said. A neutral continuation prompt keeps the request valid without
 * fabricating intent.
 */
const CONTINUATION_TURN_CONTENT = "Please continue.";

/**
 * Shape a sanitized history into something a Claude-backed provider will
 * accept: no trailing assistant turn, and never empty.
 *
 * `dropTrailingAssistantTurns` alone is not sufficient. A history that
 * sanitizes down to assistant turns *only* drops to `[]`, and an empty
 * `messages` array is itself a 400 ("at least one message is required") — the
 * same class of failure, moved one step later. That is unreachable for an
 * ordinary chat (the user has to say something to start one, and the
 * sanitizers convert tool results into user turns), but the agents are also
 * invoked with programmatically constructed histories, so the guard is cheap
 * next to another silent provider rejection.
 *
 * Returns the count actually dropped so callers can log it without recomputing
 * against their own pre-shape array.
 */
export function shapeHistoryForModel(messages: BaseMessage[]): {
	messages: BaseMessage[];
	dropped: number;
} {
	const shaped = dropTrailingAssistantTurns(messages);
	const dropped = messages.length - shaped.length;

	if (shaped.length === 0 && messages.length > 0) {
		return {
			messages: [
				new HumanMessage({ content: CONTINUATION_TURN_CONTENT }),
			],
			dropped,
		};
	}

	return { messages: shaped, dropped };
}
