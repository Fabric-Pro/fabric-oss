import {
	ChatEventReplayError,
	type ConversationEventScope,
	hasConversationTurnReplayGap,
	readConversationTurnEvents,
} from "@repo/database";
import type { ChatExecutionEvent } from "@repo/temporal";
import type { ChatEventCursor } from "@repo/utils/chat-event-cursor";
import {
	type OrchestratorStreamInput,
	parseOrchestratorStreamEvent,
} from "../orchestrator-stream-protocol";

/** Preserve the cause of a replay authorization lookup for access classification. */
export class ChatReplayAuthorizationError extends Error {
	constructor(cause: unknown) {
		super(
			cause instanceof Error
				? cause.message
				: "Replay authorization unavailable",
			{ cause },
		);
	}
}

/** One journal entry maps to one SSE event, so acknowledging it is atomic. */
export function projectChatReplayEvent(
	event: ChatExecutionEvent,
): OrchestratorStreamInput | null {
	switch (event.event) {
		case "execution.replay_unavailable":
			return { type: "replay_unavailable" };
		case "execution.text_delta":
			return { type: "text_delta", content: event.data.text };
		case "execution.iteration_start":
			return { type: "text_start", iteration: event.data.iteration };
		case "execution.limit_signal":
			return { type: "limit_signal", signal: event.data };
		case "execution.context_compacted":
			return { type: "context_compacted", ...event.data };
		case "execution.tool_start":
		case "execution.tool_input":
		case "execution.tool_complete": {
			const tool = event.data.toolCall;
			return {
				type:
					event.event === "execution.tool_start"
						? "tool_start"
						: event.event === "execution.tool_input"
							? "tool_input"
							: "tool_result",
				toolCallId: tool.id,
				toolName: tool.name,
				args: tool.args,
				result: tool.result,
				status: tool.status,
				serverName: tool.serverName,
				error: tool.error,
				durationMs: tool.durationMs,
				mcpAppResourceUri: tool.mcpAppResourceUri,
				mcpAppConfigId: tool.mcpAppConfigId,
			};
		}
		default:
			return null;
	}
}

export function createServerChatReplay(input: {
	scope: ConversationEventScope;
	after?: ChatEventCursor;
	send: (event: OrchestratorStreamInput) => void;
	isClosed: () => boolean;
	authorize?: () => Promise<void>;
	validateIntegrity?: () => Promise<void>;
}) {
	let after = input.after;
	const fullReplay = !input.after;
	let delivered = false;
	let lastAuthorization = 0;
	const authorize = async () => {
		if (input.authorize && Date.now() - lastAuthorization >= 5000) {
			try {
				await input.authorize();
			} catch (error) {
				if (error instanceof ChatEventReplayError) {
					throw error;
				}
				throw new ChatReplayAuthorizationError(error);
			}
			lastAuthorization = Date.now();
		}
	};
	const drain = async () => {
		// The caller drains again after observing terminal workflow status.
		// Serialize wakeups with polling so a cursor is never delivered twice.
		while (!input.isClosed()) {
			await authorize();
			if (
				fullReplay &&
				!delivered &&
				(await hasConversationTurnReplayGap(input.scope))
			) {
				throw new ChatEventReplayError("Replay output is incomplete");
			}
			const rows = await readConversationTurnEvents({
				scope: input.scope,
				after,
			});
			await authorize();
			if (rows.length > 0) {
				await input.validateIntegrity?.();
			}
			for (const row of rows) {
				if (input.isClosed()) {
					return;
				}
				const projected = projectChatReplayEvent(
					row as ChatExecutionEvent,
				);
				if (!projected) {
					throw new ChatEventReplayError(
						"Unsupported chat replay event",
					);
				}
				if (projected.type === "replay_unavailable") {
					throw new ChatEventReplayError(
						"Replay output is incomplete",
					);
				}
				const event = parseOrchestratorStreamEvent({
					...projected,
					eventCursor: row.cursor,
				});
				if (!event) {
					throw new ChatEventReplayError("Invalid chat replay event");
				}
				input.send(event);
				delivered = true;
				after = row.cursor;
			}
			if (rows.length < 200) {
				return;
			}
		}
	};
	let pending = Promise.resolve();
	return () => {
		pending = pending.then(drain, drain);
		return pending;
	};
}
