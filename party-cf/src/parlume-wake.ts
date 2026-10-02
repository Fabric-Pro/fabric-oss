// Live transcription spells the names by ear: "Fabrik", "Fabrique", "Parlum",
// "Parloom" and "Perlman" all arrived from staging meetings. Names are compared
// by consonant skeleton (vowels dropped, c/k/q merged, repeats collapsed), and
// the whole word must match, so "Fabrication" and "Parliament" stay ordinary
// words.
const GREETING = /\b(?:hey|hi|hay)\b[\s,]*/gi;
const NEXT_WORD = /^[\s,]*([a-z']+)/i;
const TRAILING_PUNCTUATION = /^[\s,.:;!?–—-]+/;
const FABRIC = new Set(["fbrk"]);
const PARLUME = new Set(["prlm", "prlmn"]);

function skeleton(word: string): string {
	return word
		.toLowerCase()
		.replace(/[^a-z]/g, "")
		.replace(/[ckq]/g, "k")
		.replace(/[aeiouy]/g, "")
		.replace(/(.)\1+/g, "$1");
}

export function parseParlumeWake(text: string): string | null {
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
