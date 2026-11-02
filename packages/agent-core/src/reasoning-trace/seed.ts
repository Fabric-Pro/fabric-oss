import { readMessageRole } from "../message-shape";
import { countHumanMessages } from "./extract";
import type { ReasoningTurnEntry } from "./state";

export function isPlainTraceMap(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

// Raw LangChain JSON wraps fields in kwargs. Read its role in the same
// form as graph messages before applying the shared human-turn counter.
function traceMessage(message: unknown): unknown {
	if (
		!isPlainTraceMap(message) ||
		message.lc !== 1 ||
		message.type !== "constructor" ||
		!Array.isArray(message.id) ||
		!isPlainTraceMap(message.kwargs)
	) {
		return message;
	}
	const types: Record<string, string> = {
		HumanMessage: "human",
		AIMessage: "ai",
		ToolMessage: "tool",
		SystemMessage: "system",
	};
	const type = types[String(message.id.at(-1))];
	return type ? { ...message.kwargs, type } : message;
}

// Only a tool-result tail continues the current user turn. A user/assistant
// tail starts a fresh attempt, including Regenerate's truncated transcript.
export function pickTraceState<T = unknown>(
	state: unknown,
	messages: unknown,
): {
	reasoningByTurn?: Record<number, ReasoningTurnEntry>;
	toolCallsByTurn?: Record<number, T[]>;
} {
	if (!isPlainTraceMap(state)) {
		return {};
	}
	const history = Array.isArray(messages) ? messages.map(traceMessage) : [];
	const turn = countHumanMessages(history);
	const followUp = turn > 0 && readMessageRole(history.at(-1)) === "tool";
	const pickMap = (value: unknown) =>
		isPlainTraceMap(value)
			? Object.fromEntries(
					Object.entries(value).filter(
						([key]) => followUp || key !== String(turn),
					),
				)
			: undefined;
	const reasoningByTurn = pickMap(state.reasoningByTurn);
	const toolCallsByTurn = pickMap(state.toolCallsByTurn);
	return {
		...(reasoningByTurn
			? {
					reasoningByTurn: reasoningByTurn as Record<
						number,
						ReasoningTurnEntry
					>,
				}
			: {}),
		...(toolCallsByTurn
			? { toolCallsByTurn: toolCallsByTurn as Record<number, T[]> }
			: {}),
	};
}
