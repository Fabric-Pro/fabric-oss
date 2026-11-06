/**
 * A section opener of the Word writer (Fizzy #2946): print's ink card over
 * each root-level Heading 2, as a one-cell table shaded with the ink that
 * holds the "Section N" eyebrow, the heading and its subtitle in light
 * text. The heading is set in a style of its own, based on Heading 2 and
 * at its outline level, so the contents' TOC field and the navigation pane
 * find it inside the card, and the contents entry Word writes from it never
 * takes the card's light type.
 */

import {
	LineRuleType,
	Paragraph,
	ShadingType,
	Table,
	TableBorders,
	TableCell,
	TableLayoutType,
	TableRow,
	WidthType,
} from "docx";
import type { Emphasis, Heading } from "mdast";
import { appendixLabels } from "../build-cover-html";
import { flatText } from "../markdown";
import { inlineChildren } from "./inline";
import {
	OPENER_BELOW,
	OPENER_EYEBROW_AFTER,
	OPENER_EYEBROW_SIZE,
	OPENER_EYEBROW_TRACKING,
	OPENER_HEADING_AFTER,
	OPENER_MARGIN,
	OPENER_SUBTITLE_LINE,
	OPENER_SUBTITLE_SIZE,
	OPENER_SUBTITLE_WIDTH,
	SECTION_HEADING_STYLE,
	SINGLE_LINE,
} from "./styles";
import {
	type BlockContext,
	type Out,
	proseText,
	type RunStyle,
	textRun,
	type Writer,
} from "./writer";

/** An empty line one point high: the room above or under the card. */
const HAIRLINE = 20;

/**
 * The opener's eyebrow: "Section N", counted over the openers so far, or an
 * appendix's own label, which takes no number, as print's counter skips it.
 */
function eyebrowText(writer: Writer, title: string): string {
	const appendix = appendixLabels(title);
	if (appendix) {
		return appendix.opener;
	}
	writer.sectionNumber++;
	return `Section ${writer.sectionNumber}`;
}

/**
 * Lay out one section opener. `breakBefore` starts it on a new page, as
 * every print opener does except one already at the top of a page: the
 * first after the contents, or one opening a landscape page, which starts
 * a Word section of its own. The break is a hairline paragraph before the
 * card, since a table carries no page break of its own, kept with the card
 * as every line of the card is kept with the block after it.
 *
 * Print lets an opener follow a short tail of the section before on that
 * tail's page; that is a measurement of the laid-out page, which Word
 * offers no field or rule for, so every opener here starts a page.
 *
 * The subtitle is the emphasis `subtitleOf` takes, set upright and muted as
 * print sets it, and the paragraph it came from is left out of the body.
 */
export function renderSectionOpener(
	writer: Writer,
	heading: Heading,
	subtitle: Emphasis | null,
	out: Out[],
	context: BlockContext,
	breakBefore: boolean,
): void {
	const { colors, fonts } = writer;
	const title = proseText(flatText(heading)).trim();
	if (title !== "") {
		writer.contents.push(title);
	}
	const width = context.textWidth - context.indent;
	const cellContext: BlockContext = {
		...context,
		indent: 0,
		callout: false,
		textWidth: width - OPENER_MARGIN.left - OPENER_MARGIN.right,
	};
	// No font, colour or size of its own: the heading's look is its style's
	// (`SECTION_HEADING_STYLE`), so the contents entry Word writes from it is
	// set as a contents entry. Only a link names the light colour, over the
	// link style's.
	const heading2: RunStyle = {
		linkColor: colors.onInk,
		linkUnderline: colors.onInk,
	};
	const muted = colors.onInkMuted;

	const paragraphs = [
		new Paragraph({
			spacing: {
				before: 0,
				after: OPENER_EYEBROW_AFTER,
				line: SINGLE_LINE,
			},
			keepNext: true,
			keepLines: true,
			children: [
				textRun(eyebrowText(writer, title), {
					...writer.monoMedium,
					color: colors.onInkPrimary,
					size: OPENER_EYEBROW_SIZE,
					allCaps: true,
					characterSpacing: OPENER_EYEBROW_TRACKING,
				}),
			],
		}),
		new Paragraph({
			style: SECTION_HEADING_STYLE,
			...(subtitle ? { spacing: { after: OPENER_HEADING_AFTER } } : {}),
			children: inlineChildren(
				writer,
				heading.children,
				heading2,
				cellContext,
			),
		}),
		...(subtitle
			? [
					new Paragraph({
						spacing: {
							before: 0,
							after: 0,
							line: OPENER_SUBTITLE_LINE,
						},
						indent: {
							right: Math.max(
								0,
								cellContext.textWidth - OPENER_SUBTITLE_WIDTH,
							),
						},
						keepNext: true,
						keepLines: true,
						children: inlineChildren(
							writer,
							subtitle.children,
							{
								font: fonts.body,
								color: muted,
								size: OPENER_SUBTITLE_SIZE,
								linkColor: muted,
								linkUnderline: muted,
							},
							cellContext,
						),
					}),
				]
			: []),
	];

	if (breakBefore) {
		out.push({
			paragraph: {
				pageBreakBefore: true,
				keepNext: true,
				spacing: {
					before: 0,
					after: 0,
					line: HAIRLINE,
					lineRule: LineRuleType.EXACT,
				},
				children: [],
			},
		});
	}
	out.push({
		table: new Table({
			width: { size: width, type: WidthType.DXA },
			columnWidths: [width],
			layout: TableLayoutType.FIXED,
			indent:
				context.indent > 0
					? { size: context.indent, type: WidthType.DXA }
					: undefined,
			borders: TableBorders.NONE,
			margins: OPENER_MARGIN,
			rows: [
				new TableRow({
					cantSplit: true,
					children: [
						new TableCell({
							width: { size: width, type: WidthType.DXA },
							shading: {
								type: ShadingType.CLEAR,
								color: "auto",
								fill: colors.ink,
							},
							children: paragraphs,
						}),
					],
				}),
			],
		}),
	});
	// Print's room under the card, which also keeps a table after it from
	// joining it.
	out.push({
		paragraph: {
			keepNext: true,
			spacing: {
				before: 0,
				after: OPENER_BELOW,
				line: HAIRLINE,
				lineRule: LineRuleType.EXACT,
			},
			children: [],
		},
	});
}
