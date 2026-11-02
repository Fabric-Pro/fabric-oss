/**
 * Card grids and two columns in a Proposal's Main body (Fizzy #2946).
 *
 * Both forms are fenced blocks, like stat tiles (`stat-tiles.ts`), read line
 * by line. Nothing else is evaluated: no raw HTML, no YAML, no JSON.
 *
 * A `cards` fence holds one to eight cards separated by blank lines. A
 * card's first line is its label, kept exactly as written; a next line that
 * is one bold run is its title; the lines after that are its text:
 *
 *   ```cards
 *   01
 *   **Route planning**
 *   Plans each day's stops before the first truck leaves.
 *
 *   Pilot
 *   **Example Harbor Co**
 *   Three depots, *twelve* weeks.
 *   ```
 *
 * A `columns` fence holds two sides split by one `---` line. Each side holds
 * `###` or `####` headings, bullet lines and paragraphs:
 *
 *   ```columns
 *   ### Today
 *   - Paper route sheets
 *   - Calls to every depot
 *   ---
 *   ### With the platform
 *   One schedule every depot reads.
 *   ```
 *
 * Either may open with one `%% fabric-visual: <id>` line naming the visual it
 * came from, as stat tiles may; that line is never content.
 *
 * Titles, card text, headings, bullets and paragraphs carry inline marks:
 * {@link parseInlineMarks} reads them with the shared Markdown parser
 * (`markdown-ast.ts`) into segments of plain text. Every surface escapes
 * those segments itself; none of them inserts HTML.
 *
 * The fence keeps its body as plain text, so a block these parsers refuse is
 * still kept byte for byte: readers render it as an ordinary code block, and
 * the editor shows the reason beside the source. Every reason starts with
 * {@link CARDS_RULE} or {@link COLUMNS_RULE}.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

import type { PhrasingContent } from "mdast";
import { parseMarkdownAst } from "./markdown-ast";
import { VISUAL_MARKER_PATTERN } from "./stat-tiles";

/** The fence language that marks a card grid. */
export const CARDS_LANGUAGE = "cards";

/** The fence language that marks two columns. */
export const COLUMNS_LANGUAGE = "columns";

/**
 * What a cards block may hold. Lengths count characters, not UTF-16 units:
 * the label as written, the title and text as shown, without their marks.
 */
export const CARDS_LIMITS = {
	minItems: 1,
	maxItems: 8,
	maxLabelLength: 60,
	maxTitleLength: 120,
	maxTextLength: 600,
	/** The longest body read at all; anything longer is refused unsplit. */
	maxBodyLength: 6000,
} as const;

/**
 * What a columns block may hold. Lengths count characters, not UTF-16 units,
 * as shown, without their marks. Bullets count per side, across its lists.
 */
export const COLUMNS_LIMITS = {
	maxHeadingLength: 120,
	maxBulletLength: 400,
	maxBulletsPerColumn: 20,
	maxParagraphLength: 1200,
	/** The longest body read at all; anything longer is refused unsplit. */
	maxBodyLength: 6000,
} as const;

/**
 * The one-line rule a refused cards block is shown with. Every `reason`
 * starts with it, so whoever reads the reason learns the shape that would
 * render.
 */
export const CARDS_RULE =
	"Cards need 1–8 cards split by blank lines, each a label line followed by a **bold** title line, text, or both.";

/** The same for a refused columns block. */
export const COLUMNS_RULE =
	"Columns need two sides split by one --- line, each holding ### or #### headings, - bullets and paragraphs.";

/**
 * A run of text with the marks it carries. Nested marks combine, so
 * `***both***` is one segment with `bold` and `italic` set.
 */
export interface InlineSegment {
	text: string;
	bold: boolean;
	italic: boolean;
	code: boolean;
}

/** One card. A card always has a title, text, or both. */
export interface CardItem {
	/** The first line, trimmed and never read as Markdown. */
	label: string;
	/** The bold line after the label, without that bold; `null` if none. */
	title: InlineSegment[] | null;
	/** The remaining lines, joined with a space; `null` if none. */
	text: InlineSegment[] | null;
}

export type CardsParseResult =
	| {
			ok: true;
			/** The `%% fabric-visual:` id, or `null` for a hand-written block. */
			visualId: string | null;
			items: CardItem[];
	  }
	| { ok: false; reason: string };

/** One block of a column, in reading order. */
export type ColumnBlock =
	| { type: "heading"; segments: InlineSegment[] }
	| { type: "list"; items: InlineSegment[][] }
	| { type: "paragraph"; segments: InlineSegment[] };

export type ColumnsParseResult =
	| {
			ok: true;
			/** The `%% fabric-visual:` id, or `null` for a hand-written block. */
			visualId: string | null;
			/** The side before the `---` line, then the side after it. */
			columns: [ColumnBlock[], ColumnBlock[]];
	  }
	| { ok: false; reason: string };

/** Any line opening with this is a marker, valid only as the first line. */
const MARKER_PREFIX = "%%";

/** The line that splits two columns, trimmed. */
const COLUMN_SEPARATOR = "---";

/** An ATX heading of any level: its hashes, then its text. */
const HEADING_LINE = /^(#{1,6})(?:[ \t]+(.*))?$/;
/** A heading's optional closing hashes. */
const HEADING_CLOSING = /(?:^|[ \t]+)#+[ \t]*$/;
/** A bullet line: its marker, then its text. */
const BULLET_LINE = /^[-*+](?:[ \t]+(.*))?$/;
/** A numbered list item, `1.`, `10.` or `1)`. */
const ORDERED_LINE = /^\d{1,9}[.)](?:[ \t]|$)/;
const FENCE_LINE = /^(?:```|~~~)/;

/** Lines of `body`, CRLF and CR read as LF. */
function splitLines(body: string): string[] {
	return body.split(/\r\n|\r|\n/);
}

/**
 * Whether `text` holds more than `max` characters, counted in code points.
 * Stops counting at `max + 1`, so a huge body costs no more than a long one.
 */
function longerThan(text: string, max: number): boolean {
	if (text.length <= max) {
		return false;
	}
	let count = 0;
	for (const _character of text) {
		count += 1;
		if (count > max) {
			return true;
		}
	}
	return false;
}

function segmentsText(segments: readonly InlineSegment[]): string {
	return segments.map((segment) => segment.text).join("");
}

interface Marks {
	bold: boolean;
	italic: boolean;
	code: boolean;
}

const NO_MARKS: Marks = { bold: false, italic: false, code: false };

function sameMarks(a: Marks, b: Marks): boolean {
	return a.bold === b.bold && a.italic === b.italic && a.code === b.code;
}

/** Appends `text` with `marks`, merged into the last segment when they match. */
function pushSegment(
	segments: InlineSegment[],
	text: string,
	marks: Marks,
): void {
	if (text === "") {
		return;
	}
	const last = segments.at(-1);
	if (last && sameMarks(last, marks)) {
		last.text += text;
		return;
	}
	segments.push({ text, ...marks });
}

function collectSegments(
	nodes: readonly PhrasingContent[],
	marks: Marks,
	source: string,
	segments: InlineSegment[],
): void {
	for (const node of nodes) {
		switch (node.type) {
			case "text":
				pushSegment(segments, node.value, marks);
				break;
			case "strong":
				collectSegments(
					node.children,
					{ ...marks, bold: true },
					source,
					segments,
				);
				break;
			case "emphasis":
				collectSegments(
					node.children,
					{ ...marks, italic: true },
					source,
					segments,
				);
				break;
			case "inlineCode":
				pushSegment(segments, node.value, { ...marks, code: true });
				break;
			case "link":
				collectSegments(node.children, marks, source, segments);
				break;
			default: {
				// Raw HTML, images, strikethrough and the rest print as typed.
				const start = node.position?.start.offset;
				const end = node.position?.end.offset;
				if (start !== undefined && end !== undefined) {
					pushSegment(segments, source.slice(start, end), marks);
				}
			}
		}
	}
}

/** A leading numbered list marker: its number, then `.` or `)`. */
const LEADING_ORDERED = /^(\d{1,9})[.)](?=[ \t]|$)/;
/** A leading bullet marker. */
const LEADING_BULLET = /^[-*+](?=[ \t]|$)/;
/** A whole run that is a thematic break: three or more of `-`, `*` or `_`. */
const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * `source` with a leading block construct taken out of Markdown's reach: a
 * numbered or bullet list marker, a heading's `#`, a quote's `>` or a
 * thematic break. A backslash goes before its first punctuation character,
 * the number's `.` or `)` for a numbered marker, so the run reads as one
 * paragraph; decoding drops the backslash again, and the text prints as
 * written.
 */
function escapeLeadingBlock(source: string): string {
	const ordered = LEADING_ORDERED.exec(source);
	if (ordered) {
		const digits = ordered[1] ?? "";
		return `${digits}\\${source.slice(digits.length)}`;
	}
	if (
		LEADING_BULLET.test(source) ||
		THEMATIC_BREAK.test(source) ||
		source.startsWith("#") ||
		source.startsWith(">")
	) {
		return `\\${source}`;
	}
	return source;
}

/**
 * The inline marks of one run of text, as segments of plain text.
 *
 * Line breaks inside the run are read as one space and the run is trimmed.
 * It is read with the shared Markdown parser, so CommonMark's rules decide
 * what is a mark: `2 * 3 * 4`, `order_id and customer_id`, an unclosed `**`
 * and an escaped `\*` stay text. Bold, italic and inline code become marks,
 * and nested marks combine. A link keeps only its text. Anything else, raw
 * HTML and images among it, keeps its source exactly as typed. Text is
 * decoded, so `\*` reads as `*` and `&amp;` as `&`.
 *
 * A run that opens with a list marker, a heading's `#`, a quote's `>` or a
 * thematic break is text, not a block: `1. Today`, `+ Pros` and `---` print
 * as written, marks and all.
 *
 * Returns `null` when the run is still not exactly one paragraph: empty
 * text, or text Markdown reads as another block, such as a code fence or
 * raw HTML.
 */
export function parseInlineMarks(text: string): InlineSegment[] | null {
	const trimmed = splitLines(text)
		.map((line) => line.trim())
		.join(" ")
		.trim();
	if (trimmed === "") {
		return null;
	}
	const source = escapeLeadingBlock(trimmed);
	const blocks = parseMarkdownAst(source).children;
	const paragraph = blocks[0];
	if (blocks.length !== 1 || paragraph?.type !== "paragraph") {
		return null;
	}
	const segments: InlineSegment[] = [];
	collectSegments(paragraph.children, NO_MARKS, source, segments);
	return segments.length > 0 ? segments : null;
}

/**
 * The content of a line that is one bold run (`**…**` or `__…__`), without
 * that bold; `null` for any other line. `**a** and **b**` is not one run.
 */
function boldRunContent(line: string): InlineSegment[] | null {
	const blocks = parseMarkdownAst(line).children;
	const paragraph = blocks[0];
	if (blocks.length !== 1 || paragraph?.type !== "paragraph") {
		return null;
	}
	const only = paragraph.children[0];
	if (paragraph.children.length !== 1 || only?.type !== "strong") {
		return null;
	}
	const segments: InlineSegment[] = [];
	collectSegments(only.children, NO_MARKS, line, segments);
	return segments.length > 0 ? segments : null;
}

/** A body line, trimmed, with its 1-based number in the body. */
interface NumberedLine {
	text: string;
	/** The line as written, for the checks that read its indent. */
	raw: string;
	lineNumber: number;
}

type ContentLinesResult =
	| { ok: true; visualId: string | null; lines: (NumberedLine | null)[] }
	| { ok: false; detail: string };

/**
 * The body's lines with a leading `%% fabric-visual:` marker taken out.
 * Blank lines come back as `null`; the marker's own line does too, so the
 * content after it starts afresh. A malformed marker, or a `%%` line
 * anywhere but the first content line, refuses the block.
 */
function readContentLines(body: string): ContentLinesResult {
	const lines: (NumberedLine | null)[] = [];
	let visualId: string | null = null;
	let seenContent = false;

	for (const [index, raw] of splitLines(body).entries()) {
		const text = raw.trim();
		if (text === "") {
			lines.push(null);
			continue;
		}
		const lineNumber = index + 1;
		const isFirstContentLine = !seenContent;
		seenContent = true;

		if (text.startsWith(MARKER_PREFIX)) {
			if (!isFirstContentLine) {
				return {
					ok: false,
					detail: `Only the first line may be the fabric-visual marker (line ${lineNumber}).`,
				};
			}
			const marker = VISUAL_MARKER_PATTERN.exec(text);
			if (!marker) {
				return {
					ok: false,
					detail: `Line ${lineNumber} is not a valid fabric-visual marker.`,
				};
			}
			visualId = marker[1] ?? null;
			lines.push(null);
			continue;
		}
		lines.push({ text, raw, lineNumber });
	}
	return { ok: true, visualId, lines };
}

function refuseCards(detail: string): CardsParseResult {
	return { ok: false, reason: `${CARDS_RULE} ${detail}` };
}

type CardResult = { ok: true; item: CardItem } | { ok: false; detail: string };

function readCard(lines: NumberedLine[], cardNumber: number): CardResult {
	const [labelLine, ...rest] = lines;
	if (!labelLine) {
		return { ok: false, detail: `Card ${cardNumber} is empty.` };
	}
	const label = labelLine.text;
	if (boldRunContent(label)) {
		return {
			ok: false,
			detail: `Card ${cardNumber} opens with a bold line, but the first line is the label (line ${labelLine.lineNumber}).`,
		};
	}
	if (longerThan(label, CARDS_LIMITS.maxLabelLength)) {
		return {
			ok: false,
			detail: `The label of card ${cardNumber} is longer than ${CARDS_LIMITS.maxLabelLength} characters (line ${labelLine.lineNumber}).`,
		};
	}

	let textLines = rest;
	let title: InlineSegment[] | null = null;
	const titleLine = rest[0];
	const titleContent = titleLine ? boldRunContent(titleLine.text) : null;
	if (titleLine && titleContent) {
		if (
			longerThan(segmentsText(titleContent), CARDS_LIMITS.maxTitleLength)
		) {
			return {
				ok: false,
				detail: `The title of card ${cardNumber} is longer than ${CARDS_LIMITS.maxTitleLength} characters (line ${titleLine.lineNumber}).`,
			};
		}
		title = titleContent;
		textLines = rest.slice(1);
	}

	let text: InlineSegment[] | null = null;
	const firstTextLine = textLines[0];
	if (firstTextLine) {
		text = parseInlineMarks(textLines.map((line) => line.text).join(" "));
		if (!text) {
			return {
				ok: false,
				detail: `The text of card ${cardNumber} must be plain text with bold, italic, code or links, not a code fence, raw HTML or other block (line ${firstTextLine.lineNumber}).`,
			};
		}
		if (longerThan(segmentsText(text), CARDS_LIMITS.maxTextLength)) {
			return {
				ok: false,
				detail: `The text of card ${cardNumber} is longer than ${CARDS_LIMITS.maxTextLength} characters (line ${firstTextLine.lineNumber}).`,
			};
		}
	}

	if (!title && !text) {
		return {
			ok: false,
			detail: `Card ${cardNumber} has a label but no title or text (line ${labelLine.lineNumber}).`,
		};
	}
	return { ok: true, item: { label, title, text } };
}

/**
 * Read a cards fence body (the text between the fences).
 *
 * Strict by design, because a refused block still renders, as code. Blank
 * lines split the body into one to eight cards. A card's first line is its
 * label, at most 60 characters and kept as written; a label line that is
 * one bold run is refused, since a title never comes first. A next line that
 * is one bold run (`**…**`) is the title, at most 120 characters. The lines
 * after that join with a space into the text, at most 600 characters, which
 * must read as one paragraph of inline marks. A card needs a title, text, or
 * both. Only the first non-blank line may be the `%% fabric-visual: <id>`
 * marker. CRLF line ends are read as LF.
 */
export function parseCards(body: string): CardsParseResult {
	if (longerThan(body, CARDS_LIMITS.maxBodyLength)) {
		return refuseCards(
			`This block is longer than ${CARDS_LIMITS.maxBodyLength} characters.`,
		);
	}
	const content = readContentLines(body);
	if (!content.ok) {
		return refuseCards(content.detail);
	}

	const groups: NumberedLine[][] = [];
	let current: NumberedLine[] | null = null;
	for (const line of content.lines) {
		if (!line) {
			current = null;
			continue;
		}
		if (!current) {
			current = [];
			groups.push(current);
			if (groups.length > CARDS_LIMITS.maxItems) {
				return refuseCards(
					`This block has more than ${CARDS_LIMITS.maxItems} (line ${line.lineNumber}).`,
				);
			}
		}
		current.push(line);
	}
	if (groups.length < CARDS_LIMITS.minItems) {
		return refuseCards("This block has none.");
	}

	const items: CardItem[] = [];
	for (const [index, group] of groups.entries()) {
		const card = readCard(group, index + 1);
		if (!card.ok) {
			return refuseCards(card.detail);
		}
		items.push(card.item);
	}
	return { ok: true, visualId: content.visualId, items };
}

function refuseColumns(detail: string): ColumnsParseResult {
	return { ok: false, reason: `${COLUMNS_RULE} ${detail}` };
}

type ColumnResult =
	| { ok: true; blocks: ColumnBlock[] }
	| { ok: false; detail: string };

/**
 * Why a line opens a block a column does not hold, or `null` when it may be
 * a paragraph line. Headings and bullets are read before this.
 */
function unsupportedBlock(line: string): string | null {
	if (line.startsWith(">")) {
		return "a quote";
	}
	if (line.startsWith("|")) {
		return "a table row";
	}
	if (line.startsWith("![")) {
		return "an image";
	}
	if (FENCE_LINE.test(line)) {
		return "a code fence";
	}
	if (ORDERED_LINE.test(line)) {
		return "a numbered list item";
	}
	return null;
}

function readColumn(
	lines: (NumberedLine | null)[],
	side: string,
): ColumnResult {
	const blocks: ColumnBlock[] = [];
	let paragraphLines: NumberedLine[] = [];
	let list: InlineSegment[][] | null = null;
	let bulletCount = 0;

	const flushParagraph = (): string | null => {
		const first = paragraphLines[0];
		if (!first) {
			return null;
		}
		const segments = parseInlineMarks(
			paragraphLines.map((line) => line.text).join(" "),
		);
		paragraphLines = [];
		if (!segments) {
			return `The paragraph on line ${first.lineNumber} of the ${side} column must be plain text with bold, italic, code or links.`;
		}
		if (
			longerThan(
				segmentsText(segments),
				COLUMNS_LIMITS.maxParagraphLength,
			)
		) {
			return `The paragraph on line ${first.lineNumber} of the ${side} column is longer than ${COLUMNS_LIMITS.maxParagraphLength} characters.`;
		}
		blocks.push({ type: "paragraph", segments });
		return null;
	};

	for (const line of [...lines, null]) {
		// A blank line ends a paragraph. A list goes on until a heading or a
		// paragraph line, so a loosely written list stays one list.
		if (!line) {
			const refused = flushParagraph();
			if (refused) {
				return { ok: false, detail: refused };
			}
			continue;
		}
		const { text, raw, lineNumber } = line;

		const heading = HEADING_LINE.exec(text);
		const bullet = BULLET_LINE.exec(text);
		const unsupported = unsupportedBlock(text);
		if (heading || bullet || unsupported) {
			const refused = flushParagraph();
			if (refused) {
				return { ok: false, detail: refused };
			}
		}

		if (heading) {
			list = null;
			const level = heading[1]?.length ?? 0;
			if (level !== 3 && level !== 4) {
				return {
					ok: false,
					detail: `Line ${lineNumber} is a level ${level} heading.`,
				};
			}
			const headingText = (heading[2] ?? "")
				.replace(HEADING_CLOSING, "")
				.trim();
			const segments = parseInlineMarks(headingText);
			if (!segments) {
				return {
					ok: false,
					detail: `The heading on line ${lineNumber} needs plain text.`,
				};
			}
			if (
				longerThan(
					segmentsText(segments),
					COLUMNS_LIMITS.maxHeadingLength,
				)
			) {
				return {
					ok: false,
					detail: `The heading on line ${lineNumber} is longer than ${COLUMNS_LIMITS.maxHeadingLength} characters.`,
				};
			}
			blocks.push({ type: "heading", segments });
			continue;
		}

		if (bullet) {
			if (raw.trimStart() !== raw) {
				return {
					ok: false,
					detail: `Line ${lineNumber} is an indented bullet; a column holds one level of bullets.`,
				};
			}
			const segments = parseInlineMarks(bullet[1] ?? "");
			if (!segments) {
				return {
					ok: false,
					detail: `The bullet on line ${lineNumber} needs plain text with bold, italic, code or links.`,
				};
			}
			if (
				longerThan(
					segmentsText(segments),
					COLUMNS_LIMITS.maxBulletLength,
				)
			) {
				return {
					ok: false,
					detail: `The bullet on line ${lineNumber} is longer than ${COLUMNS_LIMITS.maxBulletLength} characters.`,
				};
			}
			bulletCount += 1;
			if (bulletCount > COLUMNS_LIMITS.maxBulletsPerColumn) {
				return {
					ok: false,
					detail: `The ${side} column has more than ${COLUMNS_LIMITS.maxBulletsPerColumn} bullets (line ${lineNumber}).`,
				};
			}
			if (!list) {
				list = [];
				blocks.push({ type: "list", items: list });
			}
			list.push(segments);
			continue;
		}

		if (unsupported) {
			return {
				ok: false,
				detail: `Line ${lineNumber} is ${unsupported}.`,
			};
		}

		list = null;
		paragraphLines.push(line);
	}

	if (blocks.length === 0) {
		return { ok: false, detail: `The ${side} column is empty.` };
	}
	return { ok: true, blocks };
}

/**
 * Read a columns fence body (the text between the fences).
 *
 * Strict by design, because a refused block still renders, as code. Exactly
 * one `---` line splits the body into a left and a right column, and
 * neither may be empty. Each holds, in any order:
 *
 * - `###` and `####` headings, at most 120 characters;
 * - bullet lines opening with `-`, `*` or `+`, at most 400 characters each
 *   and 20 a side; consecutive bullet lines form one list, blank lines
 *   between them included;
 * - paragraphs: consecutive other lines joined with a space, at most 1,200
 *   characters, ended by a blank line, a heading or a bullet.
 *
 * Headings of other levels, quotes, table rows, images, code fences,
 * numbered items and indented bullets are refused. Headings, bullets and
 * paragraphs must each read as one paragraph of inline marks. Only the first
 * non-blank line may be the `%% fabric-visual: <id>` marker. CRLF line ends
 * are read as LF.
 */
export function parseColumns(body: string): ColumnsParseResult {
	if (longerThan(body, COLUMNS_LIMITS.maxBodyLength)) {
		return refuseColumns(
			`This block is longer than ${COLUMNS_LIMITS.maxBodyLength} characters.`,
		);
	}
	const content = readContentLines(body);
	if (!content.ok) {
		return refuseColumns(content.detail);
	}

	const separators = content.lines.filter(
		(line): line is NumberedLine => line?.text === COLUMN_SEPARATOR,
	);
	const [separator, extra] = separators;
	if (!separator) {
		return refuseColumns("This block has no --- line between the columns.");
	}
	if (extra) {
		return refuseColumns(
			`This block has more than one --- line (lines ${separator.lineNumber} and ${extra.lineNumber}).`,
		);
	}

	const split = content.lines.indexOf(separator);
	const left = readColumn(content.lines.slice(0, split), "left");
	if (!left.ok) {
		return refuseColumns(left.detail);
	}
	const right = readColumn(content.lines.slice(split + 1), "right");
	if (!right.ok) {
		return refuseColumns(right.detail);
	}
	return {
		ok: true,
		visualId: content.visualId,
		columns: [left.blocks, right.blocks],
	};
}
