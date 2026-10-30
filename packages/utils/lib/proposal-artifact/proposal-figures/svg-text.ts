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
	/** Highlights, the loop, team connectors. */
	primary: string;
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

export const FONT_SIZE = 12;
export const LINE_HEIGHT = 16;
/** Budgeted glyph advance as a fraction of the font size. */
export const INTER_EM = 0.62;
export const MONO_EM = 0.66;
export const MONO_TRACKING = 0.6;
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
};

/** A coordinate with at most one decimal, so output is short and stable. */
export function num(value: number): string {
	return String(Math.round(value * 10) / 10);
}

/** The roles a palette must carry; anything else on the object is ignored. */
export const FIGURE_PALETTE_ROLES = [
	"ink",
	"onInk",
	"primary",
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

/** How many characters fit `width` at the budgeted advance. */
export function charBudget(width: number, em: number, tracking = 0): number {
	return Math.max(1, Math.floor(width / (FONT_SIZE * em + tracking)));
}

/**
 * One input line as drawn lines of at most `budget` characters: as it is
 * when it fits, otherwise wrapped at words (a word longer than a line is
 * broken), at most `maxLines`, the last cut with an ellipsis. Counts code
 * points, so a surrogate pair is never split.
 */
export function wrapLine(
	text: string,
	budget: number,
	maxLines = MAX_WRAPPED_LINES,
): string[] {
	if (Array.from(text).length <= budget) {
		return [text];
	}
	const lines: string[] = [];
	let line: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		let chars = Array.from(word);
		if (line.length > 0 && line.length + 1 + chars.length > budget) {
			lines.push(line.join(""));
			line = [];
		}
		if (line.length > 0) {
			line.push(" ");
		}
		while (chars.length > budget) {
			lines.push(chars.slice(0, budget).join(""));
			chars = chars.slice(budget);
		}
		line.push(...chars);
	}
	if (line.length > 0) {
		lines.push(line.join(""));
	}
	if (lines.length <= maxLines) {
		return lines;
	}
	const kept = lines.slice(0, maxLines);
	const last = Array.from(kept[maxLines - 1])
		.slice(0, Math.max(0, budget - 1))
		.join("")
		.trimEnd();
	kept[maxLines - 1] = `${last}${ELLIPSIS}`;
	return kept;
}

interface TextStyle {
	className: string;
	mono?: boolean;
	weight: number;
	fill: string;
	fillOpacity?: number;
	anchor?: "middle";
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

/** A label's lines, each wrapped: the first is the title, the rest detail. */
export interface WrappedLabel {
	title: string[];
	detail: string[][];
	lineCount: number;
}

export function wrapLabel(
	lines: readonly string[],
	budget: number,
): WrappedLabel {
	const [first, ...rest] = lines;
	const title = first === undefined ? [] : wrapLine(first, budget);
	const detail = rest.map((line) => wrapLine(line, budget));
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

/** A heading's lines: the first in mono capitals, the rest in Inter. */
export function headingLines(
	lines: readonly string[],
	width: number,
): { heading: string[]; rest: string[][] } {
	const [first = "", ...rest] = lines;
	return {
		heading: wrapLine(
			first.toUpperCase(),
			charBudget(width, MONO_EM, MONO_TRACKING),
		),
		rest: rest.map((line) => wrapLine(line, charBudget(width, INTER_EM))),
	};
}
