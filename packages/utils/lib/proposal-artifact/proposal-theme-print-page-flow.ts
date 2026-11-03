/**
 * The printed page in the print layer (`./proposal-theme-print`), and how the
 * body flows over it: the page size and margins, the `@page` blocks with the
 * running footer in their margin boxes, the room a section opener needs below
 * a short tail, the opener's and the body's text, and the tallest a figure's
 * drawing prints.
 *
 * The print layer spreads these rules into its own in the places they had
 * there, so its stylesheet does not change. The opener room's class names
 * stay in `PROPOSAL_PRINT_CLASSES` with every other print class and are
 * passed in rather than imported, because the print layer imports this
 * module.
 *
 * Pure functions and data only: client components import the print layer,
 * so this module must not pull in anything the browser bundle cannot carry.
 */

import type { PROPOSAL_PRINT_CLASSES } from "./proposal-theme-print";
import {
	atRule,
	block,
	type Declarations,
	dot,
	PROPOSAL_THEME_CLASSES,
	rule,
	type ThemeRule,
} from "./proposal-theme-rules";

/**
 * The printed page size, in one place: US Letter until the page-size
 * question in Fizzy #2946 is answered.
 */
export const PROPOSAL_PAGE_SIZE = "letter";

/** The page size of a landscape appendix page. */
export const PROPOSAL_PAGE_SIZE_LANDSCAPE =
	`${PROPOSAL_PAGE_SIZE} landscape` as const;

/**
 * The portrait page height of each size the constant above may name, so the
 * full-bleed cover follows the page size rather than restating it.
 */
export const PAGE_HEIGHTS = {
	letter: "11in",
} as const satisfies Record<typeof PROPOSAL_PAGE_SIZE, string>;

/** The portrait page width of each size, for the opener's text. */
const PAGE_WIDTHS = {
	letter: "8.5in",
} as const satisfies Record<typeof PROPOSAL_PAGE_SIZE, string>;

/** The default page's margins, the footer's margin box in the bottom one. */
const PAGE_MARGINS = {
	top: "0.85in",
	side: "0.8in",
	bottom: "0.9in",
} as const;

/**
 * The most of a portrait page a section's short tail may fill and still
 * have the next section open below it, on the same page. Measured on a
 * generated Proposal, tails that left a page almost empty filled 4% and 11%
 * of it, and the emptiest page a whole section filled was half.
 */
const SHORT_TAIL_SHARE = 0.25;

/** The space between a short tail and the opener under it. */
const OPENER_GAP = "0.3in";

/** The height of a portrait page's body, as a `calc()` term. */
const PAGE_BODY = `${PAGE_HEIGHTS[PROPOSAL_PAGE_SIZE]} - ${PAGE_MARGINS.top} - ${PAGE_MARGINS.bottom}`;

/**
 * The room block's height: the body below a short tail of the longest
 * length, less the gap above the block.
 */
const OPENER_ROOM = `calc((${PAGE_BODY}) * ${1 - SHORT_TAIL_SHARE} - ${OPENER_GAP})`;

/**
 * The room a figure keeps under its drawing for its caption and its own
 * margins: the inch the Word writer keeps under a picture
 * (`MAX_IMAGE_HEIGHT` in the Temporal package's `build-docx/styles.ts`), so
 * a drawing prints no taller in the PDF than in the Word file.
 */
const FIGURE_CAPTION_ROOM = "1in";

/**
 * The most a section opener, its gap and a figure's top margin take above a
 * figure that comes right after it, unless its text takes more lines than
 * {@link OPENER_ROOM_LINES}: measured in Chromium, an opener with a heading
 * on two lines and a subtitle on one, and the gap to the figure, are 192.5
 * CSS pixels tall, and the caption's inch leaves the half pixel spare.
 */
const FIGURE_OPENER_ROOM = "2in";

/**
 * The lines of an opener's heading and subtitle {@link FIGURE_OPENER_ROOM}
 * holds; each line past them takes its height from the figure under it.
 */
const OPENER_ROOM_LINES = { heading: 2, subtitle: 1 } as const;

/**
 * A section opener's text as the print layer sets it, which the opener's
 * rules there read: the card's side padding and the space below it, and
 * the heading and the subtitle, each with its size, line height and the
 * space below it or the width it wraps at. The heading takes the card's
 * width.
 */
export const OPENER_TEXT = {
	sidePadding: "22pt",
	below: "16pt",
	heading: { size: "21pt", lineHeight: 1.15, gap: "6pt" },
	subtitle: { size: "10.5pt", lineHeight: 1.45, maxWidth: "3.9in" },
} as const;

/** The body text's size and line height, which the print layer's root reads. */
export const BODY_TEXT = { size: "10.5pt", lineHeight: 1.6 } as const;

/**
 * What a paragraph or a list between an opener and a figure takes beyond
 * its lines, in ems of the body text, as the base theme
 * (`./proposal-theme`) spaces them for the live page and print alike: the
 * widest bottom margin either has (a steps list's 1.25em; a paragraph's and
 * any other list's 1em), the widest indent of a list's items (a step's
 * 2.4em; any other item's 1.4em), and the most a list adds per item (a
 * step's 0.85em bottom margin; any other item's 0.3em margins and its
 * paragraphs' 0.25em take less).
 */
const SHORT_BLOCK_EMS = { gap: 1.25, listIndent: 2.4, perItem: 0.85 } as const;

/**
 * The budgeted advance of one character of an opener's heading or
 * subtitle, or of the body text before a figure under it, as a fraction of
 * its size, as the figure templates budget Inter's. Measured in Chromium,
 * the heading's Poppins 700 sets 0.51 to 0.59 em a character in sentence
 * case, title case, capitals, digits and Cyrillic, and Inter 400, the
 * subtitle's and the body's, 0.48 to 0.59, so a line is estimated to hold
 * fewer characters than it does. A heading dense in m, w and dashes
 * reaches 0.64; the line or so that can take more than estimated is within
 * the caption's inch.
 */
const TEXT_EM_PER_CHARACTER = 0.62;

/**
 * The shortest a figure's drawing prints under an opener however long its
 * text: past it, an opener that tall leaves no room for a figure worth
 * reading, and the figure moves to the next page whole. A figure the
 * opener's page cannot hold at this height after the blocks before it
 * keeps a figure's own height, and moves whole too.
 */
const FIGURE_UNDER_OPENER_MIN_HEIGHT = "3in";

/** CSS pixels to the inch. */
const PX_PER_INCH = 96;

/** CSS pixels to the point. */
const PX_PER_POINT = PX_PER_INCH / 72;

/** A length in inches or points, such as `"0.8in"` or `"21pt"`, in CSS pixels. */
function lengthPx(length: string): number {
	const match = /^(\d+(?:\.\d+)?)(in|pt)$/.exec(length);
	if (!match) {
		throw new RangeError(`Not a length in inches or points: ${length}`);
	}
	return Number(match[1]) * (match[2] === "in" ? PX_PER_INCH : PX_PER_POINT);
}

/**
 * An inch length less the inch lengths after it, as the `calc()` the print
 * layer writes and in CSS pixels, so a rule and what the export measures
 * against are one number. Summed in hundredths of an inch, which every
 * length here is a whole number of, so the pixels are exact.
 */
function inchesLess(
	first: string,
	...less: readonly string[]
): { css: string; px: number } {
	const hundredths = (length: string) =>
		Math.round(Number.parseFloat(length) * 100);
	const total = less.reduce(
		(sum, length) => sum - hundredths(length),
		hundredths(first),
	);
	return {
		css: `calc(${[first, ...less].join(" - ")})`,
		px: (total * PX_PER_INCH) / 100,
	};
}

/**
 * The tallest a figure's drawing prints: the page body less the caption's
 * room, so the figure fits one page whole.
 */
const FIGURE_MAX_HEIGHT = inchesLess(
	PAGE_HEIGHTS[PROPOSAL_PAGE_SIZE],
	PAGE_MARGINS.top,
	PAGE_MARGINS.bottom,
	FIGURE_CAPTION_ROOM,
);

/** The same below a section opener, which shares the figure's page. */
const FIGURE_UNDER_OPENER_MAX_HEIGHT = inchesLess(
	PAGE_HEIGHTS[PROPOSAL_PAGE_SIZE],
	PAGE_MARGINS.top,
	PAGE_MARGINS.bottom,
	FIGURE_CAPTION_ROOM,
	FIGURE_OPENER_ROOM,
);

/**
 * The tallest a figure's drawing prints, in CSS pixels: 792 on Letter, the
 * height the Word writer shrinks a picture to as well. The export measures
 * a diagram's printed labels against it
 * (`printedNodeLabelPt` in `./diagram-label-wrap`).
 */
export const PRINT_FIGURE_MAX_HEIGHT_PX = FIGURE_MAX_HEIGHT.px;

/**
 * The most a figure's drawing is offered right after a section opener, in
 * CSS pixels: 600 on Letter, under an opener whose text takes no more than
 * {@link OPENER_ROOM_LINES}, and less under a longer one or after short
 * blocks ({@link printFigureUnderOpenerMaxHeightPx}). A drawing is shrunk to
 * it only while its labels stay at the print floor there
 * (`legibleFigureMaxHeightPx` in `./diagram-label-wrap`); otherwise it keeps
 * {@link PRINT_FIGURE_MAX_HEIGHT_PX}, the Word writer's only height.
 */
export const PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX =
	FIGURE_UNDER_OPENER_MAX_HEIGHT.px;

/**
 * The custom property a figure on an opener's page carries its drawing's
 * height limit in, which the print layer's rules read before their own.
 */
export const PRINT_FIGURE_MAX_HEIGHT_PROPERTY = "--pa-figure-max-height";

/**
 * How many lines `text` takes `width` CSS pixels wide when each character
 * is `advance` pixels: broken at spaces, a word wider than a line over as
 * many lines as it fills, and each line break (`\n`) starting a line, even
 * an empty one.
 */
function estimatedLines(text: string, width: number, advance: number): number {
	const budget = Math.max(1, Math.floor(width / advance));
	let lines = 0;
	for (const line of text.split("\n")) {
		let count = 0;
		let filled = 0;
		for (const word of line.split(/\s+/).filter(Boolean)) {
			const size = Array.from(word).length;
			if (filled > 0 && filled + 1 + size <= budget) {
				filled += 1 + size;
			} else {
				count += Math.ceil(size / budget);
				filled = size % budget || budget;
			}
		}
		lines += Math.max(1, count);
	}
	return lines;
}

/** The height of an opener's heading and subtitle lines, in CSS pixels. */
function openerTextPx(headingLines: number, subtitleLines: number): number {
	const { heading, subtitle } = OPENER_TEXT;
	return (
		headingLines * lengthPx(heading.size) * heading.lineHeight +
		(subtitleLines > 0
			? lengthPx(heading.gap) +
				subtitleLines * lengthPx(subtitle.size) * subtitle.lineHeight
			: 0)
	);
}

/**
 * A block that prints between a section opener and the figure after it,
 * as its text, each line break as `\n`: a paragraph, or a list's items.
 */
export type OpenerPageBlock =
	| { kind: "paragraph"; text: string }
	| { kind: "list"; items: readonly string[] };

/**
 * The height `before` takes between an opener and the figure after it, in
 * CSS pixels: each block's lines at the body's size, with the opener's
 * space above the first and the widest block margin above every other. The
 * last block's margin is within the figure's own, which the opener's room
 * holds.
 */
function blocksPx(before: readonly OpenerPageBlock[], column: number): number {
	const size = lengthPx(BODY_TEXT.size);
	const line = size * BODY_TEXT.lineHeight;
	const advance = TEXT_EM_PER_CHARACTER * size;
	return before.reduce((sum, block, index) => {
		const gap =
			index === 0
				? lengthPx(OPENER_TEXT.below)
				: SHORT_BLOCK_EMS.gap * size;
		const text =
			block.kind === "paragraph"
				? estimatedLines(block.text, column, advance) * line
				: block.items.reduce(
						(items, item) =>
							items +
							estimatedLines(
								item,
								column - SHORT_BLOCK_EMS.listIndent * size,
								advance,
							) *
								line +
							SHORT_BLOCK_EMS.perItem * size,
						0,
					);
		return sum + gap + text;
	}, 0);
}

/**
 * The tallest a figure's drawing prints on a section opener's page, in
 * whole CSS pixels, when only short blocks print between the opener and it:
 * the opener's heading prints `heading` and its subtitle `subtitle` (null
 * without one), each line break as `\n`, and `before` prints between them.
 * {@link PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX} less the height of every
 * line the opener's text is estimated to take past {@link OPENER_ROOM_LINES},
 * at {@link TEXT_EM_PER_CHARACTER}, and less the height of the blocks
 * before the figure. So the opener, which is kept on the figure's page, the
 * blocks, the figure and its caption fit one page. Right under the opener it
 * is never less than {@link FIGURE_UNDER_OPENER_MIN_HEIGHT}; after blocks
 * that leave less, the figure keeps {@link PRINT_FIGURE_MAX_HEIGHT_PX} and
 * moves to the next page whole. This is the height the figure is offered:
 * it keeps it only while its labels stay at the print floor there
 * (`legibleFigureMaxHeightPx`). The print page writes the height it keeps
 * on the figure when the rules below would not give it, and the export
 * measures the diagram's labels against the same number.
 */
export function printFigureUnderOpenerMaxHeightPx(
	heading: string,
	subtitle: string | null,
	before: readonly OpenerPageBlock[] = [],
): number {
	const {
		sidePadding,
		heading: headingText,
		subtitle: subtitleText,
	} = OPENER_TEXT;
	const column =
		lengthPx(PAGE_WIDTHS[PROPOSAL_PAGE_SIZE]) -
		2 * lengthPx(PAGE_MARGINS.side);
	const headingLines = estimatedLines(
		heading,
		column - 2 * lengthPx(sidePadding),
		TEXT_EM_PER_CHARACTER * lengthPx(headingText.size),
	);
	const subtitleLines =
		subtitle === null
			? 0
			: estimatedLines(
					subtitle,
					lengthPx(subtitleText.maxWidth),
					TEXT_EM_PER_CHARACTER * lengthPx(subtitleText.size),
				);
	const past =
		openerTextPx(headingLines, subtitleLines) -
		openerTextPx(OPENER_ROOM_LINES.heading, OPENER_ROOM_LINES.subtitle);
	const height = Math.floor(
		FIGURE_UNDER_OPENER_MAX_HEIGHT.px -
			Math.max(0, past) -
			blocksPx(before, column),
	);
	const floor = lengthPx(FIGURE_UNDER_OPENER_MIN_HEIGHT);
	if (before.length === 0) {
		return Math.max(floor, height);
	}
	return height >= floor ? height : FIGURE_MAX_HEIGHT.px;
}

const THEME = PROPOSAL_THEME_CLASSES;

/** The figure height limits, in the order the print layer emits them. */
export function figureHeightRules(): ThemeRule[] {
	return [
		// A figure's drawing is never taller than a page holds with its caption:
		// a taller one shrinks to that height, its width with it, so it keeps
		// its shape and stays centred, and the figure moves to a page of its own
		// whole instead of running off the foot of one. Below a section opener,
		// which is kept on the figure's page, it leaves the opener's room too.
		// The print page writes a lower limit on a figure that shares the
		// opener's page, under a long opener or after short blocks, and a
		// figure's own height on one whose labels the room there would take
		// below the floor, which both rules read first. The export writes
		// every drawing's size and viewBox on its `svg`, so it scales.
		rule(["figure > svg", `${dot(THEME.figure)} > svg`], {
			width: "auto",
			"max-height": `var(${PRINT_FIGURE_MAX_HEIGHT_PROPERTY}, ${FIGURE_MAX_HEIGHT.css})`,
		}),
		rule(
			[
				`${dot(THEME.sectionOpener)} + figure > svg`,
				`${dot(THEME.sectionOpener)} + ${dot(THEME.figure)} > svg`,
			],
			{
				"max-height": `var(${PRINT_FIGURE_MAX_HEIGHT_PROPERTY}, ${FIGURE_UNDER_OPENER_MAX_HEIGHT.css})`,
			},
		),
	];
}

/** The opener room's rules, in the order the print layer emits them. */
export function openerRoomRules(
	print: typeof PROPOSAL_PRINT_CLASSES,
): ThemeRule[] {
	return [
		// The room before an opener is as tall as the body below a short tail,
		// and pulled back up by as much, so it takes no space. Kept whole, it
		// either fits below the tail, and the opener follows on that page, or
		// moves to the next page, whose break drops the gap above it, and the
		// opener starts that page where it would without the room. Both print
		// passes lay it out alike, so the contents page still points at each
		// opener's page. A room that could split would let any opener start
		// mid-page.
		rule(dot(print.openerRoom), {
			"--pa-opener-room": OPENER_ROOM,
			height: "var(--pa-opener-room)",
			margin: `${OPENER_GAP} 0 calc(-1 * var(--pa-opener-room))`,
			"break-inside": "avoid",
		}),
		rule(`${dot(print.openerRoom)} + ${dot(THEME.sectionOpener)}`, {
			"break-before": "auto",
		}),
		// After a landscape page the change of page is the break, and Chromium
		// keeps the margin after a forced break, which would push the opener
		// down its page.
		rule(`${dot(print.landscape)} + ${dot(print.openerRoom)}`, {
			"margin-top": "0",
		}),
	];
}

/** Every margin box a page can have. */
const MARGIN_BOXES = [
	"top-left-corner",
	"top-left",
	"top-center",
	"top-right",
	"top-right-corner",
	"bottom-left-corner",
	"bottom-left",
	"bottom-center",
	"bottom-right",
	"bottom-right-corner",
	"left-top",
	"left-middle",
	"left-bottom",
	"right-top",
	"right-middle",
	"right-bottom",
] as const;

/** Longest running footer, in characters, before it is cut. */
const RUNNING_TEXT_LIMIT = 200;

/**
 * `text` as a double-quoted CSS string a document title cannot break out of.
 * Control characters and line breaks become spaces, whitespace collapses,
 * and the text is cut to {@link RUNNING_TEXT_LIMIT} characters. Backslash
 * and quote are escaped, and `<` and `>` become hex escapes so the
 * stylesheet can sit inside a `<style>` element without `</style>` closing
 * it.
 */
function cssString(text: string): string {
	const flat = text
		// Direction overrides and invisible breaks go; the joiners some scripts
		// and emoji need (U+200C, U+200D) stay.
		.replace(
			/[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g,
			"",
		)
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(flat);
	const capped =
		characters.length > RUNNING_TEXT_LIMIT
			? `${characters
					.slice(0, RUNNING_TEXT_LIMIT - 1)
					.join("")
					.trimEnd()}…`
			: flat;
	const escaped = capped.replace(/[\\"<>]/g, (character) => {
		switch (character) {
			case "\\":
				return "\\\\";
			case '"':
				return '\\"';
			case "<":
				return "\\3c ";
			default:
				return "\\3e ";
		}
	});
	return `"${escaped}"`;
}

/** A margin box's `content`: the text as a string, or nothing at all. */
function runningContent(text: string): string {
	const value = cssString(text);
	return value === '""' ? "none" : value;
}

function pageRule(
	name: string | null,
	declarations: Declarations,
	boxes: Readonly<Record<string, Declarations>>,
): string {
	const own = Object.entries(declarations).map(
		([property, value]) => `\t${property}: ${value};`,
	);
	const nested = Object.entries(boxes).map(([box, boxDeclarations]) =>
		block([`@${box}`], boxDeclarations, "\t"),
	);
	return atRule(
		name ? `@page ${name}` : "@page",
		[...own, ...nested].join("\n"),
	);
}

/**
 * The `@page` blocks, in the order the print layer emits them: the default
 * page with the running footer, plain text escaped here, and the page counter
 * in its bottom margin boxes, set as `furniture` says; the cover and the
 * first page bare; and the landscape page.
 */
export function pageRules(
	runningFooter: string,
	furniture: Declarations,
): string[] {
	const bottom: Declarations = {
		...furniture,
		"vertical-align": "top",
		"padding-top": "0.24in",
	};
	const blank = Object.fromEntries(
		MARGIN_BOXES.map((box) => [box, { content: "none" }]),
	);

	return [
		// The cover counts as page 1, so the first body page reads "Page 2".
		// A footer only: the opener names each section at the top of its page.
		pageRule(
			null,
			{
				size: PROPOSAL_PAGE_SIZE,
				margin: `${PAGE_MARGINS.top} ${PAGE_MARGINS.side} ${PAGE_MARGINS.bottom}`,
			},
			{
				"bottom-left": {
					...bottom,
					content: runningContent(runningFooter),
				},
				"bottom-right": {
					...bottom,
					content: '"Page " counter(page) " of " counter(pages)',
					"text-align": "right",
					"white-space": "nowrap",
				},
			},
		),
		pageRule("cover", { margin: "0" }, blank),
		// The cover is always the first page. Chromium 143 lays it out on the
		// cover page's geometry but paints page 1 with the default page's
		// margins and furniture unless the first page carries them itself.
		pageRule(":first", { margin: "0" }, blank),
		pageRule("landscape", { size: PROPOSAL_PAGE_SIZE_LANDSCAPE }, {}),
	];
}
