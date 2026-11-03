/**
 * What every figure template shares: the palette and options it takes, the
 * text budget and word wrapping, escaped `<text>` elements, the light panel
 * heading, and the root `<svg>` with its title and description.
 *
 * Pure functions and data only: client components import this module.
 */

import { escapeXmlText } from "../../glossy/visual-templates";
import { cleanDiagramCaption } from "../diagram-caption";
import type { FigureKind } from "./parse";

/**
 * The colours a template paints with, each a `#rgb`/`#rrggbb` value the
 * caller resolves from the theme (the visual roles of `theme-tokens.ts`).
 * Light panels and dark cards are these colours at a reduced opacity.
 */
export interface FigurePalette {
	/** Text, number squares, the dark columns. */
	ink: string;
	/** Text on an ink fill. */
	onInk: string;
	/** Highlights, the loop, team connectors, bars within a threshold. */
	primary: string;
	/** Small mono labels that read as text on the paper: a bar threshold. */
	label: string;
	/** Text on a primary fill. */
	onPrimary: string;
	/** A highlighted box's fill. */
	tint: string;
	/** Box outlines. */
	border: string;
	/** A box's fill: the paper. */
	surface: string;
	/** Secondary text and plain connectors. */
	muted: string;
}

export interface FigureOptions {
	/** The figure's caption: its accessible title. */
	caption?: string | null;
	/**
	 * Prefix of every id the figure defines, so two figures on one page do
	 * not share markers. A letter, then letters, digits, `_` or `-`.
	 */
	idPrefix?: string;
}

/** The print column's width, in CSS pixels. */
export const FIGURE_WIDTH = 662;

/** Every text a template sets, in CSS pixels: none is smaller. */
export const FONT_SIZE = 12;
export const LINE_HEIGHT = 16;
/** Budgeted glyph advance as a fraction of the font size. */
export const INTER_EM = 0.62;
export const MONO_EM = 0.66;
export const MONO_TRACKING = 0.6;
/** The budgeted width of one Inter character, in px. */
export const INTER_ADVANCE = FONT_SIZE * INTER_EM;
/** The budgeted width of one mono character with its tracking, in px. */
const MONO_ADVANCE = FONT_SIZE * MONO_EM + MONO_TRACKING;
/** Input lines wrap to at most this many drawn lines each. */
const MAX_WRAPPED_LINES = 3;
const ELLIPSIS = "…";
const INTER_STACK = "Inter, system-ui, sans-serif";
const MONO_STACK = "'JetBrains Mono', ui-monospace, monospace";
const DEFAULT_ID_PREFIX = "figure";
const ID_PREFIX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const KIND_TITLES: Readonly<Record<FigureKind, string>> = {
	process: "Process",
	timeline: "Timeline",
	layers: "Architecture layers",
	team: "Team",
	bars: "Bar chart",
	gantt: "Gantt chart",
};

/** A coordinate with at most one decimal, so output is short and stable. */
export function num(value: number): string {
	return String(Math.round(value * 10) / 10);
}

/** A box's outline: the SVG default stroke width, which no box overrides. */
const OUTLINE_WIDTH = 1;

/**
 * The `x`, `y`, `width` and `height` of an outlined box that fills the area
 * from (`x`, `y`), outline included. A stroke is centred on the rect's edge
 * and the root clips at its viewBox, so a box drawn to the figure's edge
 * would lose half its border there: the rect is inset by half the
 * outline. Its edges are rounded rather than its size, so the outline ends
 * at the area's edge and never past it.
 */
export function outlinedBox(
	x: number,
	y: number,
	width: number,
	height: number,
): string {
	const inset = OUTLINE_WIDTH / 2;
	const round = (value: number) => Math.round(value * 10) / 10;
	const left = round(x + inset);
	const top = round(y + inset);
	const right = round(x + width - inset);
	const bottom = round(y + height - inset);
	return `x="${num(left)}" y="${num(top)}" width="${num(right - left)}" height="${num(bottom - top)}"`;
}

/** The roles a palette must carry; anything else on the object is ignored. */
export const FIGURE_PALETTE_ROLES = [
	"ink",
	"onInk",
	"primary",
	"label",
	"onPrimary",
	"tint",
	"border",
	"surface",
	"muted",
] as const satisfies ReadonlyArray<keyof FigurePalette>;

/**
 * The palette's roles, each checked to be a hex colour so nothing else can
 * reach an attribute. Extra properties (a whole theme paint spread in) are
 * left out, not refused.
 */
export function checkedPalette(palette: FigurePalette): FigurePalette {
	const checked = {} as FigurePalette;
	for (const role of FIGURE_PALETTE_ROLES) {
		const value: unknown = palette[role];
		if (typeof value !== "string" || !COLOR.test(value)) {
			throw new TypeError(`Figure palette: ${role} is not a hex colour`);
		}
		checked[role] = value;
	}
	return checked;
}

export function checkedIdPrefix(options: FigureOptions): string {
	const prefix = options.idPrefix ?? DEFAULT_ID_PREFIX;
	if (!ID_PREFIX.test(prefix)) {
		throw new TypeError("Figure idPrefix: invalid id");
	}
	return prefix;
}

/** The budgeted width of mono `text`, in px. */
export function monoWidth(text: string): number {
	return Array.from(text).length * MONO_ADVANCE;
}

/** The x a middle-anchored text of `width` sits at, kept within [lo, hi]. */
export function centredWithin(
	x: number,
	width: number,
	lo: number,
	hi: number,
): number {
	return Math.min(Math.max(x, lo + width / 2), hi - width / 2);
}

/** How many characters fit `width` at the budgeted advance. */
export function charBudget(width: number, em: number, tracking = 0): number {
	return Math.max(1, Math.floor(width / (FONT_SIZE * em + tracking)));
}

/** Characters, counted as code points so a surrogate pair is one. */
function charCount(text: string): number {
	return Array.from(text).length;
}

/** A line's words as drawn: joined by one space. */
function lineLength(words: readonly string[]): number {
	return words.reduce(
		(sum, word, index) => sum + charCount(word) + (index > 0 ? 1 : 0),
		0,
	);
}

/** A word wider than a whole line, cut at its end to the line with an ellipsis. */
function cutWord(word: string, budget: number): string {
	return `${Array.from(word)
		.slice(0, Math.max(0, budget - 1))
		.join("")}${ELLIPSIS}`;
}

/**
 * An input line's words in drawn lines of at most `budget` characters,
 * broken only at spaces. A word wider than a whole line is cut at its end
 * (`cutWord`) and ends the text: what followed it would read as a fragment
 * after the ellipsis.
 */
function wordLines(
	text: string,
	budget: number,
): { lines: string[][]; cut: boolean } {
	const lines: string[][] = [];
	let line: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const size = charCount(word);
		if (line.length > 0 && lineLength(line) + 1 + size > budget) {
			lines.push(line);
			line = [];
		}
		if (size > budget) {
			lines.push([cutWord(word, budget)]);
			return { lines, cut: true };
		}
		line.push(word);
	}
	if (line.length > 0) {
		lines.push(line);
	}
	return { lines, cut: false };
}

/**
 * One input line as drawn lines of at most `budget` characters: as it is
 * when it fits, otherwise wrapped at spaces, at most `maxLines`, so a line
 * never ends inside a word. Text past the last line is cut after the last
 * whole word that leaves room for an ellipsis; when one word fills the last
 * line, the ellipsis moves up to the line before it.
 *
 * A word is cut inside only when it is wider than a whole line (or, with
 * the ellipsis, than the only line allowed): at its end, with an ellipsis,
 * rather than set smaller, so all of a figure's text keeps the 12 px print
 * floor, and the whole label stays in the figure's description.
 */
export function wrapLine(
	text: string,
	budget: number,
	maxLines = MAX_WRAPPED_LINES,
): string[] {
	if (charCount(text) <= budget) {
		return [text];
	}
	const { lines } = wordLines(text, budget);
	if (lines.length <= maxLines) {
		return lines.map((words) => words.join(" "));
	}
	const kept = lines.slice(0, maxLines);
	for (;;) {
		const last = kept[kept.length - 1];
		while (last.length > 1 && lineLength(last) + 1 > budget) {
			last.pop();
		}
		if (lineLength(last) + 1 <= budget) {
			last[last.length - 1] += ELLIPSIS;
			break;
		}
		if (kept.length === 1) {
			kept[0] = [cutWord(last[0], budget)];
			break;
		}
		kept.pop();
	}
	return kept.map((words) => words.join(" "));
}

/**
 * One input line wrapped at spaces and kept whole, in as many lines as it
 * takes: null when a word is wider than a whole line, as it could only be
 * drawn cut.
 */
export function wrapWords(text: string, budget: number): string[] | null {
	if (charCount(text) <= budget) {
		return [text];
	}
	const { lines, cut } = wordLines(text, budget);
	return cut ? null : lines.map((words) => words.join(" "));
}

interface TextStyle {
	className: string;
	mono?: boolean;
	weight: number;
	fill: string;
	fillOpacity?: number;
	anchor?: "middle" | "end";
	tracking?: number;
}

/**
 * A `<text>` whose first baseline is at `y`: one line as text, several as
 * one `<tspan>` per line, each after the first back at `x` and one line
 * lower. Every line is escaped here.
 */
export function textElement(
	lines: readonly string[],
	x: number,
	y: number,
	style: TextStyle,
): string {
	const attributes = [
		`class="${style.className}"`,
		`x="${num(x)}"`,
		`y="${num(y)}"`,
		`font-family="${style.mono ? MONO_STACK : INTER_STACK}"`,
		`font-size="${FONT_SIZE}"`,
		`font-weight="${style.weight}"`,
		`fill="${style.fill}"`,
	];
	if (style.fillOpacity !== undefined) {
		attributes.push(`fill-opacity="${style.fillOpacity}"`);
	}
	if (style.anchor) {
		attributes.push(`text-anchor="${style.anchor}"`);
	}
	if (style.tracking) {
		attributes.push(`letter-spacing="${style.tracking}"`);
	}
	const content =
		lines.length === 1
			? escapeXmlText(lines[0])
			: lines
					.map((line, index) =>
						index === 0
							? `<tspan>${escapeXmlText(line)}</tspan>`
							: `<tspan x="${num(x)}" dy="${LINE_HEIGHT}">${escapeXmlText(line)}</tspan>`,
					)
					.join("");
	return `<text ${attributes.join(" ")}>${content}</text>`;
}

/**
 * Whether a description line arrives already cut: it ends in an ellipsis
 * (`…` or `...`), as the fences of documents generated before descriptions
 * were kept whole may. A template leaves such a line out rather than draw
 * it cut; a title is drawn as written.
 */
export function arrivesCut(line: string): boolean {
	return /(?:…|\.\.\.)\s*$/.test(line);
}

/** A label's lines, each wrapped: the first is the title, the rest detail. */
export interface WrappedLabel {
	title: string[];
	detail: string[][];
	lineCount: number;
}

/**
 * A detail line wrapped whole at spaces within the usual line budget, or
 * null when it cannot be: a word wider than the line, or more lines than a
 * label takes. A detail is drawn whole or left out, never cut.
 */
function wholeDetail(line: string, budget: number): string[] | null {
	if (arrivesCut(line)) {
		return null;
	}
	const lines = wrapWords(line, budget);
	return lines !== null && lines.length <= MAX_WRAPPED_LINES ? lines : null;
}

/** The detail lines that can be drawn whole, each wrapped. */
function wholeDetails(lines: readonly string[], budget: number): string[][] {
	return lines.flatMap((line) => {
		const whole = wholeDetail(line, budget);
		return whole === null ? [] : [whole];
	});
}

/**
 * A label wrapped: the title as `wrapLine` sets it, and each detail line
 * whole or left out (see {@link wholeDetail}).
 */
export function wrapLabel(
	lines: readonly string[],
	budget: number,
): WrappedLabel {
	const [first, ...rest] = lines;
	const title = first === undefined ? [] : wrapLine(first, budget);
	const detail = wholeDetails(rest, budget);
	return {
		title,
		detail,
		lineCount: detail.reduce(
			(sum, part) => sum + part.length,
			title.length,
		),
	};
}

/**
 * A wrapped label drawn from the baseline `y`: the title in Inter 600, each
 * detail line in Inter 400. Each input line is its own `<text>`.
 */
export function labelElements(
	label: WrappedLabel,
	x: number,
	y: number,
	colors: { title: string; detail: string; detailOpacity?: number },
	anchor?: "middle",
): string[] {
	const parts: string[] = [];
	let baseline = y;
	if (label.title.length > 0) {
		parts.push(
			textElement(label.title, x, baseline, {
				className: "label",
				weight: 600,
				fill: colors.title,
				anchor,
			}),
		);
		baseline += label.title.length * LINE_HEIGHT;
	}
	for (const lines of label.detail) {
		parts.push(
			textElement(lines, x, baseline, {
				className: "detail",
				weight: 400,
				fill: colors.detail,
				fillOpacity: colors.detailOpacity,
				anchor,
			}),
		);
		baseline += lines.length * LINE_HEIGHT;
	}
	return parts;
}

/** The root element around `body`, with its title and description. */
export function svgDocument(
	height: number,
	title: string,
	desc: string,
	body: readonly string[],
	defs = "",
): string {
	const h = num(Math.ceil(height));
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIGURE_WIDTH} ${h}" width="${FIGURE_WIDTH}" height="${h}" role="img">`,
		`<title>${escapeXmlText(title)}</title>`,
		`<desc>${escapeXmlText(desc)}</desc>`,
		defs,
		...body,
		"</svg>",
	].join("");
}

export function figureTitle(options: FigureOptions, kind: FigureKind): string {
	return cleanDiagramCaption(options.caption) ?? KIND_TITLES[kind];
}

/** Label lines as one phrase for the description. */
export function spoken(lines: readonly string[]): string {
	return lines.join(", ");
}

/** The light panel: ink at this opacity over the paper. */
export const PANEL_OPACITY = 0.05;

/** A heading's first line in mono capitals, wrapped to `width`. */
export function monoHeading(line: string, width: number): string[] {
	return wrapLine(
		line.toUpperCase(),
		charBudget(width, MONO_EM, MONO_TRACKING),
	);
}

/**
 * A heading's lines: the first in mono capitals, the rest in Inter, each
 * drawn whole or left out (see {@link wholeDetail}).
 */
export function headingLines(
	lines: readonly string[],
	width: number,
): { heading: string[]; rest: string[][] } {
	const [first = "", ...rest] = lines;
	return {
		heading: monoHeading(first, width),
		rest: wholeDetails(rest, charBudget(width, INTER_EM)),
	};
}
