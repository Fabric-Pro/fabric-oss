export const INTERRUPTED_STREAM_MESSAGE =
	"The connection ended before this reply finished. Your partial reply has been kept. The run may still be active.";

/**
 * Shared SSE framing for chat engines. Callers define the outcome and transport
 * boundary events. An EOF alone is never success. This reader never retries a
 * request: resuming observation and restarting execution are different actions.
 */
export async function readChatEventStream<Event>(
	body: ReadableStream<Uint8Array>,
	{
		parse,
		onEvent,
		isOutcome,
		isTerminal,
		readChunk,
		dispatchOnLine = false,
	}: {
		parse: (value: unknown) => Event | null;
		onEvent: (event: Event) => void;
		isOutcome: (event: Event) => boolean;
		isTerminal: (event: Event) => boolean;
		readChunk?: (
			reader: ReadableStreamDefaultReader<Uint8Array>,
		) => Promise<ReadableStreamReadResult<Uint8Array>>;
		dispatchOnLine?: boolean;
	},
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];
	let receivedOutcome = false;
	let completed = false;
	let atEof = false;

	const dispatch = () => {
		if (dataLines.length === 0 || completed) {
			return;
		}
		const data = dataLines.join("\n");
		dataLines = [];
		let value: unknown;
		try {
			value = JSON.parse(data);
		} catch {
			return;
		}
		const event = parse(value);
		if (!event) {
			return;
		}
		onEvent(event);
		if (isOutcome(event)) {
			receivedOutcome = true;
		}
		completed = isTerminal(event);
	};

	const consumeLines = (flush: boolean) => {
		while (buffer.length > 0) {
			const index = buffer.search(/[\r\n]/);
			if (index < 0) {
				break;
			}
			// CRLF may be split across two reads.
			if (
				!flush &&
				buffer[index] === "\r" &&
				index === buffer.length - 1
			) {
				break;
			}
			const line = buffer.slice(0, index);
			const separatorLength =
				buffer.slice(index, index + 2) === "\r\n" ? 2 : 1;
			buffer = buffer.slice(index + separatorLength);
			if (line === "") {
				dispatch();
			} else if (line === "data" || line.startsWith("data:")) {
				dataLines.push(line.slice(5).replace(/^ /, ""));
				if (dispatchOnLine) {
					dispatch();
				}
			}
		}
	};

	try {
		while (true) {
			const { done, value } = await (readChunk
				? readChunk(reader)
				: reader.read());
			atEof = done;
			buffer += done
				? decoder.decode()
				: decoder.decode(value, { stream: true });
			consumeLines(done);
			if (done || completed) {
				break;
			}
		}
		// An unterminated frame is incomplete even if its JSON happens to parse.
		if (!receivedOutcome) {
			throw new Error(INTERRUPTED_STREAM_MESSAGE);
		}
	} finally {
		if (!atEof) {
			// Stop observing after completion or a decoding failure. This does
			// not cancel the Temporal run or retry the original request.
			await reader.cancel().catch(() => {});
		}
		reader.releaseLock();
	}
}
