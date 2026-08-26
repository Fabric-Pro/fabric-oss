import type { DirectStreamToolCall } from "../hooks/useDirectStream";

/**
 * Status as carried inside `ConversationMessage.toolCalls` when a turn is
 * written to the conversation row (see
 * `apps/web/modules/saas/agents/hooks/useConversationHistory.ts` and the
 * matching zod schema on the API side).
 */
export type PersistedToolCallStatus =
	| "pending"
	| "running"
	| "success"
	| "error";

/**
 * Map a live `DirectStreamToolCall.status` to the status carried in the
 * persisted conversation row.
 *
 * Critical for F-1171: `"error"` must be preserved end-to-end so the reasoning
 * trace can surface failed tool calls after a page reload. An earlier
 * implementation collapsed any non-(complete|running) status into `"pending"`,
 * which made historical failures render as live spinners.
 */
export function toolCallToPersistedStatus(
	status: DirectStreamToolCall["status"],
): PersistedToolCallStatus {
	switch (status) {
		case "complete":
			return "success";
		case "error":
			return "error";
		case "running":
			return "running";
		case "pending":
			return "pending";
	}
}

/**
 * Inverse of `toolCallToPersistedStatus` — used when rehydrating persisted
 * conversation messages back into `DirectStreamMessage` shape on page reload.
 */
export function persistedToToolCallStatus(
	status: PersistedToolCallStatus,
): DirectStreamToolCall["status"] {
	switch (status) {
		case "success":
			return "complete";
		case "error":
			return "error";
		case "running":
			return "running";
		case "pending":
			return "pending";
	}
}
