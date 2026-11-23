/**
 * Marking part of a Parlume meeting confidential by voice or in the meeting
 * chat, and what Parlume says about it. Shared by Fabric's web routes, which
 * record the mark, and the meeting-turn worker, which answers the request.
 */

/** Whether a command starts or ends the meeting's confidential part. */
export type ParlumeConfidentialSwitch = "on" | "off";

/**
 * How the command addressed Parlume: after a wake phrase ("Hey Parlume, …"),
 * which also starts a meeting turn, or by name alone ("Parlume, …").
 */
export type ParlumeConfidentialAddress = "wake" | "name";

const NAME = String.raw`(?:fabric\s+parlume|parlume|fabric)`;
// Transcription sometimes writes the opening "Hey" as "A", "Eh" or "Uh".
const WAKE = String.raw`(?:hey|hi|a|eh|uh)`;
const POLITE = String.raw`(?:please\s+)?`;
const ON_PHRASES = [
	String.raw`(?:this\s+is\s+)?confidential(?:\s+now|\s+from\s+now(?:\s+on)?)?`,
	String.raw`(?:go|we\s+are\s+going|we're\s+going)\s+off\s+the\s+record`,
	String.raw`off\s+the\s+record`,
	String.raw`(?:start|begin|mark)\s+(?:this\s+(?:part\s+)?)?(?:as\s+)?confidential`,
];
const OFF_PHRASES = [
	String.raw`(?:end|stop|finish)\s+(?:the\s+)?confidential(?:\s+part)?`,
	String.raw`confidential\s+(?:off|over|ended)`,
	String.raw`(?:back\s+)?on\s+the\s+record`,
	String.raw`(?:this\s+is\s+)?no\s+longer\s+confidential`,
];
const TRAILING = String.raw`[\s.!?]*`;

function phrase(alternatives: string[]): string {
	return `(?:${alternatives.join("|")})`;
}

const REQUEST = {
	on: new RegExp(`^${POLITE}${phrase(ON_PHRASES)}${TRAILING}$`, "i"),
	off: new RegExp(`^${POLITE}${phrase(OFF_PHRASES)}${TRAILING}$`, "i"),
} as const;

const ADDRESSED = new RegExp(
	`^(?:(${WAKE})[\\s,]+)?${NAME}[\\s,:.!-]+(.+)$`,
	"i",
);

/**
 * The confidential switch a request asks for, from the words after the wake
 * phrase, or null when it asks for something else. The whole request must be
 * the command, so "is this confidential?" or a sentence that mentions the
 * record changes nothing.
 */
export function parseParlumeConfidentialRequest(
	text: string,
): ParlumeConfidentialSwitch | null {
	const request = text.trim();
	if (REQUEST.off.test(request)) {
		return "off";
	}
	return REQUEST.on.test(request) ? "on" : null;
}

/**
 * The confidential switch a whole utterance or chat message asks for, and how
 * it addressed Parlume, or null when it is not such a command. It must name
 * Parlume first, so a remark that someone else's topic is confidential
 * changes nothing.
 */
export function parseParlumeConfidentialCommand(text: string): {
	switch: ParlumeConfidentialSwitch;
	address: ParlumeConfidentialAddress;
} | null {
	const match = ADDRESSED.exec(text.trim());
	if (!match?.[2]) {
		return null;
	}
	const requested = parseParlumeConfidentialRequest(match[2]);
	return requested
		? { switch: requested, address: match[1] ? "wake" : "name" }
		: null;
}

/** The meeting chat's notice when the confidential part starts or ends. */
export function parlumeConfidentialNotice(input: {
	switch: ParlumeConfidentialSwitch;
	by: string | null;
}): string {
	const by = input.by?.trim() || "a meeting member";
	switch (input.switch) {
		case "on":
			return `**Confidential** · marked by ${by}\nWhat is said from now, and the notes, requests and suggestions of this meeting, are kept to the people in this meeting and the project's managers. Say "Parlume, end confidential" to end it.`;
		case "off":
			return `**Confidential part ended** · by ${by}\nWhat is said from now is kept as usual. What was said while it was confidential stays confidential.`;
		default: {
			const unreachable: never = input.switch;
			return unreachable;
		}
	}
}

/**
 * What Parlume answers a request that was the command itself, from the state
 * Fabric recorded: `open` while the confidential part runs.
 */
export function parlumeConfidentialReply(input: {
	switch: ParlumeConfidentialSwitch;
	open: boolean;
}): string {
	if (input.switch === "on") {
		return "This part of the meeting is confidential now.";
	}
	return input.open
		? "I can't end the confidential part while a guest is in the meeting. A project manager can end it on the Parlume page."
		: "This part of the meeting is no longer confidential.";
}

/**
 * Parlume's answer when it cannot tell which confirmed participant asked: it
 * looks nothing up, because every lookup runs with the asker's own access.
 */
export const PARLUME_UNCONFIRMED_REQUESTER_REPLY =
	"I couldn't tell who asked, so I didn't look anything up. Ask me again, or type the question in the meeting chat, where I can see who is asking. For an answer only you see, ask the Fabric Agent in Fabric.";
