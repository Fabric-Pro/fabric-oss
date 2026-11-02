import {
	type ChatEventCursor,
	sameChatEventLog,
} from "@repo/utils/chat-event-cursor";
import { ChatStreamProtocolError } from "./chat-stream-protocol";

/** Advance only after the consumer applied the event; snapshot events have no cursor. */
export function createChatEventReplay(initial?: ChatEventCursor) {
	let cursor = initial;
	let enabled = true;
	return {
		get enabled() {
			return enabled;
		},
		disable() {
			enabled = false;
			cursor = undefined;
		},
		get cursor() {
			return cursor;
		},
		accept(next: ChatEventCursor | undefined) {
			if (!next) {
				return true;
			}
			if (cursor && !sameChatEventLog(cursor, next)) {
				throw new ChatStreamProtocolError(
					"The chat replay changed runs unexpectedly. Your partial reply has been kept.",
				);
			}
			return !cursor || BigInt(next.sequence) > BigInt(cursor.sequence);
		},
		commit(next: ChatEventCursor | undefined) {
			if (enabled && next) {
				cursor = next;
			}
		},
	};
}
