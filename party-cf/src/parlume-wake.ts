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
// ("Efabric described…", how a quick "Hey Fabric" was transcribed). A turn
// that merely starts with the product's name ("Fabric is slow") does not.
const OPENING_WORD = /^[\s"'“]*([a-z']+)/i;
const ADDRESS_PUNCTUATION = /^[,.:;!?]/;
const FUSED_GREETING = /^(?:h?e+y?|h?a+y?|hi)(?=[fp])/i;
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

function isName(word: string): boolean {
	const name = skeleton(word);
	return FABRIC.has(name) || PARLUME.has(name);
}

function parseOpeningAddress(text: string): string | null {
	const opening = OPENING_WORD.exec(text);
	if (!opening) {
		return null;
	}
	const fused = FUSED_GREETING.exec(opening[1]);
	if (!isName(fused ? opening[1].slice(fused[0].length) : opening[1])) {
		return null;
	}
	let consumed = opening[0].length;
	const second = NEXT_WORD.exec(text.slice(consumed));
	if (second && PARLUME.has(skeleton(second[1]))) {
		consumed += second[0].length;
	}
	const rest = text.slice(consumed);
	if (!fused && !ADDRESS_PUNCTUATION.test(rest.trimStart())) {
		return null;
	}
	return rest.replace(TRAILING_PUNCTUATION, "").trim();
}

export function parseParlumeWake(text: string): string | null {
	const addressed = parseOpeningAddress(text);
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
