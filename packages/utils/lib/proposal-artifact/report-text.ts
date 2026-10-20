/**
 * Parser-free checks on a Proposal analysis report (Fizzy #2946).
 *
 * A report is Markdown a model wrote from untrusted sources, so it is
 * checked before anything parses it. The Markdown parser overflows the stack
 * on a few thousand nested containers on one line, goes quadratic on long
 * runs of emphasis delimiters, closing brackets or unclosed inline HTML
 * (`<?`, `<!--`, `<!A`) in one paragraph, on the words after an unclosed
 * `[`, on lazy continuation lines under a quote or a list item, on a run of
 * punctuation after a bare URL and on plain text broken up by many escapes,
 * entities or line endings in one paragraph, and spends seconds on a report
 * made of thousands of list items, table rows or lines, so the decision
 * whether a report may be parsed at all is made here, by single linear
 * passes over its lines.
 *
 * Nothing here imports a Markdown parser, directly or transitively:
 * `@repo/database` imports this module.
 *
 * Lines end at `\n`, `\r\n` or `\r`, and a blank line holds only spaces and
 * tabs, both as in CommonMark.
 */

import { cutAtCodeUnits } from "../cut-at-code-units";

/** The longest report kept, in UTF-16 code units. */
export const REPORT_TEXT_MAX_CODE_UNITS = 60_000;

/** The most `[S<N>]` markers a citation scan reads before it stops. */
export const REPORT_CITATION_SCAN_MAX_MARKERS = 200;

/** The deepest container nesting one line may open. */
export const REPORT_MAX_NESTING = 8;

/** The most rows (header and body) one table may have. */
export const REPORT_MAX_TABLE_ROWS = 100;

/** The most cells one table row may have. */
export const REPORT_MAX_TABLE_CELLS = 12;

/** The longest line, in UTF-16 code units. */
export const REPORT_MAX_LINE_CODE_UNITS = 4_000;

/** The most `*`, `_` and `~` characters one paragraph may hold. */
export const REPORT_MAX_PARAGRAPH_DELIMITERS = 200;

/**
 * The most `[` and `]` characters one paragraph may hold. Unmatched closing
 * brackets cost the parser quadratic time per paragraph (60,000 of them in
 * one paragraph parse for many seconds); 500 leaves room for 200 citations
 * in a single paragraph.
 */
export const REPORT_MAX_PARAGRAPH_BRACKETS = 500;

/**
 * The most `<` one paragraph may hold that open a comment, a declaration, a
 * CDATA section or a processing instruction (`<!`, `<?`). Unclosed, each
 * makes the parser scan the rest of its paragraph for a close that never
 * comes, so the cost is their count times the paragraph's length. Any other
 * `<` (a tag, an autolink, a comparison) stops its scan at the next `<` or
 * sooner and costs nothing extra, so it is not counted.
 */
export const REPORT_MAX_PARAGRAPH_ANGLE_BRACKETS = 20;

/** The most table rows (header and body) the whole report may hold. */
export const REPORT_MAX_TOTAL_TABLE_ROWS = 300;

/**
 * The most block-opening lines the whole report may hold: lines that open a
 * list item or a quote, ATX headings and table rows. The parser's cost grows
 * with the blocks it opens, at a fraction of a millisecond each.
 */
export const REPORT_MAX_TOTAL_BLOCK_LINES = 1_000;

/**
 * The most code units, in all, the parser may walk back over to find an
 * unbalanced `[`, as `reportTextNeedsPlainText` bounds it. Each `]` walks back
 * to the nearest unbalanced `[`, or to its paragraph's start when there is
 * none, and while a `[` is unbalanced GitHub's autolink check walks back to
 * it at every word: one unclosed `[` before 59,000 code units of short words
 * parses for ten seconds. 4,000,000 allows one unclosed `[` with about 2,800
 * code units after it in its paragraph.
 */
export const REPORT_MAX_BRACKET_WALK = 4_000_000;

/**
 * The most lazy continuation lines one paragraph may hold: lines that carry
 * on a paragraph inside a quote or a list item without continuing the
 * container (no `>`, too little indentation). The parser walks back over the
 * paragraph's tokens at each of them, so `> a` followed by 30,000 lines of
 * `b` parses for ten seconds while the same lines without the `>` take a
 * tenth of one. With 300, a report of such paragraphs, as many as the line
 * limit allows, parses in a few tens of milliseconds.
 */
export const REPORT_MAX_LAZY_LINES = 300;

/**
 * The longest run of consecutive characters inside a bare URL that may end
 * it as trailing punctuation (`! " ' ) , . : ; ? ]`, and `&` with the
 * letters of a character reference after it). In a bare URL's domain and
 * path GitHub's autolink check scans the rest of such a run at each of its
 * characters, so the cost is the square of the run's length: 15 lines of a
 * URL and 3,970 dots parse for over a second. `*`, `_` and `~` end a URL
 * the same way, but the paragraph's delimiter limit bounds them already, so
 * they carry a run on uncounted. A bare URL runs here from `www.` or `://`
 * to the next space or tab on its line; outside one the check never scans,
 * so ellipses and dot leaders cost nothing and are not counted. With 32, a
 * report of URLs that hold such runs end to end parses in a few tens of
 * milliseconds.
 */
export const REPORT_MAX_PUNCTUATION_RUN = 32;

/**
 * The most non-blank lines the whole report may hold. The parser's cost
 * grows with the lines and the paragraphs it builds, and a realistic report
 * of 25,000 code units has a few hundred lines.
 */
export const REPORT_MAX_TOTAL_LINES = 3_000;

/**
 * The most code units, in all, the parser may shift to join plain text, as
 * `reportTextNeedsPlainText` bounds it. Wherever other inline syntax may
 * start (a line ending, an escape, a character reference, a code span, raw
 * HTML or an autolink, emphasis, a bracket, a bare URL or email address),
 * the parser may split a paragraph's plain text, and it joins each run of
 * pieces by moving everything after it in the paragraph: 15 lines of `<a\.`
 * parse for over a second. 30,000,000 keeps the joins to a few tens of
 * milliseconds and leaves room for a paragraph of 40,000 code units in
 * 80-column lines.
 */
export const REPORT_MAX_TEXT_JOIN_SHIFT = 30_000_000;

/**
 * A citation marker: `[S<N>]` with N from 1 to 999 and no leading zero.
 * Group 1 is N. A source string, so each scan builds its own `RegExp`.
 */
export const REPORT_CITATION_MARKER_SOURCE = "\\[S([1-9]\\d{0,2})\\]";

/**
 * The linear scan's marker: not one followed by `(` (an inline link) or `:`
 * (a reference definition).
 */
const LINEAR_CITATION_MARKER = new RegExp(
	`${REPORT_CITATION_MARKER_SOURCE}(?![(:])`,
	"g",
);

/** A fence line: up to three spaces, then three or more backticks or tildes. */
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})/;

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const TAB = 9;
const BACKSLASH = 92;
const PIPE = 124;
const GREATER_THAN = 62;
const LESS_THAN = 60;
const DASH = 45;
const ASTERISK = 42;
const PLUS = 43;
const UNDERSCORE = 95;
const TILDE = 126;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const COLON = 58;
const BACKTICK = 96;
const EXCLAMATION = 33;
const QUOTATION = 34;
const AMPERSAND = 38;
const APOSTROPHE = 39;
const COMMA = 44;
const SEMICOLON = 59;
const QUESTION = 63;
const AT = 64;
const SLASH = 47;
const CARET = 94;
const HASH = 35;
const DOT = 46;
const CLOSE_PAREN = 41;
const DIGIT_ZERO = 48;
const DIGIT_ONE = 49;
const DIGIT_NINE = 57;
const LOWERCASE_A = 97;
const LOWERCASE_W = 119;
const LOWERCASE_Z = 122;
/** ORed into an ASCII letter's code, it gives the lowercase letter's. */
const ASCII_CASE_BIT = 0x20;

/** The index of the line terminator after `start`, or the text's length. */
function lineEnd(text: string, start: number): number {
	let end = start;
	while (end < text.length) {
		const code = text.charCodeAt(end);
		if (code === LINE_FEED || code === CARRIAGE_RETURN) {
			break;
		}
		end++;
	}
	return end;
}

/** Where the line after the one ending at `end` starts (past the text's end on the last line). */
function nextLineStart(text: string, end: number): number {
	return text.charCodeAt(end) === CARRIAGE_RETURN &&
		text.charCodeAt(end + 1) === LINE_FEED
		? end + 2
		: end + 1;
}

/** Whether `text` from `from` to its end holds only spaces and tabs. */
function isSpacesAndTabs(text: string, from = 0): boolean {
	for (let i = from; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code !== SPACE && code !== TAB) {
			return false;
		}
	}
	return true;
}

/**
 * `text` split into lines at `\r\n`, `\r` or `\n`, the terminators dropped.
 * Text ending in a terminator ends with an empty line, and empty text is one
 * empty line.
 */
export function splitReportLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/** A fenced code block left open by an earlier line. */
export interface ReportFenceState {
	readonly marker: "`" | "~";
	readonly length: number;
}

/** What one line is to fenced code; see `reportFenceLine`. */
export type ReportFenceLine =
	| { kind: "open"; fence: ReportFenceState; info: string }
	| { kind: "close" }
	| { kind: "inside" }
	| { kind: "outside" };

/**
 * Classify one line (without its line terminator) against the current fence
 * state, by CommonMark's rule at the top level.
 *
 * With no fence open, a line opens one when, after up to three spaces, it
 * starts with three or more backticks or tildes; a backtick fence's info
 * string holds no backtick, or the line opens nothing. `info` is the rest of
 * the line, spaces and tabs trimmed from both ends. With a fence open, a line
 * closes it when, after up to three spaces, it holds a run of the same
 * character at least as long as the opener's, followed only by spaces and
 * tabs; any other line is inside. Fences inside containers (a list item, a
 * quote) are not followed. Never throws, and linear in the line's length.
 */
export function reportFenceLine(
	line: string,
	open: ReportFenceState | null,
): ReportFenceLine {
	const marker = FENCE_MARKER.exec(line);
	if (open === null) {
		if (!marker) {
			return { kind: "outside" };
		}
		const run = marker[1];
		if (run[0] === "`" && line.indexOf("`", marker[0].length) !== -1) {
			return { kind: "outside" };
		}
		return {
			kind: "open",
			fence: { marker: run[0] === "`" ? "`" : "~", length: run.length },
			info: trimSpacesAndTabs(line, marker[0].length),
		};
	}
	if (
		marker &&
		marker[1][0] === open.marker &&
		marker[1].length >= open.length &&
		isSpacesAndTabs(line, marker[0].length)
	) {
		return { kind: "close" };
	}
	return { kind: "inside" };
}

/** `line` from `from` to its end, without leading or trailing spaces and tabs. */
function trimSpacesAndTabs(line: string, from: number): string {
	let start = from;
	let end = line.length;
	while (start < end && isSpaceOrTab(line.charCodeAt(start))) {
		start++;
	}
	while (end > start && isSpaceOrTab(line.charCodeAt(end - 1))) {
		end--;
	}
	return line.slice(start, end);
}

function isSpaceOrTab(code: number): boolean {
	return code === SPACE || code === TAB;
}

/** The fence state after `line`, given the state before it. */
function nextFence(
	role: ReportFenceLine,
	open: ReportFenceState | null,
): ReportFenceState | null {
	if (role.kind === "open") {
		return role.fence;
	}
	return role.kind === "close" ? null : open;
}

/**
 * `text` cut to at most `maxCodeUnits` UTF-16 code units, at a paragraph
 * boundary when there is one.
 *
 * Text that fits is returned unchanged. Otherwise the cut lands at the start
 * of the last blank line that starts at or before the cap and lies outside
 * fenced code, so a fence open at the cap is dropped whole. Without such a
 * line, a fence open at the cap is cut before its opening line; failing
 * that, the text is cut hard at the cap, never between the halves of a
 * surrogate pair. Trailing whitespace goes; no ellipsis is added.
 */
export function cutReportText(
	text: string,
	maxCodeUnits = REPORT_TEXT_MAX_CODE_UNITS,
): { text: string; truncated: boolean } {
	if (text.length <= maxCodeUnits) {
		return { text, truncated: false };
	}

	let fence: ReportFenceState | null = null;
	let lastBlank = -1;
	let openFence = -1;
	let start = 0;
	while (start <= maxCodeUnits) {
		const end = lineEnd(text, start);
		const line = text.slice(start, end);
		const role = reportFenceLine(line, fence);
		fence = nextFence(role, fence);
		if (role.kind === "outside" && isSpacesAndTabs(line)) {
			lastBlank = start;
		} else if (role.kind === "open") {
			openFence = start;
		} else if (role.kind === "close" && end <= maxCodeUnits) {
			// A closing line that runs past the cap leaves the fence open there.
			openFence = -1;
		}
		start = nextLineStart(text, end);
	}

	// Every recorded blank line precedes a fence still open at the cap, and an
	// earlier boundary's text is a prefix of a later one's, so only the last
	// of each needs trying.
	for (const cut of [lastBlank, openFence]) {
		if (cut > 0) {
			const kept = text.slice(0, cut).trimEnd();
			if (kept) {
				return { text: kept, truncated: true };
			}
		}
	}
	return {
		text: cutAtCodeUnits(text, maxCodeUnits).trimEnd(),
		truncated: true,
	};
}

/**
 * The index after a container marker at `i` in `line`, or -1: `>`, a bullet
 * (`-`, `*`, `+`) or an ordered marker (one to nine digits, then `.` or `)`),
 * a bullet or ordered marker followed by a space, a tab or the line's end.
 */
function containerMarkerEnd(line: string, i: number): number {
	const code = line.charCodeAt(i);
	if (code === GREATER_THAN) {
		return i + 1;
	}
	let end = -1;
	if (code === DASH || code === ASTERISK || code === PLUS) {
		end = i + 1;
	} else {
		let digits = i;
		while (
			digits - i < 10 &&
			line.charCodeAt(digits) >= DIGIT_ZERO &&
			line.charCodeAt(digits) <= DIGIT_NINE
		) {
			digits++;
		}
		const count = digits - i;
		const delimiter = line.charCodeAt(digits);
		if (
			count >= 1 &&
			count <= 9 &&
			(delimiter === DOT || delimiter === CLOSE_PAREN)
		) {
			end = digits + 1;
		}
	}
	if (end === -1) {
		return -1;
	}
	const next = line.charCodeAt(end);
	return end === line.length || next === SPACE || next === TAB ? end : -1;
}

/**
 * How deeply the containers that open `line` nest, and where its content
 * starts.
 *
 * Each container marker at the line's start adds a level (`> > - * 1. text`
 * is 5, `>>>>` is 4), and indentation before a marker adds a level per two
 * columns (a tab counts four), since a nested list item is opened by
 * indentation alone. The first column after a marker separates it from what
 * follows and is not indentation, but any more is: `>   - item` nests a list
 * in a list in a quote. Whitespace before the content itself counts nothing.
 */
function containerPrefix(line: string): {
	depth: number;
	markers: number;
	contentStart: number;
} {
	let markers = 0;
	let indent = 0;
	let i = 0;
	let end: number;
	do {
		let columns = 0;
		while (i < line.length) {
			const code = line.charCodeAt(i);
			if (code === SPACE) {
				columns += 1;
			} else if (code === TAB) {
				columns += 4;
			} else {
				break;
			}
			i++;
		}
		end = containerMarkerEnd(line, i);
		if (end !== -1) {
			indent += markers > 0 ? Math.max(columns - 1, 0) : columns;
			markers++;
			i = end;
		}
	} while (end !== -1);
	return {
		depth: markers + Math.floor(indent / 2),
		markers,
		contentStart: i,
	};
}

/** A list item that a line surely opens; see `sureListItemStart`. */
interface ListItemStart {
	/** Spaces before the marker. */
	indent: number;
	/** An ordered marker's delimiter (`.` or `)`), or 0 for a bullet. */
	delimiter: number;
	/** A bullet, or an ordered marker that is exactly `1`. */
	interrupts: boolean;
}

/**
 * The list item marker that opens `line`, when the parser cannot read the
 * line as text continuing a paragraph, or null: up to three spaces, a bullet
 * (`-`, `*`, `+`) or an ordered marker (one to nine digits, then `.` or `)`),
 * then a space or a tab, then content.
 *
 * Wherever the containers before such a line end, at most three columns of
 * indentation are left, so the marker opens a list item there; a bullet or
 * `1.` / `1)` with content may interrupt a paragraph, so with `interrupts`
 * the line always ends the one before it. (A bullet line that is a thematic
 * break, `- - -`, ends it too.) Any other number interrupts nothing: `2.` is
 * a new item only beside an open item of the same list; the caller decides.
 * An empty item, a marker indented four columns or more, or one after a tab
 * can all be read as paragraph text, so none is returned for them.
 */
function sureListItemStart(line: string): ListItemStart | null {
	let i = 0;
	while (i < 3 && line.charCodeAt(i) === SPACE) {
		i++;
	}
	const code = line.charCodeAt(i);
	let delimiter = 0;
	let interrupts = true;
	let end: number;
	if (code === DASH || code === ASTERISK || code === PLUS) {
		end = i + 1;
	} else {
		let digits = i;
		while (
			digits - i < 10 &&
			line.charCodeAt(digits) >= DIGIT_ZERO &&
			line.charCodeAt(digits) <= DIGIT_NINE
		) {
			digits++;
		}
		delimiter = line.charCodeAt(digits);
		if (
			digits - i < 1 ||
			digits - i > 9 ||
			(delimiter !== DOT && delimiter !== CLOSE_PAREN)
		) {
			return null;
		}
		interrupts = digits - i === 1 && code === DIGIT_ONE;
		end = digits + 1;
	}
	if (!isSpaceOrTab(line.charCodeAt(end)) || isSpacesAndTabs(line, end)) {
		return null;
	}
	return { indent: i, delimiter, interrupts };
}

/**
 * Whether `item` surely opens a list item: it may interrupt a paragraph, or
 * it is an ordered item right under one `previous` surely opened, at the
 * same indentation and with the same delimiter, so it continues that list.
 */
function continuesList(
	item: ListItemStart,
	previous: ListItemStart | null,
): boolean {
	return (
		item.interrupts ||
		(previous !== null &&
			previous.indent === item.indent &&
			previous.delimiter === item.delimiter)
	);
}

/** Whether `line`, from `from` (its content start), is an ATX heading. */
function isAtxHeading(line: string, from: number): boolean {
	let i = from;
	while (i - from < 7 && line.charCodeAt(i) === HASH) {
		i++;
	}
	const hashes = i - from;
	return (
		hashes >= 1 &&
		hashes <= 6 &&
		(i === line.length || isSpaceOrTab(line.charCodeAt(i)))
	);
}

/** Whether `line` starts with at least two columns of indentation. */
function isIndentedTwoColumns(line: string): boolean {
	const first = line.charCodeAt(0);
	return (
		first === TAB || (first === SPACE && isSpaceOrTab(line.charCodeAt(1)))
	);
}

function isAsciiLetter(code: number): boolean {
	const lower = code | ASCII_CASE_BIT;
	return lower >= LOWERCASE_A && lower <= LOWERCASE_Z;
}

/**
 * Whether GitHub's bare-URL check may take `code` for trailing punctuation,
 * delimiters aside: `! " & ' ) , . : ; ? ]` (`&` when a character reference
 * follows).
 */
function isTrailingPunctuation(code: number): boolean {
	switch (code) {
		case EXCLAMATION:
		case QUOTATION:
		case AMPERSAND:
		case APOSTROPHE:
		case CLOSE_PAREN:
		case COMMA:
		case DOT:
		case COLON:
		case SEMICOLON:
		case QUESTION:
		case CLOSE_BRACKET:
			return true;
		default:
			return false;
	}
}

/**
 * Whether a bare URL may start at `i` in `line`, where `code` is: the dot of
 * `www.` (in any case) or the colon of `://`.
 */
function isBareUrlStart(line: string, i: number, code: number): boolean {
	if (code === COLON) {
		return (
			line.charCodeAt(i + 1) === SLASH && line.charCodeAt(i + 2) === SLASH
		);
	}
	return (
		code === DOT &&
		(line.charCodeAt(i - 1) | ASCII_CASE_BIT) === LOWERCASE_W &&
		(line.charCodeAt(i - 2) | ASCII_CASE_BIT) === LOWERCASE_W &&
		(line.charCodeAt(i - 3) | ASCII_CASE_BIT) === LOWERCASE_W
	);
}

/**
 * Whether inline syntax other than plain text may start at `i` in `line`,
 * where `code` is: an escape or a hard break (`\`), a character reference
 * (`&`), a code span, raw HTML or an autolink, emphasis or strikethrough, a
 * bracket, a bare email address (`@`) or a bare URL (see `isBareUrlStart`).
 * Line endings are counted by the caller.
 */
function mayBreakText(line: string, i: number, code: number): boolean {
	switch (code) {
		case BACKSLASH:
		case AMPERSAND:
		case BACKTICK:
		case LESS_THAN:
		case ASTERISK:
		case UNDERSCORE:
		case TILDE:
		case OPEN_BRACKET:
		case CLOSE_BRACKET:
		case AT:
			return true;
		case COLON:
		case DOT:
			return isBareUrlStart(line, i, code);
		default:
			return false;
	}
}

/**
 * Whether `content` reads as a table's delimiter row: only pipes, dashes,
 * colons, spaces and tabs, with at least one pipe and one dash. Looser than
 * GitHub's rule, which only makes the table checks stricter.
 */
function isDelimiterRow(content: string): boolean {
	let pipe = false;
	let dash = false;
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code === PIPE) {
			pipe = true;
		} else if (code === DASH) {
			dash = true;
		} else if (code !== COLON && code !== SPACE && code !== TAB) {
			return false;
		}
	}
	return pipe && dash;
}

/**
 * Whether a report is too hostile to parse as Markdown and must be shown as
 * plain text. One linear pass, no parser. True when any of these holds:
 *
 * - a line opens more than `REPORT_MAX_NESTING` levels of containers (see
 *   `containerPrefix` for how levels are counted);
 * - a table has more than `REPORT_MAX_TABLE_ROWS` rows (header and body), or
 *   a table row more than `REPORT_MAX_TABLE_CELLS` cells. A table starts at
 *   a delimiter row under a non-blank line and runs to the next blank line,
 *   every line in it a row, as GitHub reads a row with no pipe; cells are
 *   counted by unescaped pipes;
 * - the report's tables have more than `REPORT_MAX_TOTAL_TABLE_ROWS` rows in
 *   all, or more than `REPORT_MAX_TOTAL_BLOCK_LINES` of its lines open a list
 *   item or a quote, are ATX headings or are table rows;
 * - a line is longer than `REPORT_MAX_LINE_CODE_UNITS`;
 * - a paragraph holds more than `REPORT_MAX_PARAGRAPH_DELIMITERS` emphasis or
 *   strikethrough characters (`*`, `_`, `~`), more than
 *   `REPORT_MAX_PARAGRAPH_BRACKETS` brackets, or more than
 *   `REPORT_MAX_PARAGRAPH_ANGLE_BRACKETS` `<!` and `<?`. A paragraph is a run
 *   of non-blank lines, and a line that surely opens a list item outside
 *   fenced code starts a new one;
 * - the parser's walks back to an unbalanced `[` may exceed
 *   `REPORT_MAX_BRACKET_WALK` code units in all. Each `]` is charged its
 *   distance from its paragraph's start, and while a `[` may be unbalanced,
 *   each code unit its distance from the oldest such `[`. An escaped bracket
 *   is text. A `]` balances the latest `[` only when nothing between them
 *   can hide either from the parser (a backtick may open code, a `<` raw HTML
 *   or an autolink) and the `[` opens no footnote call (`[^`); nested pairs
 *   balance innermost first;
 * - a paragraph holds more than `REPORT_MAX_LAZY_LINES` lines that may be
 *   lazy continuation lines: lines that open no container while one may be
 *   open. A container may be open from a line that opens one (with a marker,
 *   counted as for nesting) until a paragraph starts after a blank line with
 *   less than two columns of indentation, the least that continues a list
 *   item;
 * - more than `REPORT_MAX_PUNCTUATION_RUN` characters in a row inside a
 *   bare URL may be its trailing punctuation, delimiters in the run
 *   uncounted (see the constant for where a bare URL runs);
 * - the parser's shifts to join plain text may exceed
 *   `REPORT_MAX_TEXT_JOIN_SHIFT` code units in all: each code unit, line
 *   endings included, is charged the places before it in its paragraph
 *   where other inline syntax may start (see `mayBreakText`) or a line ends;
 * - the report has more than `REPORT_MAX_TOTAL_LINES` non-blank lines.
 *
 * Fenced code is checked like any other text. Telling it apart takes the
 * container and HTML-block rules too (a fence opened in a list item ends
 * with the item; a fence line inside an HTML comment opens nothing), and a
 * line wrongly taken for code would reach the parser unchecked. A report
 * whose code trips a rule is shown as plain text, which is safe.
 */
export function reportTextNeedsPlainText(text: string): boolean {
	let delimiters = 0;
	let brackets = 0;
	let angles = 0;
	// Cells of the previous line, or -1 after a blank line.
	let previousCells = -1;
	// Rows of the table the current paragraph is in, or 0 outside one.
	let tableRows = 0;
	let totalTableRows = 0;
	let blockLines = 0;
	let previousOpensBlock = false;
	// The ordered item the previous line surely opened, or null.
	let previousOrdered: ListItemStart | null = null;
	let fence: ReportFenceState | null = null;
	// Bracket walks: positions are code units into the paragraph's content.
	let walk = 0;
	let position = 0;
	// Where each `[` that may be unbalanced sits, oldest first.
	const open: number[] = [];
	// The last backtick, `<` or footnote call, which may hide a bracket.
	let lastHiding = -1;
	// Text joins: places in the paragraph where plain text may break, and
	// the code units charged for them so far.
	let breaks = 0;
	let joinShift = 0;
	// Lazy lines: whether a container may be open, whether the line follows
	// a blank one, and the paragraph's lines that may be lazy.
	let containerOpen = false;
	let afterBlank = true;
	let lazyLines = 0;
	let nonBlankLines = 0;

	let start = 0;
	while (start <= text.length) {
		const end = lineEnd(text, start);
		if (end - start > REPORT_MAX_LINE_CODE_UNITS) {
			return true;
		}
		const line = text.slice(start, end);
		start = nextLineStart(text, end);

		if (isSpacesAndTabs(line)) {
			delimiters = 0;
			brackets = 0;
			angles = 0;
			position = 0;
			open.length = 0;
			lastHiding = -1;
			breaks = 0;
			lazyLines = 0;
			afterBlank = true;
			previousCells = -1;
			tableRows = 0;
			previousOpensBlock = false;
			previousOrdered = null;
			continue;
		}
		nonBlankLines++;
		if (nonBlankLines > REPORT_MAX_TOTAL_LINES) {
			return true;
		}

		const { depth, markers, contentStart } = containerPrefix(line);
		if (depth > REPORT_MAX_NESTING) {
			return true;
		}

		// Each list item is an inline context of its own for the parser, so
		// the paragraph counts restart at a line that surely opens one. Only a
		// sure opener may restart them: the parser reads an empty item, a
		// marker indented four columns or more, or `2.` under a plain line as
		// text continuing the paragraph, and restarting there would let one
		// paragraph hold any number of delimiters. `2.` restarts them only
		// right under an item it surely continues the list of (same
		// indentation and delimiter), and nothing does inside fenced code. A
		// restart inside code or raw HTML the parser reads elsewhere is
		// harmless: no inline syntax is parsed there.
		const role = reportFenceLine(line, fence);
		fence = nextFence(role, fence);
		const item = role.kind === "outside" ? sureListItemStart(line) : null;
		const sureItem: boolean =
			item !== null && continuesList(item, previousOrdered);
		previousOrdered = sureItem && item?.delimiter ? item : null;
		if (sureItem) {
			delimiters = 0;
			brackets = 0;
			angles = 0;
			position = 0;
			open.length = 0;
			lastHiding = -1;
			breaks = 0;
			lazyLines = 0;
		}

		// A line that continues a quote with `>` may still be lazy for a quote
		// or a list item nested in it, but such lines open a block and count
		// towards the block-line limit, so only lines with no marker count
		// here. The parser's walk at a lazy line goes back to its paragraph's
		// start, so no line inside a paragraph restarts the count: only a line
		// that surely opens a list item, which ends the paragraph before it.
		if (markers > 0) {
			containerOpen = true;
		} else if (afterBlank && !isIndentedTwoColumns(line)) {
			containerOpen = false;
		}
		afterBlank = false;
		if (markers === 0 && containerOpen) {
			lazyLines++;
			if (lazyLines > REPORT_MAX_LAZY_LINES) {
				return true;
			}
		}

		let pipes = 0;
		let escaped = false;
		let firstContent = -1;
		let lastContent = -1;
		let lastIsPipe = false;
		// Trailing punctuation: whether a bare URL may be open, the current
		// run in it, and whether the run ends in `&` and letters, which a `;`
		// would make a character reference.
		let inUrl = false;
		let punctuationRun = 0;
		let inReference = false;
		for (let i = contentStart; i < line.length; i++, position++) {
			const code = line.charCodeAt(i);
			if (isSpaceOrTab(code)) {
				inUrl = false;
			} else if (!inUrl) {
				if (isBareUrlStart(line, i, code)) {
					inUrl = true;
					punctuationRun = 0;
					inReference = false;
				}
			} else if (isTrailingPunctuation(code)) {
				punctuationRun++;
				inReference = code === AMPERSAND;
			} else if (inReference && isAsciiLetter(code)) {
				punctuationRun++;
			} else if (
				code !== ASTERISK &&
				code !== UNDERSCORE &&
				code !== TILDE
			) {
				punctuationRun = 0;
				inReference = false;
			}
			if (punctuationRun > REPORT_MAX_PUNCTUATION_RUN) {
				return true;
			}
			if (mayBreakText(line, i, code)) {
				breaks++;
			}
			joinShift += breaks;
			if (code === ASTERISK || code === UNDERSCORE || code === TILDE) {
				delimiters++;
			} else if (code === OPEN_BRACKET) {
				brackets++;
				// An escaped bracket is text; any other may open a label.
				if (!escaped) {
					open.push(position);
					if (line.charCodeAt(i + 1) === CARET) {
						lastHiding = position;
					}
				}
			} else if (code === CLOSE_BRACKET) {
				brackets++;
				if (!escaped) {
					walk += position;
					if (open.length > 0 && open[open.length - 1] > lastHiding) {
						open.pop();
					}
				}
			} else if (code === LESS_THAN) {
				lastHiding = position;
				const next = line.charCodeAt(i + 1);
				if (next === EXCLAMATION || next === QUESTION) {
					angles++;
				}
			} else if (code === BACKTICK) {
				lastHiding = position;
			}
			if (open.length > 0) {
				walk += position - open[0];
			}
			if (code !== SPACE && code !== TAB) {
				if (firstContent === -1) {
					firstContent = i;
				}
				lastContent = i;
				lastIsPipe = code === PIPE && !escaped;
			}
			if (code === PIPE && !escaped) {
				pipes++;
			}
			escaped = code === BACKSLASH && !escaped;
		}
		// The line ending, which the walks cross too, and which may break the
		// paragraph's plain text.
		position++;
		if (open.length > 0) {
			walk += position - open[0];
		}
		breaks++;
		joinShift += breaks;
		if (
			delimiters > REPORT_MAX_PARAGRAPH_DELIMITERS ||
			brackets > REPORT_MAX_PARAGRAPH_BRACKETS ||
			angles > REPORT_MAX_PARAGRAPH_ANGLE_BRACKETS ||
			walk > REPORT_MAX_BRACKET_WALK ||
			joinShift > REPORT_MAX_TEXT_JOIN_SHIFT
		) {
			return true;
		}

		// Outer pipes open and close a row rather than separate cells.
		const leadingPipe =
			firstContent !== -1 && line.charCodeAt(firstContent) === PIPE;
		const trailingPipe = lastIsPipe && lastContent !== firstContent;
		const cells =
			pipes + 1 - (leadingPipe ? 1 : 0) - (trailingPipe ? 1 : 0);

		const opensBlock = markers > 0 || isAtxHeading(line, contentStart);
		if (opensBlock) {
			blockLines++;
		}
		if (tableRows > 0) {
			tableRows++;
			totalTableRows++;
			if (!opensBlock) {
				blockLines++;
			}
			if (
				tableRows > REPORT_MAX_TABLE_ROWS ||
				cells > REPORT_MAX_TABLE_CELLS
			) {
				return true;
			}
		} else if (
			previousCells !== -1 &&
			isDelimiterRow(line.slice(contentStart))
		) {
			if (
				previousCells > REPORT_MAX_TABLE_CELLS ||
				cells > REPORT_MAX_TABLE_CELLS
			) {
				return true;
			}
			// The header row; the delimiter row is not counted.
			tableRows = 1;
			totalTableRows++;
			if (!previousOpensBlock) {
				blockLines++;
			}
		}
		if (
			totalTableRows > REPORT_MAX_TOTAL_TABLE_ROWS ||
			blockLines > REPORT_MAX_TOTAL_BLOCK_LINES
		) {
			return true;
		}
		previousCells = cells;
		previousOpensBlock = opensBlock;
	}
	return false;
}

/** Unique numbers in ascending order. */
function ascending(found: ReadonlySet<number>): number[] {
	return [...found].sort((a, b) => a - b);
}

/**
 * The source numbers cited as `[S<N>]` in `text`, unique and ascending, read
 * without a parser: the scan for a report shown as plain text.
 *
 * Lines in fenced code are skipped, as is a marker followed by `(` or `:`
 * (an inline link or a reference definition). Inline code spans are not
 * excluded: the text is not rendered as Markdown, so a marker in one still
 * reads as a citation. The scan stops after `maxMarkers` markers, repeats
 * included.
 */
export function scanReportCitationsLinear(
	text: string,
	maxMarkers = REPORT_CITATION_SCAN_MAX_MARKERS,
): number[] {
	const found = new Set<number>();
	if (maxMarkers <= 0) {
		return [];
	}
	let seen = 0;
	let fence: ReportFenceState | null = null;
	let start = 0;
	while (start <= text.length) {
		const end = lineEnd(text, start);
		const line = text.slice(start, end);
		start = nextLineStart(text, end);
		const role = reportFenceLine(line, fence);
		fence = nextFence(role, fence);
		if (role.kind !== "outside") {
			continue;
		}
		for (const match of line.matchAll(LINEAR_CITATION_MARKER)) {
			found.add(Number(match[1]));
			seen++;
			if (seen >= maxMarkers) {
				return ascending(found);
			}
		}
	}
	return ascending(found);
}
