import {
	type DirectStreamEvent,
	parseDirectStreamEvent,
} from "./direct-stream-protocol";
import { readChatEventStream } from "./read-chat-event-stream";

export { INTERRUPTED_STREAM_MESSAGE } from "./read-chat-event-stream";

export function readDirectStream(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: DirectStreamEvent) => void,
): Promise<void> {
	return readChatEventStream(body, {
		parse: parseDirectStreamEvent,
		onEvent,
		isOutcome: (event) => event.type === "done" || event.type === "error",
		// Partial errors can precede done with usage/model metadata.
		isTerminal: (event) => event.type === "done",
	});
}
