/**
 * How much of the meeting a spoken reply is given to read. Every input token is
 * read before the first word, and an answer is one or two sentences, so each
 * budget is the smallest that still answers "what did we just say" and "what
 * does the project say".
 */

/** Earlier question-and-answer pairs replayed to the model; enough for "and the one before?". */
export const MAX_PARLUME_HISTORY_TURNS = 4;
/** A question about the meeting is about the last few minutes, not the whole hour. */
export const LIVE_TRANSCRIPT_WINDOW_MS = 3 * 60 * 1000;
/** About a minute of speech; the most recent characters are kept. */
export const MAX_LIVE_TRANSCRIPT_CHARS = 4_000;
/** Three project passages ground a one-sentence answer; more only lengthen the prompt. */
export const PARLUME_PROJECT_RAG_CHUNKS = 3;
/** Newest-first rows read for the window; far above what 4,000 characters can hold. */
export const MAX_LIVE_TRANSCRIPT_SEGMENTS = 200;

/**
 * An earlier answer replayed beyond the latest one keeps its spoken start; the
 * latest is replayed whole, so "continue" can pick up where it stopped.
 */
export const MAX_PARLUME_EARLIER_REPLY_CHARS = 600;
/** Two workspace passages instead of the workspace's own default of five. */
export const PARLUME_WORKSPACE_RAG_CHUNKS = 2;
/** The inviter's recalled memories, cut at a line break. */
export const MAX_PARLUME_MEMORY_CHARS = 1_500;

/** Enough of the meeting chat for "what did they write in the chat?". */
export const MAX_PARLUME_CHAT_MESSAGES = 20;
export const MAX_PARLUME_CHAT_CHARS = 2_000;

export function liveTranscriptStart(now: number): Date {
	return new Date(now - LIVE_TRANSCRIPT_WINDOW_MS);
}

/** The transcript as lines, oldest first, trimmed from the front to the character budget. */
export function formatLiveTranscript(
	newestFirst: ReadonlyArray<{ text: string; speakerName: string | null }>,
): string {
	return [...newestFirst]
		.reverse()
		.map(({ text, speakerName }) => `${speakerName ?? "Attendee"}: ${text}`)
		.join("\n")
		.slice(-MAX_LIVE_TRANSCRIPT_CHARS);
}

/** The meeting chat as lines, oldest first, trimmed from the front to its own budget. */
export function formatMeetingChat(
	newestFirst: ReadonlyArray<{ text: string; speakerName: string | null }>,
): string {
	return [...newestFirst]
		.slice(0, MAX_PARLUME_CHAT_MESSAGES)
		.reverse()
		.map(({ text, speakerName }) => `${speakerName ?? "Attendee"}: ${text}`)
		.join("\n")
		.slice(-MAX_PARLUME_CHAT_CHARS);
}

function shortened(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Completed turns, newest first, as the user/assistant pairs the model replays oldest first. */
export function formatParlumeHistory(
	newestFirst: ReadonlyArray<{
		requestText: string;
		responseText: string | null;
	}>,
): Array<{ role: "user" | "assistant"; content: string }> {
	return newestFirst
		.filter((turn): turn is { requestText: string; responseText: string } =>
			Boolean(turn.responseText),
		)
		.map(({ requestText, responseText }, index) => ({
			requestText,
			responseText:
				index === 0
					? responseText
					: shortened(responseText, MAX_PARLUME_EARLIER_REPLY_CHARS),
		}))
		.reverse()
		.flatMap(({ requestText, responseText }) => [
			{ role: "user" as const, content: requestText },
			{ role: "assistant" as const, content: responseText },
		]);
}

/** Recalled memories within the voice budget, cut at the last line break that fits. */
export function trimParlumeMemory(context: string): string {
	if (context.length <= MAX_PARLUME_MEMORY_CHARS) {
		return context;
	}
	const head = context.slice(0, MAX_PARLUME_MEMORY_CHARS);
	const lineBreak = head.lastIndexOf("\n");
	return (
		lineBreak > MAX_PARLUME_MEMORY_CHARS / 2
			? head.slice(0, lineBreak)
			: head
	).trimEnd();
}
