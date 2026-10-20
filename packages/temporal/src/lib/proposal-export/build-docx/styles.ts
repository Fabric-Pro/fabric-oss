/**
 * The Word file's look (Fizzy #2946): page geometry, type sizes and spacing,
 * the brand's colours and fonts as Word names them, the document styles and
 * the list numbering.
 */

import { PROPOSAL_PAGE_SIZE } from "@repo/utils/proposal-artifact/proposal-theme";
import {
	type ProposalThemePaint,
	type SourcedValue,
	safeFontFamily,
} from "@repo/utils/proposal-artifact/theme-tokens";
import {
	AlignmentType,
	BorderStyle,
	type Document,
	type IBorderOptions,
	type ILevelsOptions,
	LevelFormat,
} from "docx";
import type { List } from "mdast";
import type {
	BuildDocxInput,
	DocxColors,
	ListDefinition,
	Writer,
} from "./writer";

// ---------------------------------------------------------------------------
// Page geometry
// ---------------------------------------------------------------------------

/**
 * Portrait page sizes in twips (twentieths of a point), one per size the
 * page-size constant may name, so the DOCX follows that constant rather than
 * restating Letter. docx swaps width and height itself for a landscape
 * section, so only portrait sizes live here.
 */
const PAGE_SIZE_TWIPS = {
	letter: { width: 12240, height: 15840 },
} as const satisfies Record<
	typeof PROPOSAL_PAGE_SIZE,
	{ width: number; height: number }
>;

export const PAGE = PAGE_SIZE_TWIPS[PROPOSAL_PAGE_SIZE];

/**
 * The print page's margins (0.85in top, 0.8in sides, 0.9in bottom), with the
 * running header and footer 0.4in from the paper's edge.
 */
export const PAGE_MARGIN = {
	top: 1224,
	right: 1152,
	bottom: 1296,
	left: 1152,
	header: 576,
	footer: 576,
	gutter: 0,
} as const;

/** The text column's width, portrait and landscape. */
export const PORTRAIT_TEXT_WIDTH =
	PAGE.width - PAGE_MARGIN.left - PAGE_MARGIN.right;
export const LANDSCAPE_TEXT_WIDTH =
	PAGE.height - PAGE_MARGIN.left - PAGE_MARGIN.right;

/**
 * Tallest image on a portrait page, in twips: the text column's height less
 * room for a caption, so Word never has to crop a picture at the page foot.
 */
export const MAX_IMAGE_HEIGHT =
	PAGE.height - PAGE_MARGIN.top - PAGE_MARGIN.bottom - 1440;

/** Twips per CSS pixel: 1440 per inch over 96 pixels per inch. */
export const TWIPS_PER_PIXEL = 15;

// ---------------------------------------------------------------------------
// Typography (sizes in half-points, spacing in twips)
// ---------------------------------------------------------------------------

/** Body text, as print sets it. */
const BODY_SIZE = 21;
/** 1.4 lines: a little tighter than print's 1.55, which reads loose in Word. */
const BODY_LINE = 336;
export const BODY_AFTER = 180;
export const LIST_ITEM_AFTER = 80;
/** Single line height, for cells, captions, code and the furniture. */
export const SINGLE_LINE = 240;

/** Heading 1–6 at print's em sizes over the 10.5pt body. */
export const HEADING_SIZES = [48, 34, 26, 22, 20, 20] as const;
const HEADING_SPACING = [
	{ before: 480, after: 200 },
	{ before: 480, after: 160 },
	{ before: 320, after: 120 },
	{ before: 280, after: 100 },
	{ before: 240, after: 80 },
	{ before: 240, after: 80 },
] as const;
export const TITLE_SIZE = 68;
export const CONTENTS_HEADING_SIZE = 48;

/**
 * Code is always set in a real monospace, whatever the brand, as print does;
 * the brand's mono family is a role font for labels and header cells.
 * Consolas ships with every Word install.
 */
export const CODE_FONT = "Consolas";
export const CODE_SIZE = 17;
export const INLINE_CODE_SIZE = 18;
/** Ballot boxes for task items; Word substitutes when the body font lacks them. */
export const SYMBOL_FONT = "Segoe UI Symbol";

export const TABLE_SIZE = 19;
export const TABLE_HEADER_SIZE = 16;
export const CAPTION_SIZE = 17;
/** Running header and footer, as print's margin boxes. */
export const FURNITURE_SIZE = 15;
export const EYEBROW_SIZE = 16;
export const PARTY_LABEL_SIZE = 15;
export const PARTY_NAME_SIZE = 24;
export const DATE_SIZE = 20;
export const STAT_VALUE_SIZE = 44;
export const STAT_LABEL_SIZE = 16;

/** Letter spacing of the uppercase labels, in twentieths of a point. */
export const LABEL_TRACKING = 16;
export const EYEBROW_TRACKING = 28;

/** List geometry: each level steps in by this much, the marker hangs. */
export const LIST_STEP = 360;
export const LIST_HANGING = 300;
const BULLET_GLYPHS = ["•", "◦", "▪"] as const;
/** Word numbering supports nine levels; deeper lists stay on the last. */
export const LIST_LEVELS = 9;

/** A callout's text sits this far in from its primary left rule. */
export const CALLOUT_INDENT = 240;
export const CODE_INDENT = 160;

/** Cell padding. */
export const CELL_MARGIN = {
	top: 80,
	bottom: 80,
	left: 120,
	right: 120,
} as const;
/** The gap between two stat tiles. */
export const STAT_TILE_GAP = 216;

/** Cover logos fit a 2.75in × 0.75in box, as on the print cover. */
export const LOGO_MAX_WIDTH = 2.75 * 1440;
export const LOGO_MAX_HEIGHT = 0.75 * 1440;
export const HERO_MAX_HEIGHT = 3.25 * 1440;

/** The cover eyebrow and the one fixed line of a diagram that did not render. */
export const COVER_EYEBROW = "Proposal";
export const DIAGRAM_UNAVAILABLE =
	"This diagram is available in the online version of this document.";
export const FOOTER_SEPARATOR = " · ";
export const FOOTER_CONFIDENTIAL = "Confidential";

export const NO_BORDER: IBorderOptions = {
	style: BorderStyle.NONE,
	size: 0,
	color: "auto",
};

// ---------------------------------------------------------------------------
// Styles and numbering
// ---------------------------------------------------------------------------

function hex(color: string): string {
	return color.replace("#", "").toUpperCase();
}

/** `weight` of `color` over `base`, both `#rrggbb`, as `RRGGBB`. */
function mixHex(color: string, base: string, weight: number): string {
	const channel = (value: string, offset: number) =>
		Number.parseInt(value.slice(offset, offset + 2), 16);
	return [1, 3, 5]
		.map((offset) =>
			Math.round(
				channel(color, offset) * weight +
					channel(base, offset) * (1 - weight),
			)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")
		.toUpperCase();
}

export function docxColors(paint: ProposalThemePaint): DocxColors {
	return {
		surface: hex(paint.surface),
		ink: hex(paint.ink),
		heading: hex(paint.heading),
		primary: hex(paint.primary),
		onPrimary: hex(paint.onPrimary),
		muted: hex(paint.muted),
		border: hex(paint.border),
		tint: hex(paint.tint),
		wash: mixHex(paint.ink, paint.surface, 0.05),
	};
}

/** The family every Word ships, written for the neutral style. */
const DOCX_NEUTRAL_FONT = "Arial";

/**
 * The families the Word file names: a font the brand chose, as the paint
 * resolved it, or Arial for the neutral default and for any name the paint
 * refused.
 */
export function docxFonts(
	tokens: BuildDocxInput["tokens"],
	paint: ProposalThemePaint,
): ProposalThemePaint["fonts"] {
	const pick = (token: SourcedValue<string>, painted: string) =>
		token.source !== "DEFAULT" && safeFontFamily(token.value) === painted
			? painted
			: DOCX_NEUTRAL_FONT;
	const fonts = tokens.proposer.fonts;
	return {
		display: pick(fonts.display, paint.fonts.display),
		body: pick(fonts.body, paint.fonts.body),
		mono: pick(fonts.mono, paint.fonts.mono),
	};
}

/**
 * The document's styles. Every built-in style docx would otherwise colour
 * (the headings in Word's blue, the title, hyperlinks) is replaced whole, so
 * no default colour survives: docx spreads a style's `run` over its default
 * at the top level, and a full `run` drops the default's colour.
 */
export function documentStyles(
	writer: Writer,
): NonNullable<ConstructorParameters<typeof Document>[0]["styles"]> {
	const { colors, fonts } = writer;
	const heading = (level: number) => ({
		run: {
			font: fonts.display,
			size: HEADING_SIZES[level - 1],
			bold: true,
			color: colors.heading,
		},
		paragraph: {
			spacing: { ...HEADING_SPACING[level - 1], line: 264 },
			keepNext: true,
			keepLines: true,
			// Word's own outline levels are zero-based; the TOC field and the
			// navigation pane read them, whatever reader opens the file.
			outlineLevel: level - 1,
			// A section heading opens under a rule in the brand colour, as the
			// live page's section headings do.
			...(level === 2
				? {
						border: {
							top: {
								style: BorderStyle.SINGLE,
								size: 18,
								color: colors.primary,
								space: 10,
							},
						},
					}
				: {}),
		},
	});
	return {
		default: {
			document: {
				run: { font: fonts.body, size: BODY_SIZE, color: colors.ink },
				paragraph: { spacing: { after: BODY_AFTER, line: BODY_LINE } },
			},
			title: {
				run: {
					font: fonts.display,
					size: TITLE_SIZE,
					bold: true,
					color: colors.heading,
				},
				paragraph: {
					spacing: { before: 0, after: 360, line: 252 },
					keepNext: true,
					border: {
						bottom: {
							style: BorderStyle.SINGLE,
							size: 24,
							color: colors.primary,
							space: 14,
						},
					},
				},
			},
			heading1: heading(1),
			heading2: heading(2),
			heading3: heading(3),
			heading4: heading(4),
			heading5: heading(5),
			heading6: heading(6),
			hyperlink: {
				run: {
					color: colors.heading,
					underline: { type: "single", color: colors.primary },
				},
			},
		},
		paragraphStyles: [
			{
				// The contents entries Word writes when it updates the field.
				id: "TOC2",
				name: "toc 2",
				basedOn: "Normal",
				next: "Normal",
				run: { font: fonts.body, size: BODY_SIZE, color: colors.ink },
				paragraph: {
					spacing: { before: 60, after: 60, line: SINGLE_LINE },
				},
			},
		],
	};
}

/**
 * The levels of one list's numbering definition. Every list node gets a
 * definition of its own, so two ordered lists each restart at their own
 * `start` (docx writes that start as the instance's override) and a nested
 * list never continues a sibling's count. The level used is the list's
 * depth, which carries the indent.
 */
export function listLevels(
	writer: Writer,
	list: ListDefinition,
): ILevelsOptions[] {
	const { colors, fonts } = writer;
	return Array.from({ length: LIST_LEVELS }, (_, level) => ({
		level,
		format: list.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
		text: list.ordered
			? `%${level + 1}.`
			: BULLET_GLYPHS[level % BULLET_GLYPHS.length],
		alignment: AlignmentType.LEFT,
		start: list.start,
		style: {
			paragraph: {
				indent: {
					left: LIST_STEP * (level + 1),
					hanging: LIST_HANGING,
				},
			},
			// Print's markers: bullets in the brand colour, numbers muted.
			run: list.ordered
				? { font: fonts.body, color: colors.muted, bold: true }
				: { font: fonts.body, color: colors.primary },
		},
	}));
}

export function registerList(writer: Writer, list: List): string {
	const reference = `proposal-list-${writer.lists.length + 1}`;
	const start =
		list.ordered && typeof list.start === "number" && list.start >= 0
			? Math.floor(list.start)
			: 1;
	writer.lists.push({ reference, ordered: Boolean(list.ordered), start });
	return reference;
}
