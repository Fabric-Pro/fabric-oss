import { diffArrays } from "diff";

/**
 * Straighten the typographic quotes a model introduced into `document`, and
 * keep every one the author already had in `baseline`.
 *
 * Models answering in prose often swap in curly quotes (`“Unassigned”`,
 * `person’s`) where the document uses straight ones, so accepting an AI edit
 * saved quote characters nobody typed.
 *
 * ## Why a diff, not a lookup
 *
 * Whether a quote is the author's cannot be read off its surroundings: an edit
 * inside an author's quotation (`“hello world”` → `“hello earth”`) changes the
 * quoted text but not the quote marks, and judging each mark by its own span or
 * word straightened them, or worse, straightened one of a pair. So the two
 * texts are aligned and a quote mark the alignment keeps from the baseline
 * stays exactly as it was; only one in inserted text is straightened.
 *
 * Lines are aligned first, which stays cheap however much was rewritten, and
 * only each changed region is aligned token by token, with every quote mark a
 * token of its own. A region rewritten past the token bound has no reliable
 * alignment; its quotes are straightened, since the author's text there is
 * gone in all but scattered words.
 *
 * A quotation whose end the model moved (`“A”` → `“A and B”`) has one mark
 * kept and one inserted. Pairs are therefore settled last: when either mark of
 * a pair is the author's, both stay curly, so a quotation is never saved half
 * straight.
 *
 * The whole document is compared, never an edit fragment, because a fragment
 * can start or end inside a quotation. Pass no baseline for a first
 * generation: every curly quote is new.
 */
export function straightenIntroducedQuotes(
	document: string,
	baseline = "",
): string {
	if (!TYPOGRAPHIC_QUOTE.test(document)) {
		return document;
	}
	if (!TYPOGRAPHIC_QUOTE.test(baseline)) {
		return straighten(document);
	}
	const tokens: Token[] = [];
	let removedLines: string[] = [];
	for (const change of diffArrays(
		splitLines(baseline),
		splitLines(document),
	)) {
		if (change.removed) {
			removedLines = change.value;
			continue;
		}
		const text = change.value.join("");
		if (change.added) {
			tokens.push(...alignRegion(removedLines.join(""), text));
		} else {
			tokens.push(...markAll(text, true));
		}
		removedLines = [];
	}
	keepPairsTogether(tokens);
	return tokens
		.map((token) => (token.kept ? token.text : straighten(token.text)))
		.join("");
}

interface Token {
	text: string;
	/** Carried over from the baseline, so left exactly as written. */
	kept: boolean;
}

const TYPOGRAPHIC_QUOTE = /[‘’“”]/;
const TOKEN = /[‘’“”]|[\p{L}\p{N}_]+|\s+|./gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
/**
 * Bounds the token alignment of one changed region; giving up costs about the
 * square of this. Blank lines survive a rewrite unchanged, so a region is
 * usually one rewritten paragraph, far below the bound.
 */
const MAX_REGION_EDIT_LENGTH = 1000;

function alignRegion(before: string, after: string): Token[] {
	if (!TYPOGRAPHIC_QUOTE.test(after) || !TYPOGRAPHIC_QUOTE.test(before)) {
		return markAll(after, false);
	}
	const changes = diffArrays(tokenize(before), tokenize(after), {
		maxEditLength: MAX_REGION_EDIT_LENGTH,
	});
	if (!changes) {
		return markAll(after, false);
	}
	const tokens: Token[] = [];
	for (const change of changes) {
		if (change.removed) {
			continue;
		}
		for (const text of change.value) {
			tokens.push({ text, kept: !change.added });
		}
	}
	return tokens;
}

/**
 * Match each opening quote with its closing quote within a paragraph and, when
 * one of the two is the author's, keep both. An apostrophe inside a word
 * (`it’s`, `’90s`) is never treated as either end of a quotation.
 */
function keepPairsTogether(tokens: Token[]): void {
	const open: Record<Family, Token[]> = { double: [], single: [] };
	tokens.forEach((token, index) => {
		if (endsParagraph(tokens, index)) {
			open.double = [];
			open.single = [];
			return;
		}
		const role = quoteRole(tokens, index);
		if (!role) {
			return;
		}
		if (role.opens) {
			open[role.family].push(token);
			return;
		}
		const opener = open[role.family].pop();
		if (opener && opener.kept !== token.kept) {
			opener.kept = true;
			token.kept = true;
		}
	});
}

type Family = "double" | "single";

/**
 * A blank line. Lines are split before tokenizing, so its two newlines can
 * arrive as separate whitespace tokens.
 */
function endsParagraph(tokens: Token[], index: number): boolean {
	const text = tokens[index].text;
	if (!text.includes("\n")) {
		return false;
	}
	if (/\n[^\S\n]*\n/.test(text)) {
		return true;
	}
	const previous = tokens[index - 1]?.text ?? "";
	return /^\s+$/.test(previous) && previous.includes("\n");
}

function quoteRole(
	tokens: Token[],
	index: number,
): { family: Family; opens: boolean } | undefined {
	const text = tokens[index].text;
	const before = tokens[index - 1]?.text.slice(-1) ?? "";
	const after = tokens[index + 1]?.text.charAt(0) ?? "";
	switch (text) {
		case "“":
			return { family: "double", opens: true };
		case "”":
			return { family: "double", opens: false };
		case "‘":
			return WORD_CHARACTER.test(before)
				? undefined
				: { family: "single", opens: true };
		case "’":
			return WORD_CHARACTER.test(after)
				? undefined
				: { family: "single", opens: false };
		default:
			return undefined;
	}
}

function markAll(text: string, kept: boolean): Token[] {
	return tokenize(text).map((token) => ({ text: token, kept }));
}

function splitLines(text: string): string[] {
	return text.split(/(?<=\n)/);
}

function tokenize(text: string): string[] {
	return text.match(TOKEN) ?? [];
}

function straighten(text: string): string {
	return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}
