import { isParlumeName, parseParlumeWake } from "./parlume-wake";

/**
 * What a participant's words mean while Parlume is talking or answering:
 * - `cancel`: "stop", "never mind", "Parlume, wait" and the like. The answer
 *   is abandoned, tools included.
 * - `speech`: two or more words that are not just acknowledgement. Parlume
 *   goes quiet and finishes the answer in the chat.
 * - `ignore`: a backchannel ("yeah", "mm-hmm", "got it, thanks") or a single
 *   word, which says the listener is following, not that they want the floor.
 */
export type ParlumeBargeIn = "cancel" | "speech" | "ignore";

type Phrase = readonly string[];

const CANCEL: readonly Phrase[] = [
	["stop"],
	["cancel"],
	["never", "mind"],
	["nevermind"],
	["not", "that"],
	["hold", "on"],
	["hang", "on"],
	["wait"],
];

// Words that may surround a cancel phrase without changing what it asks.
const CANCEL_FILLER: readonly Phrase[] = [
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

const BACKCHANNEL: readonly Phrase[] = [
	["yeah"],
	["yep"],
	["yup"],
	["yes"],
	["yea"],
	["ok"],
	["okay"],
	["k"],
	["mm"],
	["mhm"],
	["mmhmm"],
	["hmm"],
	["hm"],
	["uh", "huh"],
	["uh"],
	["um"],
	["ah"],
	["oh"],
	["wow"],
	["right"],
	["sure"],
	["got", "it"],
	["i", "see"],
	["nice"],
	["great"],
	["good"],
	["perfect"],
	["awesome"],
	["cool"],
	["thanks"],
	["thank", "you"],
	["exactly"],
	["true"],
	["indeed"],
	["fine"],
	["all", "right"],
	["alright"],
	["makes", "sense"],
	["sounds", "good"],
	["of", "course"],
	["interesting"],
	["gotcha"],
];

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

/** The words with a wake phrase or Parlume's name around them taken off. */
function unaddressed(text: string): string[] {
	const tokens = words(parseParlumeWake(text) ?? text);
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

export function classifyParlumeBargeIn(text: string): ParlumeBargeIn {
	if (consistsOf(unaddressed(text), CANCEL, CANCEL_FILLER)) {
		return "cancel";
	}
	const tokens = words(text);
	if (tokens.length < 2) {
		return "ignore";
	}
	const names = tokens
		.filter((token) => isParlumeName(token))
		.map((token): Phrase => [token]);
	return consistsOf(tokens, BACKCHANNEL, names) ? "ignore" : "speech";
}
