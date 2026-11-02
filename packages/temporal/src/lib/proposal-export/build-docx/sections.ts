/**
 * The Word file's sections (Fizzy #2946): the cover, the cover letter, the
 * contents page and the body, split at its wide tables, each with its own
 * page setup and running furniture.
 */

import {
	AlignmentType,
	BorderStyle,
	type FileChild,
	Footer,
	Header,
	HeadingLevel,
	type ISectionOptions,
	PageNumber,
	PageOrientation,
	Paragraph,
	Tab,
	Table,
	TableBorders,
	TableCell,
	TableLayoutType,
	TableOfContents,
	TableRow,
	TabStopType,
	TextRun,
	VerticalAlignTable,
	WidthType,
} from "docx";
import type { RootContent } from "mdast";
import {
	coverVersionLabel,
	isWideTable,
	writtenRows,
} from "../document-content";
import type { ExportRaster } from "../types";
import { renderBlock, renderLetter } from "./blocks";
import { fitImage, imageRun } from "./inline";
import {
	CONTENTS_HEADING_SIZE,
	COVER_EYEBROW,
	DATE_SIZE,
	EYEBROW_SIZE,
	EYEBROW_TRACKING,
	FOOTER_CONFIDENTIAL,
	FOOTER_SEPARATOR,
	FURNITURE_SIZE,
	HERO_MAX_HEIGHT,
	LABEL_TRACKING,
	LANDSCAPE_TEXT_WIDTH,
	LETTER_LOGO_MAX_HEIGHT,
	LOGO_MAX_HEIGHT,
	LOGO_MAX_WIDTH,
	ORGANIZATION_SIZE,
	PAGE,
	PAGE_MARGIN,
	PARTY_LABEL_SIZE,
	PARTY_LINE_SIZE,
	PARTY_NAME_SIZE,
	PORTRAIT_TEXT_WIDTH,
	SINGLE_LINE,
	TITLE_SIZE,
} from "./styles";
import {
	type Out,
	partyName,
	proseText,
	type RunStyle,
	runProperties,
	textRun,
	type Writer,
} from "./writer";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function pageProperties(landscape: boolean): ISectionOptions["properties"] {
	return {
		page: {
			// Portrait sizes plus the flag: docx swaps them for landscape.
			size: {
				width: PAGE.width,
				height: PAGE.height,
				orientation: landscape
					? PageOrientation.LANDSCAPE
					: PageOrientation.PORTRAIT,
			},
			margin: PAGE_MARGIN,
		},
	};
}

function furnitureStyle(writer: Writer): RunStyle {
	return {
		font: writer.fonts.body,
		color: writer.colors.muted,
		size: FURNITURE_SIZE,
		characterSpacing: 4,
	};
}

/**
 * The running header and footer of every page after the cover, built fresh
 * for each section so each gets parts of its own, with the footer's page
 * count on a right tab at that section's column edge. Page numbers run on
 * from the cover, which counts as page 1, as on the print page.
 */
function furniture(
	writer: Writer,
	textWidth: number,
): Pick<ISectionOptions, "headers" | "footers"> {
	const { input } = writer;
	const style = furnitureStyle(writer);
	const footerText = [
		partyName(input.tokens.proposer.name.value),
		partyName(writer.title),
		partyName(input.dateLabel),
		FOOTER_CONFIDENTIAL,
	]
		.filter((part): part is string => part !== null)
		.map((part) => proseText(part))
		.join(FOOTER_SEPARATOR);
	return {
		headers: {
			default: new Header({
				children: [
					new Paragraph({
						spacing: { before: 0, after: 0, line: SINGLE_LINE },
						children: [textRun(proseText(writer.title), style)],
					}),
				],
			}),
		},
		footers: {
			default: new Footer({
				children: [
					new Paragraph({
						spacing: { before: 0, after: 0, line: SINGLE_LINE },
						tabStops: [
							{ type: TabStopType.RIGHT, position: textWidth },
						],
						children: [
							textRun(footerText, style),
							new TextRun({
								...runProperties(style),
								children: [
									new Tab(),
									"Page ",
									PageNumber.CURRENT,
									" of ",
									PageNumber.TOTAL_PAGES,
								],
							}),
						],
					}),
				],
			}),
		},
	};
}

/** Paragraphs and tables from what a block walk emitted. */
function fileChildren(out: readonly Out[]): FileChild[] {
	return out.map((entry) =>
		"table" in entry ? entry.table : new Paragraph(entry.paragraph),
	);
}

/**
 * The body, split into sections at its wide tables: each run of root blocks
 * keeps portrait, a root table wider than six columns starts a landscape
 * section (a following wide table shares it), and the next block returns to
 * portrait. A section heading right before such a table goes onto its
 * landscape page with it, so it is not left alone at the foot of the page
 * before. A wide table nested in a list or quote stays where it is. The
 * cover letter has a section of its own, so the body leaves it out.
 */
export function bodySections(writer: Writer): ISectionOptions[] {
	const groups: { landscape: boolean; children: FileChild[] }[] = [];
	const children = writer.input.prepared.root.children;
	const letter = new Set<RootContent>(
		writer.letter ? [writer.letter.heading, ...writer.letter.nodes] : [],
	);
	// A wide table that writes no rows takes no landscape page, nor its
	// heading with it.
	const isWide = (node: RootContent | undefined) =>
		node?.type === "table" &&
		isWideTable(node) &&
		writtenRows(node).length > 0;
	for (const [index, node] of children.entries()) {
		if (letter.has(node)) {
			continue;
		}
		const landscape =
			isWide(node) ||
			(node.type === "heading" &&
				node.depth === 2 &&
				isWide(children[index + 1]));
		const out: Out[] = [];
		renderBlock(writer, node, out, {
			textWidth: landscape ? LANDSCAPE_TEXT_WIDTH : PORTRAIT_TEXT_WIDTH,
			indent: 0,
			callout: false,
			listDepth: 0,
		});
		if (out.length === 0) {
			continue;
		}
		let group = groups.at(-1);
		if (!group || group.landscape !== landscape) {
			group = { landscape, children: [] };
			groups.push(group);
		}
		group.children.push(...fileChildren(out));
	}
	if (groups.length === 0) {
		groups.push({ landscape: false, children: [new Paragraph({})] });
	}
	return groups.map((group) => ({
		properties: pageProperties(group.landscape),
		...furniture(
			writer,
			group.landscape ? LANDSCAPE_TEXT_WIDTH : PORTRAIT_TEXT_WIDTH,
		),
		children: group.children,
	}));
}

/**
 * The contents page: a heading (not a Heading 2, so it never lists itself)
 * and a TOC field over the Heading 2 sections with links. Until Word
 * updates the field, its cached result lists the sections without page
 * numbers or links, which is what readers that never update fields show.
 * The cache carries no links on purpose: docx numbers every `Bookmark` it
 * writes 1, and duplicate bookmark ids are invalid, so the links and the
 * `_Toc` bookmarks they need are left for Word's own update to add.
 */
export function contentsSection(writer: Writer): ISectionOptions {
	return {
		properties: pageProperties(false),
		...furniture(writer, PORTRAIT_TEXT_WIDTH),
		children: [
			new Paragraph({
				spacing: { before: 0, after: 360, line: 264 },
				keepNext: true,
				children: [
					textRun("Contents", {
						font: writer.fonts.display,
						color: writer.colors.ink,
						size: CONTENTS_HEADING_SIZE,
						bold: true,
					}),
				],
			}),
			new TableOfContents("Contents", {
				hyperlink: true,
				headingStyleRange: "2-2",
				hideTabAndPageNumbersInWebView: true,
				cachedEntries: writer.contents.map((title) => ({
					title,
					level: 2,
				})),
			}),
		],
	};
}

/** A cover image paragraph, or null when there is no raster. */
function coverImage(
	writer: Writer,
	raster: ExportRaster | null,
	maxWidth: number,
	maxHeight: number,
	alignment: (typeof AlignmentType)[keyof typeof AlignmentType],
	description: string,
	before = 0,
): Paragraph | null {
	if (!raster) {
		return null;
	}
	const image = imageRun(
		writer,
		raster,
		fitImage(raster, raster.width, maxWidth, maxHeight),
		description,
	);
	return image
		? new Paragraph({
				alignment,
				spacing: { before, after: 0, line: SINGLE_LINE },
				children: [image],
			})
		: null;
}

/**
 * The cover: no running header or footer. Both logos on a row over a
 * primary rule (the proposer's at the left edge, the recipient's at the
 * right, a row with neither left out), the hero, then the eyebrow, the
 * title, the parties that are known and the date. The DOCX cover is set on
 * the paper rather than print's full-bleed ink: Word cannot bleed a fill to
 * the page edge for one section, and a page-sized shaded box is awkward to
 * edit and heavy on an office printer.
 *
 * A cover fence in the preamble sets what print's cover takes from it: the
 * eyebrow in place of "Proposal", a line about the client under the logos
 * at the right, the party lines in place of the names (the first line in
 * the name's style, the others under it), and the version beside the date.
 * Without a fence the cover is as it was.
 */
export function coverSection(writer: Writer): ISectionOptions {
	const { input, colors, fonts } = writer;
	const { tokens } = input;
	const proposerName = partyName(tokens.proposer.name.value);
	const recipientName = partyName(tokens.recipient.name.value);
	const details = writer.coverFence?.details ?? null;
	const children: FileChild[] = [];

	const proposerLogo = coverImage(
		writer,
		tokens.proposer.logo.value,
		LOGO_MAX_WIDTH,
		LOGO_MAX_HEIGHT,
		AlignmentType.LEFT,
		proposerName ? `${proposerName} logo` : "Logo",
	);
	const recipientLogo = coverImage(
		writer,
		tokens.recipient.logo.value,
		LOGO_MAX_WIDTH,
		LOGO_MAX_HEIGHT,
		AlignmentType.RIGHT,
		recipientName ? `${recipientName} logo` : "Logo",
	);
	if (proposerLogo || recipientLogo) {
		const half = PORTRAIT_TEXT_WIDTH / 2;
		const logoCell = (paragraph: Paragraph | null) =>
			new TableCell({
				width: { size: half, type: WidthType.DXA },
				verticalAlign: VerticalAlignTable.CENTER,
				margins: { top: 0, bottom: 280, left: 0, right: 0 },
				children: [
					paragraph ?? new Paragraph({ spacing: { after: 0 } }),
				],
			});
		children.push(
			new Table({
				width: { size: PORTRAIT_TEXT_WIDTH, type: WidthType.DXA },
				columnWidths: [half, half],
				layout: TableLayoutType.FIXED,
				borders: {
					...TableBorders.NONE,
					bottom: {
						style: BorderStyle.SINGLE,
						size: 48,
						color: colors.primary,
					},
				},
				rows: [
					new TableRow({
						children: [
							logoCell(proposerLogo),
							logoCell(recipientLogo),
						],
					}),
				],
			}),
		);
	}

	const organization = details?.organization
		? partyName(proseText(details.organization))
		: null;
	if (organization) {
		children.push(
			new Paragraph({
				alignment: AlignmentType.RIGHT,
				spacing: { before: 80, after: 0, line: SINGLE_LINE },
				children: [
					textRun(organization, {
						font: fonts.mono,
						color: colors.muted,
						size: ORGANIZATION_SIZE,
						allCaps: true,
						characterSpacing: LABEL_TRACKING,
					}),
				],
			}),
		);
	}

	const hero = coverImage(
		writer,
		tokens.proposer.hero.value,
		PORTRAIT_TEXT_WIDTH,
		HERO_MAX_HEIGHT,
		AlignmentType.CENTER,
		"Cover image",
		proposerLogo || recipientLogo ? 480 : 0,
	);
	if (hero) {
		children.push(hero);
	}

	const label = (text: string, before: number) =>
		new Paragraph({
			spacing: { before, after: 60, line: SINGLE_LINE },
			keepNext: true,
			children: [
				textRun(text, {
					...writer.monoMedium,
					color: colors.muted,
					size: PARTY_LABEL_SIZE,
					allCaps: true,
					characterSpacing: LABEL_TRACKING,
				}),
			],
		});
	const name = (text: string) =>
		new Paragraph({
			spacing: { before: 0, after: 0, line: SINGLE_LINE },
			children: [
				textRun(proseText(text), {
					font: fonts.body,
					color: colors.ink,
					size: PARTY_NAME_SIZE,
					bold: true,
				}),
			],
		});

	children.push(
		new Paragraph({
			// The title block sits a third of the way down an empty cover, and
			// closer under a hero.
			spacing: {
				before: hero ? 600 : 2880,
				after: 160,
				line: SINGLE_LINE,
			},
			keepNext: true,
			children: [
				textRun(proseText(details?.eyebrow ?? COVER_EYEBROW), {
					...writer.monoMedium,
					color: colors.muted,
					size: EYEBROW_SIZE,
					allCaps: true,
					characterSpacing: EYEBROW_TRACKING,
				}),
			],
		}),
		new Paragraph({
			heading: HeadingLevel.TITLE,
			children: [
				textRun(proseText(writer.title), {
					font: fonts.display,
					color: colors.ink,
					size: TITLE_SIZE,
					bold: true,
				}),
			],
		}),
	);
	const line = (text: string) =>
		new Paragraph({
			spacing: { before: 0, after: 0, line: SINGLE_LINE },
			children: [
				textRun(proseText(text), {
					font: fonts.body,
					color: colors.muted,
					size: PARTY_LINE_SIZE,
				}),
			],
		});
	// The fence's lines for a party, else the name the tokens hold.
	const party = (
		heading: string,
		lines: readonly string[] | undefined,
		fallback: string | null,
	) => {
		const [first, ...rest] =
			lines !== undefined && lines.length > 0
				? lines
				: fallback === null
					? []
					: [fallback];
		if (first !== undefined) {
			children.push(label(heading, 240), name(first), ...rest.map(line));
		}
	};
	party("Prepared for", details?.forLines, recipientName);
	party("Prepared by", details?.byLines, proposerName);
	const date = [
		partyName(input.dateLabel),
		details?.version ? coverVersionLabel(details.version) : null,
	]
		.filter((part): part is string => part !== null)
		.join(FOOTER_SEPARATOR);
	if (date) {
		children.push(
			new Paragraph({
				spacing: { before: 480, after: 0, line: SINGLE_LINE },
				children: [
					textRun(proseText(date), {
						font: fonts.body,
						color: colors.muted,
						size: DATE_SIZE,
					}),
				],
			}),
		);
	}

	return { properties: pageProperties(false), children };
}

/**
 * The cover letter, after the cover and before the contents, or null
 * without one: the proposer's logo at the left with the letter's heading at
 * the right edge, then the letter. The heading is a plain paragraph, set
 * as a label, never a Heading 2 and with no outline level, so the contents'
 * TOC field never lists it. The running header and footer print on it as on
 * every page after the cover.
 */
export function letterSection(writer: Writer): ISectionOptions | null {
	const { letter } = writer;
	if (!letter) {
		return null;
	}
	const { colors } = writer;
	const raster = writer.input.tokens.proposer.logo.value;
	const proposerName = partyName(writer.input.tokens.proposer.name.value);
	const logo = raster
		? imageRun(
				writer,
				raster,
				fitImage(
					raster,
					raster.width,
					LOGO_MAX_WIDTH,
					LETTER_LOGO_MAX_HEIGHT,
				),
				proposerName ? `${proposerName} logo` : "Logo",
			)
		: null;
	const head = new Paragraph({
		spacing: { before: 0, after: 480, line: SINGLE_LINE },
		tabStops: [{ type: TabStopType.RIGHT, position: PORTRAIT_TEXT_WIDTH }],
		children: [
			...(logo ? [logo] : []),
			new TextRun({ children: [new Tab()] }),
			textRun(proseText(letter.label), {
				...writer.monoMedium,
				color: colors.muted,
				size: EYEBROW_SIZE,
				allCaps: true,
				characterSpacing: LABEL_TRACKING,
			}),
		],
	});
	const out: Out[] = [];
	renderLetter(writer, letter.nodes, out, {
		textWidth: PORTRAIT_TEXT_WIDTH,
		indent: 0,
		callout: false,
		listDepth: 0,
	});
	return {
		properties: pageProperties(false),
		...furniture(writer, PORTRAIT_TEXT_WIDTH),
		children: [head, ...fileChildren(out)],
	};
}
