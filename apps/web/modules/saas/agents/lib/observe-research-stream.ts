import type { ChatEventCursor } from "@repo/utils/chat-event-cursor";
import { createChatEventReplay } from "./chat-event-replay";
import { ChatStreamProtocolError } from "./chat-stream-protocol";
import { parseResearchStreamEvent } from "./orchestrator-stream-protocol";
import {
	INTERRUPTED_STREAM_MESSAGE,
	readChatEventStream,
} from "./read-chat-event-stream";

type ResearchEvent = NonNullable<ReturnType<typeof parseResearchStreamEvent>>;

// Sixteen ten-minute windows cover the workflow's two-hour execution limit.
const MAX_TIMEOUT_RESUMES = 15;
// Transport failures share one lifetime budget; replayed progress cannot refill it.
const MAX_TRANSPORT_RESUMES = 3;
const RETRY_DELAY_MS = 2000;
const SILENCE_LIMIT_MS = 45_000;

async function readChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	signal.throwIfAborted();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort = () => {};
	const interrupted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(
			() => reject(new Error(INTERRUPTED_STREAM_MESSAGE)),
			SILENCE_LIMIT_MS,
		);
	});
	try {
		return await Promise.race([reader.read(), interrupted]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

async function waitBeforeResume(signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, RETRY_DELAY_MS);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Observe an existing Research run across HTTP windows without replaying its input. */
export async function observeResearchStream(
	initialBody: ReadableStream<Uint8Array>,
	{
		executionId: initialExecutionId,
		signal,
		onEvent,
		reattach,
		afterEvent,
	}: {
		executionId?: string;
		afterEvent?: ChatEventCursor;
		signal: AbortSignal;
		onEvent: (event: ResearchEvent) => void;
		reattach: (
			executionId: string,
			signal: AbortSignal,
			afterEvent?: ChatEventCursor,
		) => Promise<Response>;
	},
): Promise<void> {
	let executionId = initialExecutionId;
	const replay = createChatEventReplay(afterEvent);
	let body: ReadableStream<Uint8Array> | null = initialBody;
	let timeoutResumes = 0;
	let transportResumes = 0;
	while (true) {
		signal.throwIfAborted();
		let timedOut = false;
		let finished = false;
		try {
			if (!body) {
				// Only a server-issued identity may be observed. The initial request
				// is never retried when its start outcome is unknown.
				if (!executionId) {
					throw new Error(INTERRUPTED_STREAM_MESSAGE);
				}
				const response = await reattach(
					executionId,
					signal,
					replay.cursor,
				);
				signal.throwIfAborted();
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					if (![502, 503, 504].includes(response.status)) {
						// A definite refusal cannot be repaired by retrying observation.
						throw new ChatStreamProtocolError(
							"This reply could not be resumed. Your partial reply has been kept. Refresh to check your access and the run's status.",
						);
					}
					throw new Error(INTERRUPTED_STREAM_MESSAGE);
				}
				body = response.body;
				if (!body) {
					throw new Error(INTERRUPTED_STREAM_MESSAGE);
				}
			}
			await readChatEventStream(body, {
				parse: parseResearchStreamEvent,
				readChunk: (reader) => readChunk(reader, signal),
				onEvent: (event) => {
					signal.throwIfAborted();
					if (!replay.accept(event.eventCursor)) {
						return;
					}
					if (event.type === "started") {
						if (
							!event.executionId.trim() ||
							(executionId && event.executionId !== executionId)
						) {
							throw new ChatStreamProtocolError(
								"The chat stream changed runs unexpectedly. Your partial reply has been kept.",
							);
						}
						executionId = event.executionId;
					}
					if (event.type === "stream_timeout") {
						timedOut = true;
						return;
					}
					finished = ["done", "completed", "error"].includes(
						event.type,
					);
					onEvent(event);
					replay.commit(event.eventCursor);
				},
				isOutcome: (event) =>
					["done", "completed", "error", "stream_timeout"].includes(
						event.type,
					),
				isTerminal: (event) =>
					["done", "completed", "error", "stream_timeout"].includes(
						event.type,
					),
			});
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof ChatStreamProtocolError || !executionId) {
				throw error;
			}
		}
		signal.throwIfAborted();
		if (finished) {
			return;
		}
		if (!executionId) {
			throw new Error(INTERRUPTED_STREAM_MESSAGE);
		}
		if (timedOut) {
			if (timeoutResumes++ >= MAX_TIMEOUT_RESUMES) {
				throw new Error(INTERRUPTED_STREAM_MESSAGE);
			}
		} else {
			if (transportResumes++ >= MAX_TRANSPORT_RESUMES) {
				throw new Error(INTERRUPTED_STREAM_MESSAGE);
			}
			await waitBeforeResume(signal);
		}
		body = null;
	}
}
