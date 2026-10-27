// Live transcription spells the names by ear: "Fabrik", "Fabrique", "Parlum",
// "Parloom" and "Perlman" all arrived from staging meetings. Names are compared
// by consonant skeleton (vowels dropped, c/k/q merged, repeats collapsed), and
// the whole word must match, so "Fabrication" and "Parliament" stay ordinary
// words.
const GREETING = /\b(?:hey|hi|hay)\b[\s,]*/gi;
const NEXT_WORD = /^[\s,]*([a-z']+)/i;
const TRAILING_PUNCTUATION = /^[\s,.:;!?–—-]+/;
// A name opening the turn as an address also wakes: followed by punctuation
// ("Fabric, what…", a lone "Fabric."), or with the greeting fused onto it
// ("Efabric described…", how a quick "Hey Fabric" was transcribed), or before
// a chat post command ("Parlume read P one", transcribed without a comma). A
// turn that merely starts with the product's name ("Fabric is slow") does not.
// "Parlume" is no ordinary word, and Flux often drops the comma after it, so
// it wakes without punctuation too, unless the sentence describes Parlume
// ("Parlume is slow", "Parlume said…", "Parlume's answers…").
const OPENING_WORD = /^[\s"'“]*([a-z']+)/i;
const DESCRIBES_PARLUME =
	/^(?:'s|is|isn't|was|wasn't|has|hasn't|had|does|doesn't|did|didn't|will|won't|would|could|should|can|can't|cannot|might|may|must|seems|sounds|looks|keeps|kept|just|also|and|or|but|then|so|says|said|told|tells|\w+ed)\b(?!\s+you\b)/i;
const ADDRESS_PUNCTUATION = /^[,.:;!?]/;
const FUSED_GREETING = /^(?:h?e+y?|h?a+y?|hi)(?=[fp])/i;
// "Hey" opening a turn has also arrived as its own word, "A Parlume: how many
// open features…", and was not taken as a greeting. Before a name it counts as
// one, under the same rules as a name opening the turn.
const MISHEARD_GREETING = /^[\s"'“]*(?:a|ay|eh|ah|uh|he)\b[\s,]*/i;
const FABRIC = new Set(["fbrk"]);
const PARLUME = new Set(["prlm", "prlmn"]);
const SPOKEN_REFERENCE =
	/^(?:please\s+)?(say|read|go(?:\s+(?:with|ahead\s+with))?|(?:tell\s+(?:me|us)\s+)?more(?:\s+(?:on|about))?)\s+(?:post\s+)?(?:p|pee)[\s.-]*(\d{1,6}|[a-z]+)[\s.!?]*$/i;
const SPOKEN_NUMBERS = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen",
	"twenty",
];

const POST_COMMAND_START = /^(?:please\s+)?(?:say|read|go|more|tell)\b/i;

/**
 * Whether a request still being spoken may turn out to name a chat post, so
 * the realtime voice waits for the whole request before answering it.
 */
export function mayNameParlumePost(request: string): boolean {
	return !request.trim() || POST_COMMAND_START.test(request.trim());
}

export type ParlumeSpokenReference = {
	kind: "say" | "go" | "more";
	tag: string;
};

/**
 * A spoken request, after its wake phrase, that names a chat post: "go P3",
 * "read P3", "tell me more about P3". Speech recognition writes the tag as
 * "P3", "P 3" or "P three".
 */
export function parseParlumeSpokenReference(
	text: string,
): ParlumeSpokenReference | null {
	const match = SPOKEN_REFERENCE.exec(text.trim());
	if (!match) {
		return null;
	}
	const spoken = match[2].toLowerCase();
	const number = /^\d+$/.test(spoken)
		? Number(spoken)
		: SPOKEN_NUMBERS.indexOf(spoken);
	if (number < 1) {
		return null;
	}
	const verb = match[1].toLowerCase();
	const tag = `P${number}`;
	if (verb === "say" || verb === "read") {
		return { kind: "say", tag };
	}
	return verb.startsWith("go") ? { kind: "go", tag } : { kind: "more", tag };
}

function skeleton(word: string): string {
	return word
		.toLowerCase()
		.replace(/[^a-z]/g, "")
		.replace(/[ckq]/g, "k")
		.replace(/[aeiouy]/g, "")
		.replace(/(.)\1+/g, "$1");
}

/** The same words, whatever their case and punctuation. */
export function isSameParlumeRequest(a: string, b: string): boolean {
	const words = (text: string) =>
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, "")
			.split(/\s+/)
			.filter(Boolean)
			.join(" ");
	return words(a) === words(b);
}

export function isParlumeName(word: string): boolean {
	const name = skeleton(word);
	return FABRIC.has(name) || PARLUME.has(name);
}

function parseOpeningAddress(text: string): string | null {
	const opening = OPENING_WORD.exec(text);
	if (!opening) {
		return null;
	}
	const fused = FUSED_GREETING.exec(opening[1]);
	if (
		!isParlumeName(fused ? opening[1].slice(fused[0].length) : opening[1])
	) {
		return null;
	}
	let consumed = opening[0].length;
	const second = NEXT_WORD.exec(text.slice(consumed));
	if (second && PARLUME.has(skeleton(second[1]))) {
		consumed += second[0].length;
	}
	const rest = text.slice(consumed);
	const bareParlume =
		consumed === opening[0].length && PARLUME.has(skeleton(opening[1]));
	if (
		!fused &&
		!ADDRESS_PUNCTUATION.test(rest.trimStart()) &&
		!parseParlumeSpokenReference(rest) &&
		!(bareParlume && rest.trim() && !DESCRIBES_PARLUME.test(rest.trim()))
	) {
		return null;
	}
	return rest.replace(TRAILING_PUNCTUATION, "").trim();
}

export function parseParlumeWake(text: string): string | null {
	const greeting = MISHEARD_GREETING.exec(text);
	const addressed =
		parseOpeningAddress(text) ??
		(greeting ? parseOpeningAddress(text.slice(greeting[0].length)) : null);
	if (addressed !== null) {
		return addressed;
	}
	for (const greeting of text.matchAll(GREETING)) {
		const rest = text.slice(greeting.index + greeting[0].length);
		const first = NEXT_WORD.exec(rest);
		if (!first) {
			continue;
		}
		const name = skeleton(first[1]);
		let consumed = first[0].length;
		if (FABRIC.has(name)) {
			const second = NEXT_WORD.exec(rest.slice(consumed));
			if (second && PARLUME.has(skeleton(second[1]))) {
				consumed += second[0].length;
			}
		} else if (!PARLUME.has(name)) {
			continue;
		}
		return rest.slice(consumed).replace(TRAILING_PUNCTUATION, "").trim();
	}
	return null;
}
