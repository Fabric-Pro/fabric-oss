import type {
	DirectStreamMessage,
	StreamModelInfo,
	TokenUsage,
} from "../hooks/useDirectStream";
import { parseTurnTruncation } from "./chat-turn-truncation";
import { parseChatGptPlanApiBilling } from "./chatgpt-plan-api-billing";

/**
 * The conversation API's message type does not declare `metadata`, though
 * the row carries it (the add-message schema accepts it). Read it loosely.
 */
export function persistedMetadata(
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
export function readPersistedTurnOutcome(message: {
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

export function readPersistedUsage(
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
