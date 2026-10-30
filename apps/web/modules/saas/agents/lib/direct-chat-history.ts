import type {
	DirectStreamMessage,
	StreamModelInfo,
	StreamStatus,
	TokenUsage,
} from "../hooks/useDirectStream";
import { parseTurnTruncation } from "./chat-turn-truncation";
import { parseChatGptPlanApiBilling } from "./chatgpt-plan-api-billing";
import {
	dropDuplicatedOperationResults,
	settleUnfinishedToolCalls,
} from "./direct-chat-turns";
import {
	type PersistedToolCallStatus,
	persistedToToolCallStatus,
} from "./tool-call-status";

/** A saved conversation message, as far as the Direct chat reads it back. */
export interface PersistedDirectMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
		result?: string;
		status?: PersistedToolCallStatus;
	}>;
	metadata?: Record<string, unknown>;
	streamStatus?: StreamStatus;
	cancelledAt?: string;
	reasoningText?: string;
	reasoningDurationMs?: number;
}

/**
 * A saved conversation as the Direct chat shows it when it is opened again.
 *
 * The workflow also records each finished turn as a "SYSTEM" operation-result
 * row; beside the saved answer it is a duplicate bubble and duplicated history
 * (review F33), so it is dropped.
 */
export function loadedDirectMessages(
	messages: readonly PersistedDirectMessage[],
): DirectStreamMessage[] {
	return dropDuplicatedOperationResults([...messages]).map((msg) => ({
		id: msg.id,
		// Conversations persist a third role — `system`, written
		// by `agents.conversations.recordOperationResult` — that
		// the chat API does not accept. Casting it through left
		// it in the outgoing `history`, and the route rejected
		// the whole request, so one operation-result row made a
		// thread permanently unusable ("Invalid request body").
		role: msg.role === "user" ? "user" : "assistant",
		timestamp: new Date(msg.timestamp),
		// A saved turn is over: a call it recorded as still
		// pending/running can never resolve (review F11).
		toolCalls: settleUnfinishedToolCalls(
			msg.toolCalls?.map((tc) => ({
				id: tc.id,
				name: tc.name,
				args: tc.args,
				result: tc.result,
				status: persistedToToolCallStatus(tc.status ?? "pending"),
			})),
		),
		// Carry persisted stream lifecycle through rehydration so
		// the inline `Stopped` caption survives a page reload
		// (spec § 5.1 / AC-5).
		streamStatus: msg.streamStatus,
		cancelledAt: msg.cancelledAt,
		// Carry reasoning trace through rehydration so the
		// "Thought for X.Ys" header renders correctly after reload.
		reasoningText: msg.reasoningText,
		reasoningDurationMs: msg.reasoningDurationMs,
		// Persisted with the assistant message on save.
		usage: readPersistedUsage(persistedMetadata(msg)),
		model: readPersistedModel(persistedMetadata(msg)),
		// `content`, plus the failure / tools-off-retry state.
		...readPersistedTurnOutcome(msg),
	}));
}

/**
 * The conversation API's message type does not declare `metadata`, though
 * the row carries it (the add-message schema accepts it). Read it loosely.
 */
function persistedMetadata(
	message: unknown,
): Record<string, unknown> | undefined {
	const metadata = (message as { metadata?: unknown } | null)?.metadata;
	return metadata && typeof metadata === "object"
		? (metadata as Record<string, unknown>)
		: undefined;
}

/**
 * The failure and tools-off-retry state saved with an assistant turn. Before
 * this was persisted, a reload rendered a failed turn as a normal bubble —
 * the partial preamble read as a finished answer (review F22).
 */
function readPersistedTurnOutcome(message: {
	content: string;
	streamStatus?: string;
}): Pick<
	DirectStreamMessage,
	| "content"
	| "isError"
	| "errorMessage"
	| "limit"
	| "toolsFailed"
	| "truncated"
	| "apiBilling"
> {
	const metadata = persistedMetadata(message);
	const toolsFailed =
		metadata?.toolsFailed && typeof metadata.toolsFailed === "object"
			? (metadata.toolsFailed as DirectStreamMessage["toolsFailed"])
			: undefined;
	const truncated = parseTurnTruncation(metadata?.truncated);
	const apiBilling = parseChatGptPlanApiBilling(metadata?.apiBilling);
	if (message.streamStatus !== "error") {
		return {
			content: message.content,
			...(toolsFailed ? { toolsFailed } : {}),
			...(truncated ? { truncated } : {}),
			...(apiBilling ? { apiBilling } : {}),
		};
	}
	const errorMessage =
		typeof metadata?.errorMessage === "string"
			? metadata.errorMessage
			: message.content.replace(/^error:\s*/i, "");
	const limit =
		metadata?.limit &&
		typeof (metadata.limit as { kind?: unknown }).kind === "string"
			? (metadata.limit as DirectStreamMessage["limit"])
			: undefined;
	return {
		// The body stored for a failure with no partial answer is the error
		// itself; showing it twice would repeat the card.
		content:
			message.content === `Error: ${errorMessage}` ||
			message.content.replace(/^error:\s*/i, "") === errorMessage
				? ""
				: message.content,
		isError: true,
		errorMessage,
		...(limit ? { limit } : {}),
		...(toolsFailed ? { toolsFailed } : {}),
		// A partial error can share its turn with these; the live chat shows
		// them beside the error, so a reload must too (Fizzy #3273).
		...(truncated ? { truncated } : {}),
		...(apiBilling ? { apiBilling } : {}),
	};
}

function readPersistedUsage(
	metadata: Record<string, unknown> | undefined,
): TokenUsage | undefined {
	const usage = metadata?.usage;
	if (!usage || typeof usage !== "object") {
		return undefined;
	}
	const u = usage as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" ? v : undefined);
	return {
		inputTokens: num(u.inputTokens),
		outputTokens: num(u.outputTokens),
		totalTokens: num(u.totalTokens),
		reasoningTokens: num(u.reasoningTokens),
		cachedInputTokens: num(u.cachedInputTokens),
	};
}

export function readPersistedModel(
	metadata: Record<string, unknown> | undefined,
): StreamModelInfo | undefined {
	const model = metadata?.model;
	if (!model || typeof model !== "object") {
		return undefined;
	}
	const m = model as Record<string, unknown>;
	if (
		typeof m.id !== "string" ||
		!m.id.trim() ||
		["canonicalName", "provider"].some(
			(key) => m[key] !== undefined && typeof m[key] !== "string",
		) ||
		(m.viaPlan !== undefined && typeof m.viaPlan !== "boolean") ||
		(m.contextWindow !== undefined &&
			(typeof m.contextWindow !== "number" ||
				!Number.isFinite(m.contextWindow)))
	) {
		return undefined;
	}
	return {
		id: m.id,
		viaPlan: typeof m.viaPlan === "boolean" ? m.viaPlan : undefined,
		canonicalName:
			typeof m.canonicalName === "string" ? m.canonicalName : undefined,
		provider: typeof m.provider === "string" ? m.provider : undefined,
		contextWindow:
			typeof m.contextWindow === "number" ? m.contextWindow : undefined,
	};
}
