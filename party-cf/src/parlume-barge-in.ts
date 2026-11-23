import { isParlumePauseRequest } from "./parlume-chat-commands";
import { isParlumeName, parseParlumeWake } from "./parlume-wake";

/**
 * What a participant's words ask of Parlume's answer. Only an explicit stop
 * ends it; anything else said over Parlume, a request to someone else
 * included, leaves it speaking.
 * - `stop`: the words are a stop and nothing more.
 * - `stop-then-request`: they open with a stop and go on to ask Parlume
 *   something ("Parlume, stop. What is next?").
 * - `none`: they are not a stop.
 */
export type ParlumeStop = "stop" | "stop-then-request" | "none";

type Phrase = readonly string[];

// The stops Parlume takes when someone addresses it.
const ADDRESSED_STOP: readonly Phrase[] = [
	["stop"],
	["stop", "talking"],
	["stop", "speaking"],
	["wait"],
	["hold", "on"],
	["hang", "on"],
	["never", "mind"],
	["nevermind"],
	["not", "that"],
	["cancel"],
	["thats", "enough"],
	["enough"],
	["be", "quiet"],
	["quiet"],
	["shut", "up"],
];

// Words that may surround an addressed stop without changing what it asks.
const ADDRESSED_FILLER: readonly Phrase[] = [
	["please"],
	["no"],
	["oh"],
	["sorry"],
	["ok"],
	["okay"],
	["um"],
	["uh"],
	["it"],
	["that"],
	["there"],
	["a", "second"],
	["a", "sec"],
	["a", "moment"],
	["a", "minute"],
	["one", "second"],
	["one", "sec"],
	["one", "moment"],
];

// The stops Parlume takes without its name, said as the whole utterance:
// "wait" and "hold on" are common in side talk, a whole "stop" is not.
const STRONG_STOP: readonly Phrase[] = [
	["stop"],
	["stop", "talking"],
	["stop", "speaking"],
];

const STRONG_FILLER: readonly Phrase[] = [["please"], ["ok"], ["okay"]];

const CLAUSE_END = /[.,;:!?]+/;

function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[’']/g, "")
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** Matches at `index` with the longest phrase that fits, or 0 words. */
function longestMatch(
	tokens: readonly string[],
	index: number,
	phrases: readonly Phrase[],
): number {
	let best = 0;
	for (const phrase of phrases) {
		if (
			phrase.length > best &&
			phrase.every((word, offset) => tokens[index + offset] === word)
		) {
			best = phrase.length;
		}
	}
	return best;
}

/**
 * Whether the words are made only of `core` and `extra` phrases, with at
 * least one `core` phrase among them.
 */
function consistsOf(
	tokens: readonly string[],
	core: readonly Phrase[],
	extra: readonly Phrase[],
): boolean {
	let index = 0;
	let sawCore = false;
	while (index < tokens.length) {
		const coreLength = longestMatch(tokens, index, core);
		const extraLength = longestMatch(tokens, index, extra);
		if (coreLength === 0 && extraLength === 0) {
			return false;
		}
		sawCore ||= coreLength >= extraLength;
		index += Math.max(coreLength, extraLength);
	}
	return sawCore;
}

/** The words with Parlume's name around them taken off. */
function withoutNames(tokens: readonly string[]): string[] {
	let start = 0;
	let end = tokens.length;
	while (start < end && isParlumeName(tokens[start])) {
		start++;
	}
	while (end > start && isParlumeName(tokens[end - 1])) {
		end--;
	}
	return tokens.slice(start, end);
}

/**
 * What words addressed to Parlume ask, past the wake phrase, or null when
 * they do not address it: "Parlume, stop", "Hey Fabric, never mind", or
 * "stop, Parlume".
 */
function addressedRequest(text: string): string | null {
	const wake = parseParlumeWake(text);
	if (wake !== null) {
		return wake;
	}
	const tokens = words(text);
	return tokens.length > 1 &&
		(isParlumeName(tokens[0]) || isParlumeName(tokens[tokens.length - 1]))
		? text
		: null;
}

/**
 * What follows the stop that opens a request, clause by clause: "" when the
 * request is only a stop, the rest of it when it goes on to ask something,
 * or null when it does not open with a stop.
 */
function requestAfterStop(request: string): string | null {
	let rest = request;
	let stopped = false;
	for (;;) {
		const end = CLAUSE_END.exec(rest);
		const clause = withoutNames(
			words(end ? rest.slice(0, end.index) : rest),
		);
		if (
			clause.length > 0 &&
			!consistsOf(clause, ADDRESSED_FILLER, []) &&
			!consistsOf(clause, ADDRESSED_STOP, ADDRESSED_FILLER)
		) {
			return stopped ? rest.trim() : null;
		}
		stopped ||= consistsOf(clause, ADDRESSED_STOP, ADDRESSED_FILLER);
		if (!end) {
			return stopped ? "" : null;
		}
		rest = rest.slice(end.index + end[0].length);
	}
}

/**
 * Whether the words stop Parlume. Anyone may stop it: with its name, by any
 * stop phrase ("Parlume, wait", "Fabric, that's enough"), heard in a partial
 * or a final transcript; without it, only by a strong stop ("stop", "stop
 * talking", "please stop", "okay stop") that is the whole of a final
 * transcript. A pause ("Parlume, pause", "Parlume, stop listening") is not a
 * stop: it stops Parlume listening.
 */
export function classifyParlumeStop(text: string, final: boolean): ParlumeStop {
	const request = addressedRequest(text);
	if (request !== null) {
		if (isParlumePauseRequest(request)) {
			return "none";
		}
		const rest = requestAfterStop(request);
		return rest === null ? "none" : rest ? "stop-then-request" : "stop";
	}
	return final && consistsOf(words(text), STRONG_STOP, STRONG_FILLER)
		? "stop"
		: "none";
}

/** The request a `stop-then-request` goes on to ask, or null. */
export function parlumeRequestAfterStop(text: string): string | null {
	const request = addressedRequest(text);
	return (request !== null && requestAfterStop(request)) || null;
}

/**
 * Whether the words are Parlume's own voice heard back: two words or more,
 * all of them, in order, in a sentence it is saying. A lone "stop" is never
 * taken for it.
 */
export function isParlumeEcho(
	text: string,
	saying: readonly string[],
): boolean {
	const heard = words(text);
	if (heard.length < 2) {
		return false;
	}
	return saying.some((sentence) => {
		const said = words(sentence);
		for (let start = 0; start + heard.length <= said.length; start++) {
			if (heard.every((word, offset) => said[start + offset] === word)) {
				return true;
			}
		}
		return false;
	});
}
