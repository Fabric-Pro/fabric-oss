/**
 * The inline diff's marker tokens, shared by the editor that renders a
 * proposed change and the server that checks what an accepted change saved.
 *
 * Unique placeholder tokens that won't be affected by markdown processing.
 * The interior chars are zero-width spaces; the chars adjacent to inline
 * content are `\u00A0` (non-breaking space) so MarkdownIt's emphasis
 * left/right-flanking sees whitespace context and parses constructs like
 * `**[Label]**` immediately after `<ADD_START>` correctly. `\u00A0` is in
 * the Zs Unicode category and is treated as whitespace by markdown-it; the
 * diff plugin consumes the whole marker before render so this never
 * surfaces as visible text.
 */
export const DIFF_ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
export const DIFF_ADD_END = "\u00A0\u200BADD_END\u200B\u200B";
export const DIFF_DEL_START = "\u200B\u200BDEL_START\u200B\u00A0";
export const DIFF_DEL_END = "\u00A0\u200BDEL_END\u200B\u200B";

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex alternation matching any of the four diff markers, derived from the
 * constants themselves. Hand-spelled copies of these tokens have silently
 * drifted from the real bytes before — matching ZWSP where the constant
 * carries an NBSP — which disabled the table repairs that depended on them
 * without any test noticing.
 */
export const ANY_MARKER_SOURCE = [
	DIFF_ADD_START,
	DIFF_ADD_END,
	DIFF_DEL_START,
	DIFF_DEL_END,
]
	.map(escapeRegExp)
	.join("|");

const ANY_MARKER_RE = new RegExp(ANY_MARKER_SOURCE, "g");

/**
 * A marker as a link destination carries it: markdown-it percent-encodes the
 * zero-width and non-breaking spaces, and `encodeURI` writes the same bytes.
 * Hex digits may come back in either case, so the match ignores case.
 */
function encodedMarker(marker: string): string {
	return escapeRegExp(encodeURI(marker));
}

/**
 * One encoded run, from `start` to the nearest `end`, inside one destination:
 * it holds no whitespace, parenthesis, bracket or angle bracket, so it never
 * reaches into the next link, and a pair split across two links is left
 * alone rather than deleting what lies between them. It never crosses
 * another `start` either: scanning on from every start of a line of
 * unterminated starts would take quadratic time, and the server runs this on
 * a stored body before any check can refuse it.
 */
function encodedRun(start: string, end: string, capture: boolean): RegExp {
	const body = `(?:(?!${encodedMarker(start)})[^\\s()\\[\\]<>])*?`;
	return new RegExp(
		`${encodedMarker(start)}${capture ? `(${body})` : body}${encodedMarker(end)}`,
		"gi",
	);
}

const ENCODED_DEL_RUN_RE = encodedRun(DIFF_DEL_START, DIFF_DEL_END, false);
const ENCODED_ADD_RUN_RE = encodedRun(DIFF_ADD_START, DIFF_ADD_END, true);
const ANY_ENCODED_MARKER_RE = new RegExp(
	[DIFF_ADD_START, DIFF_ADD_END, DIFF_DEL_START, DIFF_DEL_END]
		.map(encodedMarker)
		.join("|"),
	"gi",
);

/**
 * Remove diff marker tokens and stray zero-width characters (U+200B, U+FEFF)
 * from markdown that is about to be saved. A marker that escaped the diff
 * plugin reaches the editor as plain text, and without this pass its invisible
 * characters were written into the stored document. Ordinary non-breaking
 * spaces are left alone; only the ones inside a whole marker are removed.
 * Encoded markers are resolved first, as `resolveEncodedDiffMarkers` does.
 */
export function stripResidualDiffMarkers(markdown: string): string {
	return resolveEncodedDiffMarkers(markdown)
		.replace(ANY_MARKER_RE, "")
		.replace(/[\u200B\uFEFF]/g, "");
}

/**
 * What a lone encoded marker becomes. Removing it outright could join the
 * halves around it into a new whole marker (`…DEL_ST` + marker + `ART…`)
 * that a second pass would resolve, deleting text the first pass kept. A
 * hyphen appears in no marker, so no marker can span it.
 */
const LONE_MARKER_REPLACEMENT = "-";

/**
 * Resolve diff markers percent-encoded into a link or image destination as
 * the accept that saved them meant (Fizzy #2946): a deleted run goes with
 * its text, an added run keeps it. Removing only the marker bytes would keep
 * both the old and the new value. A marker left without its pair becomes a
 * hyphen.
 *
 * The save runs this, and so does the diff before it shows a change, so the
 * destination a person reviews is the one the save stores: a deleted run can
 * otherwise hide a different host in the userinfo, or split a scheme the
 * link rules would refuse. It cannot undo a marked host, which the URL parser
 * has already turned into punycode.
 *
 * One pass leaves no whole encoded marker behind, so its result is a fixed
 * point: the review and the save agree however many times each resolves.
 * The run passes can join two halves into a marker; the last pass replaces
 * every marker left, and its hyphen cannot become part of a new one.
 */
export function resolveEncodedDiffMarkers(markdown: string): string {
	return markdown
		.replace(ENCODED_DEL_RUN_RE, "")
		.replace(ENCODED_ADD_RUN_RE, "$1")
		.replace(ANY_ENCODED_MARKER_RE, LONE_MARKER_REPLACEMENT);
}
