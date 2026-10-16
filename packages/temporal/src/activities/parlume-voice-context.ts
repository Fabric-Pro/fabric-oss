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

/** Completed turns, newest first, as the user/assistant pairs the model replays oldest first. */
export function formatParlumeHistory(
	newestFirst: ReadonlyArray<{
		requestText: string;
		responseText: string | null;
	}>,
): Array<{ role: "user" | "assistant"; content: string }> {
	return [...newestFirst]
		.reverse()
		.flatMap(({ requestText, responseText }) =>
			responseText
				? [
						{ role: "user" as const, content: requestText },
						{ role: "assistant" as const, content: responseText },
					]
				: [],
		);
}
