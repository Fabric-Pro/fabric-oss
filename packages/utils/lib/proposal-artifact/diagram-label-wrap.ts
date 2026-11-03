/**
 * A flowchart's long node labels broken into lines, and a sideways
 * flowchart turned top-down (Fizzy #2946), so its labels stay legible when
 * the diagram is shrunk to a column. The live page and the Proposal export
 * (`render-diagrams.ts` in the Temporal package) both draw with it, with the
 * same canvas margin, the same rule for which labels are too wide for their
 * boxes, the same choice between a fence's laid-out copies and the same
 * print floor, so a fence is laid out alike on the page and in the PDF,
 * except that the page measures every fence against a figure's own height
 * while the PDF measures one that prints on a section opener's page against
 * the shorter height it is offered there, and may choose another layout
 * for it, or keep a figure's own height when that one would take its labels
 * below the floor. Pure string work, browser-safe.
 *
 * Only the copy that is drawn changes: the fence a document holds is never
 * rewritten. Only a `graph`/`flowchart` source is touched; its header line
 * and every `%%` line stay as written, and so does a label already broken
 * into lines or formatted across words. The header is found as the engine
 * finds it, the first line neither blank nor a `%%` comment, so a generated
 * fence's marker line may come first; the export's copy, from which `%%`
 * lines are already stripped, reads the same either way.
 *
 * The node shapes and the edge walk mirror beautiful-mermaid 1.1.3's
 * flowchart parser, so a label is found exactly where the engine finds it:
 * re-check them on an engine upgrade.
 */

import { INTER_ADVANCE_EM_THOUSANDTHS } from "./inter-advances";
import {
	PRINT_FIGURE_MAX_HEIGHT_PX,
	PROPOSAL_PAGE_SIZE,
} from "./proposal-theme";

/**
 * The tallest a printed figure may be, in CSS pixels, and the most it may be
 * on a section opener's page, less under a long one or after short blocks:
 * the print layer's own `max-height` limits
 * (`./proposal-theme-print-page-flow`), one number each for the rule and the
 * measure.
 * The first is also the height the Word writer shrinks a taller picture to
 * (`MAX_IMAGE_HEIGHT`), as the export's parity test checks; the Word writer
 * has no shorter one.
 */
export {
	PRINT_FIGURE_MAX_HEIGHT_PX,
	PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
} from "./proposal-theme";

/**
 * Portrait page widths in twips (twentieths of a point), one per size the
 * page-size constant may name. These, the side margin and the pixel ratio
 * below restate the Word writer's page geometry (`build-docx/styles.ts` in
 * the Temporal package, which this browser-safe module cannot import), the
 * page the export prints on; keep them equal, as the export's parity test
 * checks.
 */
const PAGE_WIDTH_TWIPS = {
	letter: 12240,
} as const satisfies Record<typeof PROPOSAL_PAGE_SIZE, number>;

/** The print page's side margin, in twips: 0.8in. */
const PAGE_SIDE_MARGIN_TWIPS = 1152;

/** Twips per CSS pixel: 1440 per inch over 96 pixels per inch. */
const TWIPS_PER_PIXEL = 15;

/**
 * The print column in CSS pixels: the portrait page less its side margins,
 * the width the print layer's `max-width: 100%` shrinks a diagram to.
 */
export const PRINT_COLUMN_PX =
	(PAGE_WIDTH_TWIPS[PROPOSAL_PAGE_SIZE] - 2 * PAGE_SIDE_MARGIN_TWIPS) /
	TWIPS_PER_PIXEL;

/** The smallest a printed diagram's node labels may be, in points. */
export const PRINT_LABEL_FLOOR_PT = 9;

/**
 * The blank margin a laid-out graph keeps around what it draws, in CSS
 * pixels: room for the outermost strokes. The engine's own 40 px is empty
 * paper in print, where the figure has margins of its own, and made a
 * figure's box taller than its drawing, so a short diagram that would fit on
 * the rest of a page moved to the next one whole. Only flowcharts and state
 * diagrams take it; the engine sets the other kinds' margins itself. The
 * live page draws with it too, so a drawing is as wide there as in print.
 */
export const DIAGRAM_CANVAS_PADDING_PX = 8;

/** beautiful-mermaid's node label size, in CSS pixels (its `FONT_SIZES`). */
const NODE_LABEL_PX = 13;

/** Points per CSS pixel: 72 per inch over 96. */
const PT_PER_PX = 0.75;

/**
 * Text of `textPx` CSS pixels in a drawing, as printed, in points, from the
 * drawing's size in CSS pixels: shrunk to the print column when it is
 * wider, and to the tallest its figure may print when it is taller,
 * whichever shrinks it more. That height is a figure's own,
 * {@link PRINT_FIGURE_MAX_HEIGHT_PX}, unless the figure prints right after a
 * section opener (at most `PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX`).
 */
export function printedTextPt(
	textPx: number,
	size: { width: number; height: number },
	figureMaxHeightPx: number = PRINT_FIGURE_MAX_HEIGHT_PX,
): number {
	return (
		textPx *
		Math.min(
			1,
			PRINT_COLUMN_PX / size.width,
			figureMaxHeightPx / size.height,
		) *
		PT_PER_PX
	);
}

/**
 * A drawn diagram's node labels as printed, in points
 * ({@link printedTextPt} at the engine's label size).
 */
export function printedNodeLabelPt(
	size: { width: number; height: number },
	figureMaxHeightPx: number = PRINT_FIGURE_MAX_HEIGHT_PX,
): number {
	return printedTextPt(NODE_LABEL_PX, size, figureMaxHeightPx);
}

/**
 * The tallest a figure's drawing prints where the page offers it at most
 * `offeredPx`: a figure's own height, or less as the first figure on a
 * section opener's page. A drawing shrunk to `offeredPx` keeps it only when
 * its text of `textPx` CSS pixels (the engine's node labels unless given;
 * a figure template's 12 px) still prints at {@link PRINT_LABEL_FLOOR_PT}
 * or more there, that is when `offeredPx` is at least the height at which
 * that text reaches the floor. Otherwise the figure keeps a figure's own
 * height, {@link PRINT_FIGURE_MAX_HEIGHT_PX}, and moves to the next page
 * whole when the opener's page cannot hold it as drawn; only a drawing
 * whose text cannot reach the floor on any page prints below it. A figure
 * template, whose text is exactly at the floor at full size, is never
 * shrunk under an opener. The print page writes this height on the figure
 * and the export measures its labels against it, so the two agree.
 */
export function legibleFigureMaxHeightPx(
	offeredPx: number,
	size: { width: number; height: number },
	textPx: number = NODE_LABEL_PX,
): number {
	return printedTextPt(textPx, size, offeredPx) >= PRINT_LABEL_FLOOR_PT
		? offeredPx
		: Math.max(offeredPx, PRINT_FIGURE_MAX_HEIGHT_PX);
}

/** A left-to-right or right-to-left flowchart header line. */
const SIDEWAYS_HEADER = /^(\s*(?:graph|flowchart)\s+)(?:LR|RL)(\s*)$/i;

/** A flowchart header line, with or without its direction. */
const FLOWCHART_HEADER = /^\s*(?:graph|flowchart)\s/i;

/**
 * The index of a source's header line, as the engine finds it: the first
 * line that is neither blank nor a `%%` comment; -1 when there is none.
 */
function headerIndexOf(lines: readonly string[]): number {
	return lines.findIndex((line) => {
		const trimmed = line.trim();
		return trimmed.length > 0 && !trimmed.startsWith("%%");
	});
}

/**
 * A flowchart's copy with its `LR`/`RL` header turned `TD`, or null when its
 * header is not sideways. Only the header line changes.
 */
export function turnFlowchartTopDown(source: string): string | null {
	const lines = source.split("\n");
	const headerIndex = headerIndexOf(lines);
	const header = lines[headerIndex];
	if (header === undefined || !SIDEWAYS_HEADER.test(header)) {
		return null;
	}
	lines[headerIndex] = header.replace(SIDEWAYS_HEADER, "$1TD$2");
	return lines.join("\n");
}

/** The longest line a broken node label gets, in characters. */
const WRAPPED_LABEL_LINE_CHARS = 30;

/**
 * beautiful-mermaid 1.1.3's padding inside a node's box, a side, in CSS
 * pixels (its `NODE_PADDING.horizontal`). A rectangle is the narrowest box
 * it draws around a label of a given width; every other shape is as wide
 * or wider, so a label that fits a rectangle fits them all. That padding is
 * the engine's own, inside every box; {@link DIAGRAM_CANVAS_PADDING_PX} is
 * the margin around the whole drawing and does not change it.
 */
const NODE_LABEL_PADDING_PX = 20;

/**
 * The least room a node label keeps to each side of its box, in CSS pixels.
 * Closer than about a third of the label's size, text reads as touching its
 * border; the room also covers kerning, which moved a measured label up to
 * 0.6 px from the sum of its glyphs, and the box's 1 px stroke.
 */
const LABEL_CLEARANCE_PX = 4;

/**
 * Inter's own advance of each character in its table
 * (`./inter-advances`), in CSS pixels at the label size. Against the
 * engine's estimate, Inter is wider for an em dash by 5.6 px, a space by
 * 1.4 px (a quarter of what a prose label runs over), m by 2.7, a hyphen by
 * 2.3, w by 1.9, t and f by about 1.4, and a Cyrillic or Greek capital by 1
 * to 3, while s, r and capital E, F and L are narrower.
 */
const INTER_ADVANCE_PX: ReadonlyMap<string, number> = new Map(
	Object.entries(INTER_ADVANCE_EM_THOUSANDTHS).map(([char, advance]) => [
		char,
		(advance * NODE_LABEL_PX) / 1000,
	]),
);

/**
 * The width predicted for a capital letter outside Inter's table, in CSS
 * pixels: 0.72 em, as wide as Inter's wider capitals, since the engine
 * counts such a letter as an average lower-case one and a label of them
 * would otherwise spill unpredicted.
 */
const UNLISTED_CAPITAL_PX = 0.72 * NODE_LABEL_PX;

/** A capital letter of any script. */
const CAPITAL_LETTER = /^\p{Lu}$/u;

/**
 * beautiful-mermaid 1.1.3's width of a character relative to an average
 * lower-case letter (`getCharWidth` in its text metrics), for the
 * characters Inter's table holds and their accented forms; a CJK character
 * or an emoji, which it counts double, and a combining mark, which it
 * counts as nothing, are not mirrored. Re-check on an engine upgrade; the
 * export's engine parity test draws labels to check it.
 */
function engineCharWidth(char: string): number {
	if (char === " ") {
		return 0.3;
	}
	if (char === "W" || char === "M") {
		return 1.5;
	}
	if ("wm@%".includes(char)) {
		return 1.2;
	}
	if ("iltfjI1!|.,:;'".includes(char)) {
		return 0.4;
	}
	if ('()[]{}/\\-"`'.includes(char)) {
		return 0.5;
	}
	if (char === "r") {
		return 0.8;
	}
	return /^[A-Z]$/.test(char) ? 1.2 : 1;
}

/**
 * beautiful-mermaid 1.1.3's estimate of a label line's width at its node
 * label weight, 500 (`measureTextWidth`): 0.57 of the size an average
 * letter, plus 0.15 of the size a line.
 */
const ENGINE_LETTER_PX = NODE_LABEL_PX * 0.57;
const ENGINE_LINE_EXTRA_PX = NODE_LABEL_PX * 0.15;

/**
 * Whether one line of node label text would come closer than
 * {@link LABEL_CLEARANCE_PX} to the sides of the box beautiful-mermaid
 * draws around it: its width predicted from Inter's own advances, against
 * the engine's estimate of it plus the padding a side. The engine's
 * estimate runs short of Inter, most for text dense in dashes, m, w,
 * hyphens and spaces, so a label of 30 such characters can spill while a
 * 55-character prose label fits. The live page, print and the browser
 * download break labels by it alike; the download draws in Helvetica,
 * narrower than Inter, so its labels get more room.
 */
export function nodeLabelLineOverflows(text: string): boolean {
	return nodeLabelOverflows([text]);
}

/** One line of node label text's width in CSS pixels, as beautiful-mermaid estimates it. */
function engineLineWidthPx(text: string): number {
	let estimate = ENGINE_LINE_EXTRA_PX;
	for (const char of text) {
		estimate += engineCharWidth(char) * ENGINE_LETTER_PX;
	}
	return estimate;
}

/**
 * One line of node label text's width in CSS pixels, predicted from Inter's
 * own advances. An accented letter takes its base letter's width, a capital
 * outside the table {@link UNLISTED_CAPITAL_PX} or the engine's estimate,
 * whichever is wider, and any other character the engine's estimate.
 */
function predictedLineWidthPx(text: string): number {
	let predicted = 0;
	for (const char of text) {
		const engineWidth = engineCharWidth(char) * ENGINE_LETTER_PX;
		predicted +=
			INTER_ADVANCE_PX.get(char) ??
			INTER_ADVANCE_PX.get(char.normalize("NFD").charAt(0)) ??
			(CAPITAL_LETTER.test(char)
				? Math.max(engineWidth, UNLISTED_CAPITAL_PX)
				: engineWidth);
	}
	return predicted;
}

/**
 * The width of the box beautiful-mermaid draws around a node label's lines,
 * in CSS pixels: its estimate of the widest line plus its padding a side
 * (`measureMultilineText`), as it sizes a rectangle, the narrowest shape it
 * draws around a label. A box it would draw narrower than its own minimum
 * is widened to that, which only adds room.
 */
export function nodeLabelBoxWidthPx(lines: readonly string[]): number {
	return (
		Math.max(...lines.map(engineLineWidthPx)) + 2 * NODE_LABEL_PADDING_PX
	);
}

/**
 * Whether a node label's lines would come closer than
 * {@link LABEL_CLEARANCE_PX} to the sides of the box beautiful-mermaid draws
 * around them ({@link nodeLabelBoxWidthPx}). Each line is predicted on its
 * own, so a short line dense in dashes can sit under a long one of prose.
 */
function nodeLabelOverflows(lines: readonly string[]): boolean {
	const box = nodeLabelBoxWidthPx(lines);
	return lines.some(
		(line) => predictedLineWidthPx(line) + 2 * LABEL_CLEARANCE_PX > box,
	);
}

/**
 * beautiful-mermaid 1.1.3's flowchart node shapes, in the order its parser
 * tries them (`NODE_PATTERNS`); the second group is the label as written,
 * `open` characters after the id.
 */
const NODE_PATTERNS: readonly { regex: RegExp; shape: string; open: number }[] =
	[
		{ regex: /^([\w-]+)\(\(\((.+?)\)\)\)/, shape: "doublecircle", open: 3 },
		{ regex: /^([\w-]+)\(\[(.+?)\]\)/, shape: "stadium", open: 2 },
		{ regex: /^([\w-]+)\(\((.+?)\)\)/, shape: "circle", open: 2 },
		{ regex: /^([\w-]+)\[\[(.+?)\]\]/, shape: "subroutine", open: 2 },
		{ regex: /^([\w-]+)\[\((.+?)\)\]/, shape: "cylinder", open: 2 },
		{ regex: /^([\w-]+)\[\/(.+?)\\\]/, shape: "trapezoid", open: 2 },
		{ regex: /^([\w-]+)\[\\(.+?)\/\]/, shape: "trapezoid-alt", open: 2 },
		{ regex: /^([\w-]+)>(.+?)\]/, shape: "asymmetric", open: 1 },
		{ regex: /^([\w-]+)\{\{(.+?)\}\}/, shape: "hexagon", open: 2 },
		{ regex: /^([\w-]+)\[(.+?)\]/, shape: "rectangle", open: 1 },
		{ regex: /^([\w-]+)\((.+?)\)/, shape: "rounded", open: 1 },
		{ regex: /^([\w-]+)\{(.+?)\}/, shape: "diamond", open: 1 },
	];
const BARE_NODE = /^[\w-]+/;
const CLASS_SHORTHAND = /^:::[\w][\w-]*/;
const ARROW = /^(<)?(-->|-.->|==>|---|-\.-|===)(?:\|([^|]*)\|)?/;
const TEXT_ARROW = /^(<)?(--|-\.|==)\s+(.+?)\s+(-->|---|\.->|-\.-|==>|===)/;

/** Lines the engine's flowchart parser reads as something other than edges. */
const NON_EDGE_LINES: readonly RegExp[] = [
	/^classDef\s+(\w+)\s+(.+)$/,
	/^class\s+([\w,-]+)\s+(\w+)$/,
	/^style\s+([\w,-]+)\s+(.+)$/,
	/^linkStyle\s+(default|[\d,\s]+)\s+(.+)$/,
	/^direction\s+(TD|TB|LR|BT|RL)\s*$/i,
	/^subgraph\s+(.+)$/,
	/^end$/,
];

/** A line break inside a label, as both Mermaid engines read it. */
const LABEL_BREAK = "<br/>";

/** A label already broken into lines, or formatted across words. */
const UNWRAPPABLE_LABEL = /<br\s*\/?>|\\n|[*`<]|~~/i;

/** The first " — ", " – " or " - " between a label's title and its sentence. */
const TITLE_DASH = /\s+([—–-])\s+/;

/** A label's last parenthesis, balanced and at its very end. */
const TRAILING_PARENTHESIS = /\s+(\([^()]*\))$/;

interface LabelSpan {
	shape: string;
	start: number;
	end: number;
}

/**
 * Where each node label of one trimmed flowchart line sits, walked as the
 * engine walks it (`parseEdgeLine`): a node group joined by `&`, then an
 * arrow, a group, and so on until something is not one.
 */
function nodeLabelSpans(line: string): LabelSpan[] {
	const spans: LabelSpan[] = [];
	let at = 0;
	const skipSpace = () => {
		while (at < line.length && /\s/.test(line.charAt(at))) {
			at++;
		}
	};
	const consumeNode = (): boolean => {
		const rest = line.slice(at);
		let length = 0;
		for (const { regex, shape, open } of NODE_PATTERNS) {
			const match = regex.exec(rest);
			if (match) {
				const start = at + String(match[1]).length + open;
				spans.push({
					shape,
					start,
					end: start + String(match[2]).length,
				});
				length = match[0].length;
				break;
			}
		}
		if (length === 0) {
			length = BARE_NODE.exec(rest)?.[0].length ?? 0;
		}
		if (length === 0) {
			return false;
		}
		at += length;
		at += CLASS_SHORTHAND.exec(line.slice(at))?.[0].length ?? 0;
		return true;
	};
	const consumeGroup = (): boolean => {
		if (!consumeNode()) {
			return false;
		}
		skipSpace();
		while (line.charAt(at) === "&") {
			at++;
			skipSpace();
			if (!consumeNode()) {
				break;
			}
			skipSpace();
		}
		return true;
	};
	if (!consumeGroup()) {
		return spans;
	}
	while (at < line.length) {
		const rest = line.slice(at);
		const arrow = ARROW.exec(rest) ?? TEXT_ARROW.exec(rest);
		if (!arrow) {
			break;
		}
		at += arrow[0].length;
		skipSpace();
		if (!consumeGroup()) {
			break;
		}
	}
	return spans;
}

/** A spaced dash, which stays at the end of the word before it. */
const LONE_DASH = /^[—–-]$/;

/**
 * `text` greedily wrapped at spaces: a line ends before the word that would
 * make it longer than {@link WRAPPED_LABEL_LINE_CHARS} or too wide for its
 * box. A word that is either alone stays whole, and a spaced dash never
 * starts a line.
 */
function wrapAtWords(text: string): string[] {
	const words: string[] = [];
	for (const word of text.split(" ")) {
		const last = words.length - 1;
		if (LONE_DASH.test(word) && last >= 0) {
			words[last] = `${words[last]} ${word}`;
		} else {
			words.push(word);
		}
	}
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const longer = `${line} ${word}`;
		if (
			line &&
			(Array.from(longer).length > WRAPPED_LABEL_LINE_CHARS ||
				nodeLabelLineOverflows(longer))
		) {
			lines.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) {
		lines.push(line);
	}
	return lines;
}

/**
 * A single-line label's text broken into lines with `<br/>`, or null to
 * leave it as written: the title before a spaced dash (the dash kept at its
 * end), the sentence, and a trailing parenthesis each start a line of their
 * own, and each wraps at words. Every word stays, in order; only spacing
 * changes. A label too wide for its box is broken; with `overflowingOnly`
 * unset, so is one longer than a wrapped line.
 */
function wrapLabelText(text: string, overflowingOnly: boolean): string | null {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (
		UNWRAPPABLE_LABEL.test(collapsed) ||
		!(
			nodeLabelLineOverflows(collapsed) ||
			(!overflowingOnly &&
				Array.from(collapsed).length > WRAPPED_LABEL_LINE_CHARS)
		)
	) {
		return null;
	}
	const parts: string[] = [];
	let rest = collapsed;
	const dash = TITLE_DASH.exec(rest);
	if (dash && dash.index > 0 && dash.index + dash[0].length < rest.length) {
		parts.push(`${rest.slice(0, dash.index)} ${dash[1]}`);
		rest = rest.slice(dash.index + dash[0].length);
	}
	const parenthesis = TRAILING_PARENTHESIS.exec(rest);
	const tail = parenthesis && parenthesis.index > 0 ? parenthesis[1] : null;
	if (parenthesis && tail) {
		rest = rest.slice(0, parenthesis.index);
	}
	parts.push(rest);
	if (tail) {
		parts.push(tail);
	}
	const lines = parts.flatMap(wrapAtWords);
	return lines.length > 1 ? lines.join(LABEL_BREAK) : null;
}

/** A label's text as the engine draws it, ignoring line breaks and spacing. */
function labelWords(label: string): string {
	const unquoted =
		label.length >= 2 && label.startsWith('"') && label.endsWith('"')
			? label.slice(1, -1)
			: label;
	return unquoted
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** One trimmed flowchart line with its node labels broken, or as is. */
function wrapLineLabels(line: string, overflowingOnly: boolean): string {
	const spans = nodeLabelSpans(line);
	let rewritten = line;
	for (const span of [...spans].reverse()) {
		const label = line.slice(span.start, span.end);
		const quoted =
			label.length >= 2 && label.startsWith('"') && label.endsWith('"');
		const wrapped = wrapLabelText(
			quoted ? label.slice(1, -1) : label,
			overflowingOnly,
		);
		if (wrapped !== null) {
			rewritten = `${rewritten.slice(0, span.start)}${
				quoted ? `"${wrapped}"` : wrapped
			}${rewritten.slice(span.end)}`;
		}
	}
	if (rewritten === line) {
		return line;
	}
	// The engine must find the same nodes, shapes and words in the rewritten
	// line; anything else keeps the line as written.
	const after = nodeLabelSpans(rewritten);
	const same =
		after.length === spans.length &&
		after.every((span, index) => {
			const before = spans[index];
			return (
				before !== undefined &&
				span.shape === before.shape &&
				labelWords(rewritten.slice(span.start, span.end)) ===
					labelWords(line.slice(before.start, before.end))
			);
		});
	return same ? rewritten : line;
}

interface WrapFlowchartNodeLabelsOptions {
	/**
	 * Break only the labels too wide for their boxes
	 * ({@link nodeLabelLineOverflows}); without it, every label longer than
	 * one wrapped line is broken too.
	 */
	overflowingOnly?: boolean;
}

/**
 * A flowchart's copy with its single-line node labels too wide for their
 * boxes, or (without `overflowingOnly`) longer than one wrapped line,
 * broken into lines; null when it is not a flowchart or no label changed.
 * The lines before the header, the header itself, `%%` lines and the lines
 * the engine reads as anything but edges (`classDef`, `class`, `style`,
 * `subgraph` and the like) stay as written.
 */
export function wrapFlowchartNodeLabels(
	source: string,
	{ overflowingOnly = false }: WrapFlowchartNodeLabelsOptions = {},
): string | null {
	const lines = source.split("\n");
	const headerIndex = headerIndexOf(lines);
	if (!FLOWCHART_HEADER.test(lines[headerIndex] ?? "")) {
		return null;
	}
	let changed = false;
	const rewritten = lines.map((line, index) => {
		const trimmed = line.trim();
		if (index <= headerIndex || !isEdgeLine(trimmed)) {
			return line;
		}
		const wrapped = wrapLineLabels(trimmed, overflowingOnly);
		if (wrapped === trimmed) {
			return line;
		}
		changed = true;
		return `${line.slice(0, line.length - line.trimStart().length)}${wrapped}`;
	});
	return changed ? rewritten.join("\n") : null;
}

/**
 * Whether one trimmed line after a flowchart's header is read by the engine
 * as edges and nodes: neither blank, a `%%` comment, nor one of
 * {@link NON_EDGE_LINES}.
 */
function isEdgeLine(trimmed: string): boolean {
	return (
		trimmed.length > 0 &&
		!trimmed.startsWith("%%") &&
		!NON_EDGE_LINES.some((pattern) => pattern.test(trimmed))
	);
}

/** Where both Mermaid engines break a label into lines. */
const DRAWN_LINE_BREAK = /<br\s*\/?>|\\n/i;

/**
 * A node label's lines as the engine draws them: unquoted, broken at
 * `<br/>` and `\n`, spacing collapsed. Inline formatting, which no label
 * wrap ever touches, counts as written.
 */
function drawnLabelLines(label: string): string[] {
	const unquoted =
		label.length >= 2 && label.startsWith('"') && label.endsWith('"')
			? label.slice(1, -1)
			: label;
	return unquoted
		.split(DRAWN_LINE_BREAK)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0);
}

/**
 * Whether a flowchart's copy has a node label too wide for its box, each
 * line of a broken label measured in the box its widest line sets
 * ({@link nodeLabelLineOverflows} for a label on one line). False for any
 * other diagram, and edge labels and subgraph titles are not read: they sit
 * in no box. The live page and print weigh a fence's copies by it alike
 * ({@link printsBetter}).
 */
export function flowchartNodeLabelsOverflow(source: string): boolean {
	const lines = source.split("\n");
	const headerIndex = headerIndexOf(lines);
	if (!FLOWCHART_HEADER.test(lines[headerIndex] ?? "")) {
		return false;
	}
	return lines.some((line, index) => {
		const trimmed = line.trim();
		return (
			index > headerIndex &&
			isEdgeLine(trimmed) &&
			nodeLabelSpans(trimmed).some((span) =>
				nodeLabelOverflows(
					drawnLabelLines(trimmed.slice(span.start, span.end)),
				),
			)
		);
	});
}

/** A laid-out copy of a fence, as the choice between its copies weighs it. */
export interface WeighedDiagramCopy {
	/** Its node labels as printed, in points; null when its size is unknown. */
	labelPt: number | null;
	/** Whether a node label of it is too wide for its box. */
	labelsOverflow: boolean;
}

/**
 * Whether `copy` is drawn rather than `kept`, both laid out from one fence.
 * A copy whose node labels all fit their boxes beats one with a label that
 * spills out of its box, however much larger the other prints: breaking
 * labels makes a diagram taller, and a tall one prints smaller, which the
 * floor warning reports, while a label across its box's border reads as a
 * fault in the drawing. Between two copies that fit, or two that spill, the
 * one whose labels print larger wins; on a tie `copy` wins only with
 * `winsTie`, and a size that is not known never wins. The live page and
 * print choose by it alike.
 */
export function printsBetter(
	copy: WeighedDiagramCopy,
	kept: WeighedDiagramCopy,
	{ winsTie = false }: { winsTie?: boolean } = {},
): boolean {
	if (copy.labelsOverflow !== kept.labelsOverflow) {
		return kept.labelsOverflow;
	}
	if (copy.labelPt === null || kept.labelPt === null) {
		return false;
	}
	return winsTie ? copy.labelPt >= kept.labelPt : copy.labelPt > kept.labelPt;
}
