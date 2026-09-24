/**
 * Pure helpers for the Direct chat turn lifecycle: settling tool cards when a
 * turn ends, trimming the history a turn sends, dropping the duplicate
 * operation-result rows a reload would otherwise show, and telling a
 * conversation switch apart from the chat's own URL write.
 *
 * Each one fixes a defect found reviewing the Direct engine (Fizzy #2040).
 */

const UNFINISHED_TOOL_CALL_ERROR =
	"This tool call did not finish before the turn ended.";

/**
 * A turn that ended — failed, or closed without a result for some call —
 * leaves no way for a pending/running card to resolve. Rendered as-is it is a
 * spinner that never stops, and persisted as-is it survives a reload (F11).
 */
export function settleUnfinishedToolCalls<
	T extends { status: string; error?: string },
>(
	toolCalls: T[] | undefined,
	reason = UNFINISHED_TOOL_CALL_ERROR,
): T[] | undefined {
	if (
		!toolCalls?.some(
			(tc) => tc.status === "pending" || tc.status === "running",
		)
	) {
		return toolCalls;
	}
	return toolCalls.map((tc) =>
		tc.status === "pending" || tc.status === "running"
			? ({ ...tc, status: "error", error: tc.error ?? reason } as T)
			: tc,
	);
}

/**
 * Index of the tool card an event belongs to. By id: the route sends the id
 * on every event, and matching by name as well let the first result of a
 * repeated tool (two `project_rag_query` calls) overwrite both cards (F12).
 * By name only when the event carries no id and exactly one card of that
 * name is still open, so there is no ambiguity about which one it means.
 */
export function findToolCallIndex(
	toolCalls: ReadonlyArray<{ id: string; name: string; status: string }>,
	event: { toolCallId?: string; toolName?: string },
): number {
	if (event.toolCallId) {
		return toolCalls.findIndex((tc) => tc.id === event.toolCallId);
	}
	if (!event.toolName) {
		return -1;
	}
	const open = toolCalls
		.map((tc, index) => ({ tc, index }))
		.filter(
			({ tc }) =>
				tc.name === event.toolName &&
				(tc.status === "pending" || tc.status === "running"),
		);
	return open.length === 1 ? open[0].index : -1;
}

/**
 * The stream route keeps the most recent `DIRECT_HISTORY_MAX_ENTRIES` entries
 * and bounds each at `DIRECT_HISTORY_MAX_ENTRY_CHARS`
 * (`app/api/agents/fabric-ai/stream/history-window.ts`). The client used to
 * send the whole thread, so from roughly the hundredth exchange every send
 * came back "Invalid request body" and the conversation was dead (F32).
 */
const DIRECT_HISTORY_MAX_ENTRIES = 200;
const DIRECT_HISTORY_MAX_ENTRY_CHARS = 200_000;
// Whole-history budget, well under a serverless request-body limit.
const DIRECT_HISTORY_MAX_TOTAL_CHARS = 1_000_000;

export function trimHistoryForRequest<
	T extends { role: string; content: string },
>(history: T[]): T[] {
	// Context rows the thread opens with stay pinned to the front.
	let pinnedCount = 0;
	while (
		pinnedCount < history.length &&
		history[pinnedCount].role === "system"
	) {
		pinnedCount++;
	}
	const pinned = history.slice(0, pinnedCount);
	const rest = history.slice(pinnedCount);
	const budget = Math.max(0, DIRECT_HISTORY_MAX_ENTRIES - pinned.length);
	let window = rest.length > budget ? rest.slice(rest.length - budget) : rest;
	if (window.length < rest.length) {
		// Start the window on a question, not on half an exchange.
		const firstUser = window.findIndex((entry) => entry.role === "user");
		window = firstUser > 0 ? window.slice(firstUser) : window;
	}
	const clipped = [...pinned, ...window].map((entry) =>
		entry.content.length > DIRECT_HISTORY_MAX_ENTRY_CHARS
			? {
					...entry,
					content: entry.content.slice(
						0,
						DIRECT_HISTORY_MAX_ENTRY_CHARS,
					),
				}
			: entry,
	);
	// Oldest unpinned entries go first until the whole payload fits.
	let total = clipped.reduce((sum, entry) => sum + entry.content.length, 0);
	let dropFrom = pinned.length;
	while (
		total > DIRECT_HISTORY_MAX_TOTAL_CHARS &&
		dropFrom < clipped.length - 1
	) {
		total -= clipped[dropFrom].content.length;
		dropFrom++;
	}
	while (
		dropFrom > pinned.length &&
		dropFrom < clipped.length - 1 &&
		clipped[dropFrom].role !== "user"
	) {
		dropFrom++;
	}
	return [...clipped.slice(0, pinned.length), ...clipped.slice(dropFrom)];
}

interface PersistedTurnMessage {
	role: string;
	metadata?: unknown;
}

function isOperationResult(message: PersistedTurnMessage): boolean {
	const metadata = message.metadata as { kind?: unknown } | null | undefined;
	return message.role === "system" && metadata?.kind === "operation_result";
}

/**
 * The Direct workflow records every turn it finishes as a `system`
 * operation-result row, and the browser separately saves the real assistant
 * message. Rehydrated together, each answer was followed by a "SYSTEM" bubble
 * repeating it, which also went back to the model as history (F33).
 *
 * The row is dropped only when the same exchange (user message to next user
 * message) already has a real assistant reply. When it has none — the tab
 * closed or the route timed out before the browser could save — the row is
 * the only record of the answer, so it stays.
 */
export function dropDuplicatedOperationResults<T extends PersistedTurnMessage>(
	messages: T[],
): T[] {
	const keep = messages.map(() => true);
	let segmentStart = 0;
	const closeSegment = (end: number) => {
		const segment = messages.slice(segmentStart, end);
		const hasReply = segment.some(
			(m) => m.role === "assistant" && !isOperationResult(m),
		);
		if (hasReply) {
			for (let i = segmentStart; i < end; i++) {
				if (isOperationResult(messages[i])) {
					keep[i] = false;
				}
			}
		}
	};
	messages.forEach((message, index) => {
		if (message.role === "user" && index > segmentStart) {
			closeSegment(index);
			segmentStart = index;
		}
	});
	closeSegment(messages.length);
	return messages.filter((_, index) => keep[index]);
}

/**
 * Whether a new `activeConversationId` is the user opening a different
 * conversation, as opposed to the chat's own create being written back into
 * the URL. Only the former may replace a thread that has turns in this mount;
 * treating both as "keep the stream" left conversation A on screen while
 * saves and the next send went to B (F27).
 */
export function isConversationSwitch(params: {
	externalConversationId: string | null | undefined;
	currentConversationId: string | null;
	ownCreatedConversationId: string | null;
}): boolean {
	const {
		externalConversationId,
		currentConversationId,
		ownCreatedConversationId,
	} = params;
	if (!externalConversationId) {
		return false;
	}
	return (
		externalConversationId !== currentConversationId &&
		externalConversationId !== ownCreatedConversationId
	);
}
