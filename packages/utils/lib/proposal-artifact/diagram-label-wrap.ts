/**
 * A flowchart's long node labels broken into lines, and a sideways
 * flowchart turned top-down (Fizzy #2946), so its labels stay legible when
 * the diagram is shrunk to a column. The live page and the Proposal export
 * (`render-diagrams.ts` in the Temporal package) both draw with it, with the
 * same canvas margin, the same always-broken label length and the same
 * print floor, so a fence is laid out alike on the page and in the PDF.
 * Pure string work, browser-safe.
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

import { PROPOSAL_PAGE_SIZE } from "./proposal-theme";

/**
 * Portrait page sizes in twips (twentieths of a point), one per size the
 * page-size constant may name. These, the margins, the caption room and the
 * pixel ratio below restate the Word writer's page geometry
 * (`build-docx/styles.ts` in the Temporal package, which this browser-safe
 * module cannot import), the page the export prints on; keep them equal, as
 * the export's parity test checks.
 */
const PAGE_SIZE_TWIPS = {
	letter: { width: 12240, height: 15840 },
} as const satisfies Record<
	typeof PROPOSAL_PAGE_SIZE,
	{ width: number; height: number }
>;

/** The print page's margins, in twips: 0.85in top, 0.8in sides, 0.9in bottom. */
const PAGE_MARGIN_TWIPS = { top: 1224, side: 1152, bottom: 1296 } as const;

/** The room the Word writer keeps under a picture for its caption: 1in. */
const CAPTION_ROOM_TWIPS = 1440;

/** Twips per CSS pixel: 1440 per inch over 96 pixels per inch. */
const TWIPS_PER_PIXEL = 15;

/**
 * The print column in CSS pixels: the portrait page less its side margins,
 * the width the print layer's `max-width: 100%` shrinks a diagram to.
 */
export const PRINT_COLUMN_PX =
	(PAGE_SIZE_TWIPS[PROPOSAL_PAGE_SIZE].width -
		PAGE_MARGIN_TWIPS.side -
		PAGE_MARGIN_TWIPS.side) /
	TWIPS_PER_PIXEL;

/**
 * The tallest a printed figure may be, in CSS pixels: the portrait page's
 * text height less the room for its caption, the height the Word writer
 * shrinks a taller picture to (`MAX_IMAGE_HEIGHT`). The PDF's text area is
 * that inch taller and shrinks no figure, but a figure taller than it does
 * not fit a page, so this is the height both outputs keep to.
 */
export const PRINT_FIGURE_MAX_HEIGHT_PX =
	(PAGE_SIZE_TWIPS[PROPOSAL_PAGE_SIZE].height -
		PAGE_MARGIN_TWIPS.top -
		PAGE_MARGIN_TWIPS.bottom -
		CAPTION_ROOM_TWIPS) /
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
 * A drawn diagram's node labels as printed, in points, from its size in CSS
 * pixels: shrunk to the print column when it is wider, and to the tallest a
 * printed figure may be when it is taller, whichever shrinks it more.
 */
export function printedNodeLabelPt(size: {
	width: number;
	height: number;
}): number {
	return (
		NODE_LABEL_PX *
		Math.min(
			1,
			PRINT_COLUMN_PX / size.width,
			PRINT_FIGURE_MAX_HEIGHT_PX / size.height,
		) *
		PT_PER_PX
	);
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
 * The shortest node label always broken into lines before a flowchart is
 * drawn, in characters, on the live page and in print alike.
 * beautiful-mermaid sizes a node from an estimate of its text's width plus
 * 20 px of padding a side, and for Inter at its 13 px labels the estimate
 * runs about 8% short. Once a line's estimate passes about 500 px (some 65
 * to 85 characters of prose), that shortfall is more than the box's 40 px
 * of padding, and the text spills out of its box. Breaking from 60
 * characters keeps a margin: such a label is broken into lines of at most
 * 30 characters, each well inside its box. That padding is the engine's
 * own, inside every box; {@link DIAGRAM_CANVAS_PADDING_PX} is the margin
 * around the whole drawing and does not change it. In print, and on a page
 * that prints, the copy as written is kept instead when its labels print
 * larger: broken labels make a diagram taller, and a tall one is shrunk to
 * the height a figure may be.
 */
export const ALWAYS_WRAPPED_LABEL_CHARS = 60;

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

/** `text` greedily wrapped at spaces; a word longer than a line stays whole. */
function wrapAtWords(text: string): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (
			line &&
			Array.from(`${line} ${word}`).length > WRAPPED_LABEL_LINE_CHARS
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
 * A long single-line label's text broken into lines with `<br/>`, or null
 * to leave it as written: the title before a spaced dash (the dash kept at
 * its end), the sentence, and a trailing parenthesis each start a line of
 * their own, and each wraps at words. Every word stays, in order; only
 * spacing changes. A label shorter than `minChars` stays as written.
 */
function wrapLabelText(text: string, minChars: number): string | null {
	const collapsed = text.replace(/\s+/g, " ").trim();
	const length = Array.from(collapsed).length;
	if (
		UNWRAPPABLE_LABEL.test(collapsed) ||
		length <= WRAPPED_LABEL_LINE_CHARS ||
		length < minChars
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

/** One trimmed flowchart line with its long node labels broken, or as is. */
function wrapLineLabels(line: string, minChars: number): string {
	const spans = nodeLabelSpans(line);
	let rewritten = line;
	for (const span of [...spans].reverse()) {
		const label = line.slice(span.start, span.end);
		const quoted =
			label.length >= 2 && label.startsWith('"') && label.endsWith('"');
		const wrapped = wrapLabelText(
			quoted ? label.slice(1, -1) : label,
			minChars,
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
	 * Break only labels at least this many characters long; without it,
	 * every label longer than one wrapped line is broken.
	 */
	minChars?: number;
}

/**
 * A flowchart's copy with its long single-line node labels broken into
 * lines, or null when it is not a flowchart or no label changed. The lines
 * before the header, the header itself, `%%` lines and the lines the engine
 * reads as anything but edges (`classDef`, `class`, `style`, `subgraph` and
 * the like) stay as written.
 */
export function wrapFlowchartNodeLabels(
	source: string,
	{ minChars = 0 }: WrapFlowchartNodeLabelsOptions = {},
): string | null {
	const lines = source.split("\n");
	const headerIndex = headerIndexOf(lines);
	if (!FLOWCHART_HEADER.test(lines[headerIndex] ?? "")) {
		return null;
	}
	let changed = false;
	const rewritten = lines.map((line, index) => {
		const trimmed = line.trim();
		if (
			index <= headerIndex ||
			trimmed.length === 0 ||
			trimmed.startsWith("%%") ||
			NON_EDGE_LINES.some((pattern) => pattern.test(trimmed))
		) {
			return line;
		}
		const wrapped = wrapLineLabels(trimmed, minChars);
		if (wrapped === trimmed) {
			return line;
		}
		changed = true;
		return `${line.slice(0, line.length - line.trimStart().length)}${wrapped}`;
	});
	return changed ? rewritten.join("\n") : null;
}
