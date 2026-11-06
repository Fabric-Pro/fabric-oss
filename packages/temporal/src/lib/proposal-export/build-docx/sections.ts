/**
 * The Word file's sections (Fizzy #2946): the cover, the cover letter, the
 * contents page and the body, split at its wide tables, each with its own
 * page setup and running furniture.
 */

import {
	AlignmentType,
	type FileChild,
	Footer,
	Header,
	HeadingLevel,
	HeightRule,
	HorizontalPositionRelativeFrom,
	ImageRun,
	type ISectionOptions,
	LineRuleType,
	PageNumber,
	PageOrientation,
	Paragraph,
	RelativeVerticalPosition,
	ShadingType,
	Tab,
	Table,
	TableAnchorType,
	TableBorders,
	TableCell,
	TableLayoutType,
	TableOfContents,
	TableRow,
	TabStopType,
	TextRun,
	TextWrappingType,
	VerticalAlignTable,
	VerticalPositionRelativeFrom,
	WidthType,
} from "docx";
import type { RootContent } from "mdast";
import { needsPlate, plateBackgrounds } from "../build-cover-html";
import {
	coverVersionLabel,
	isWideTable,
	writtenRows,
} from "../document-content";
import { subtitleOf } from "../print-openers";
import type { ExportRaster } from "../types";
import { renderBlock, renderLetter } from "./blocks";
import { fitImage, imageRun, inlineChildren } from "./inline";
import { renderSectionOpener } from "./opener";
import {
	CONTENTS_HEADING_SIZE,
	COVER_BODY_TOP,
	COVER_BRANDS_HEIGHT,
	COVER_EYEBROW,
	COVER_EYEBROW_TRACKING,
	COVER_LEAD_LINE,
	COVER_LEAD_SIZE,
	COVER_LEAD_WIDTH,
	COVER_LOGO_MAX_HEIGHT,
	COVER_LOGO_MAX_WIDTH,
	COVER_MARGIN,
	COVER_PARTIES_GAP,
	COVER_PARTY_LABEL_SIZE,
	COVER_PARTY_LINE,
	COVER_PARTY_SIZE,
	EYEBROW_SIZE,
	FOOTER_CONFIDENTIAL,
	FOOTER_SEPARATOR,
	FURNITURE_SIZE,
	HERO_MAX_HEIGHT,
	LABEL_TRACKING,
	LANDSCAPE_TEXT_WIDTH,
	LETTER_LOGO_MAX_HEIGHT,
	LOGO_MAX_WIDTH,
	LOGO_PLATE_MARGIN,
	ORGANIZATION_SIZE,
	PAGE,
	PAGE_MARGIN,
	PORTRAIT_TEXT_WIDTH,
	SINGLE_LINE,
	TITLE_SIZE,
	TWIPS_PER_PIXEL,
} from "./styles";
import {
	type BlockContext,
	type Out,
	partyName,
	proseText,
	type RunStyle,
	runProperties,
	textRun,
	type Writer,
} from "./writer";

/** An empty line one point high. */
const HAIRLINE = 20;

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
 * The running footer of every page after the cover, as print's: the
 * proposer, the title, the date and "Confidential" at the left and the page
 * count on a right tab at that section's column edge. Built fresh for each
 * section so each gets a part of its own. Print runs no header, so the
 * header is empty: one of its own, since a section without a header
 * reference would take the one before it, which on the first section after
 * the cover is the cover's ink. Page numbers run on from the cover, which
 * counts as page 1, as on the print page.
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
			default: new Header({ children: [hairline()] }),
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
 * cover letter has a section of its own, and the cover takes the lead, so
 * the body leaves both out.
 *
 * Every root-level Heading 2 opens its section with print's ink card
 * (`renderSectionOpener`), taking a short emphasised paragraph right after
 * it as the card's subtitle, and starts a page unless it already starts a
 * Word section. A Heading 2 nested in a quote or a list is a plain heading,
 * as print sets it.
 */
export function bodySections(writer: Writer): ISectionOptions[] {
	const groups: { landscape: boolean; children: FileChild[] }[] = [];
	const children = writer.input.prepared.root.children;
	const skipped = new Set<RootContent>(
		writer.letter ? [writer.letter.heading, ...writer.letter.nodes] : [],
	);
	if (writer.lead) {
		skipped.add(writer.lead);
	}
	// A wide table that writes no rows takes no landscape page, nor its
	// heading with it.
	const isWide = (node: RootContent | undefined) =>
		node?.type === "table" &&
		isWideTable(node) &&
		writtenRows(node).length > 0;
	for (const [index, node] of children.entries()) {
		if (skipped.has(node)) {
			continue;
		}
		const opener = node.type === "heading" && node.depth === 2;
		const subtitle = opener ? subtitleOf(children[index + 1]) : null;
		const landscape =
			isWide(node) ||
			(opener && isWide(children[subtitle ? index + 2 : index + 1]));
		const context: BlockContext = {
			textWidth: landscape ? LANDSCAPE_TEXT_WIDTH : PORTRAIT_TEXT_WIDTH,
			indent: 0,
			callout: false,
			listDepth: 0,
		};
		const last = groups.at(-1);
		const startsSection = !last || last.landscape !== landscape;
		const out: Out[] = [];
		if (opener) {
			const next = children[index + 1];
			if (subtitle && next) {
				skipped.add(next);
			}
			renderSectionOpener(
				writer,
				node,
				subtitle,
				out,
				context,
				!startsSection,
			);
		} else {
			renderBlock(writer, node, out, context);
		}
		if (out.length === 0) {
			continue;
		}
		let group = last;
		if (!group || startsSection) {
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
 * and a TOC field over the sections' headings at a Heading 2's level, with
 * links. Until Word
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
				// The openers' headings are in a style of their own at a
				// Heading 2's outline level (`SECTION_HEADING_STYLE`).
				useAppliedParagraphOutlineLevel: true,
				hideTabAndPageNumbersInWebView: true,
				cachedEntries: writer.contents.map((title) => ({
					title,
					level: 2,
				})),
			}),
		],
	};
}

/** An empty paragraph one point high. */
function hairline(): Paragraph {
	return new Paragraph({
		spacing: {
			before: 0,
			after: 0,
			line: HAIRLINE,
			lineRule: LineRuleType.EXACT,
		},
	});
}

/**
 * The ink behind the cover: a picture of the page's size, anchored to the
 * paper's corner behind the text, so it takes no room in the flow and the
 * cover's text sits on it as print's sits on its ink. A shaded table or
 * paragraph cannot reach the paper's edges, and one as tall as the page
 * would push the cover section's closing paragraph onto a blank page. It
 * is the cover section's header, so every page of that section has it:
 * a title and lead long enough to run the cover onto a second page still
 * print light on the ink there, never on the paper.
 */
function coverBackdrop(writer: Writer, backdrop: Buffer): Header {
	writer.drawings++;
	return new Header({
		children: [
			new Paragraph({
				spacing: {
					before: 0,
					after: 0,
					line: HAIRLINE,
					lineRule: LineRuleType.EXACT,
				},
				children: [
					new ImageRun({
						type: "png",
						data: backdrop,
						transformation: {
							width: PAGE.width / TWIPS_PER_PIXEL,
							height: PAGE.height / TWIPS_PER_PIXEL,
						},
						floating: {
							horizontalPosition: {
								relative: HorizontalPositionRelativeFrom.PAGE,
								offset: 0,
							},
							verticalPosition: {
								relative: VerticalPositionRelativeFrom.PAGE,
								offset: 0,
							},
							behindDocument: true,
							allowOverlap: true,
							lockAnchor: true,
							wrap: { type: TextWrappingType.NONE },
						},
						altText: {
							id: String(writer.drawings),
							name: `Picture ${writer.drawings}`,
							description: "",
							title: "",
						},
					}),
				],
			}),
		],
	});
}

/**
 * The logos' row: the proposer's at the left edge and the recipient's at
 * the right, in a borderless table of the row's height, or null with
 * neither. A logo that would not read on the cover's ink sits on a plate
 * of the paper, a cell shaded with the surface that hugs the logo, by the
 * rule print plates it with.
 */
function coverBrands(
	writer: Writer,
	proposerName: string | null,
	recipientName: string | null,
): Table | null {
	const { tokens } = writer.input;
	const { ink } = plateBackgrounds(tokens);
	const logo = (raster: ExportRaster | null, description: string) => {
		if (!raster) {
			return null;
		}
		const size = fitImage(
			raster,
			raster.width,
			COVER_LOGO_MAX_WIDTH,
			COVER_LOGO_MAX_HEIGHT,
		);
		const image = imageRun(writer, raster, size, description);
		return image ? { image, size, plate: needsPlate(raster, ink) } : null;
	};
	const proposer = logo(
		tokens.proposer.logo.value,
		proposerName ? `${proposerName} logo` : "Logo",
	);
	const recipient = logo(
		tokens.recipient.logo.value,
		recipientName ? `${recipientName} logo` : "Logo",
	);
	if (!proposer && !recipient) {
		return null;
	}
	const logoCell = (entry: NonNullable<typeof proposer>) => {
		const margins = entry.plate
			? LOGO_PLATE_MARGIN
			: { top: 0, bottom: 0, left: 0, right: 0 };
		const width =
			entry.size.width * TWIPS_PER_PIXEL + margins.left + margins.right;
		return {
			width,
			cell: new TableCell({
				width: { size: width, type: WidthType.DXA },
				verticalAlign: VerticalAlignTable.CENTER,
				margins,
				...(entry.plate
					? {
							shading: {
								type: ShadingType.CLEAR,
								color: "auto",
								fill: writer.colors.surface,
							},
						}
					: {}),
				children: [
					new Paragraph({
						spacing: { before: 0, after: 0, line: SINGLE_LINE },
						children: [entry.image],
					}),
				],
			}),
		};
	};
	const cells = [
		...(proposer ? [logoCell(proposer)] : []),
		{ width: 0, cell: null },
		...(recipient ? [logoCell(recipient)] : []),
	];
	const used = cells.reduce((sum, entry) => sum + entry.width, 0);
	const widths = cells.map((entry) =>
		entry.cell ? entry.width : Math.max(0, PORTRAIT_TEXT_WIDTH - used),
	);
	return new Table({
		width: { size: PORTRAIT_TEXT_WIDTH, type: WidthType.DXA },
		columnWidths: widths,
		layout: TableLayoutType.FIXED,
		borders: TableBorders.NONE,
		margins: { top: 0, bottom: 0, left: 0, right: 0 },
		rows: [
			new TableRow({
				height: { value: COVER_BRANDS_HEIGHT, rule: HeightRule.EXACT },
				cantSplit: true,
				children: cells.map(
					(entry, index) =>
						entry.cell ??
						new TableCell({
							width: {
								size: widths[index] ?? 0,
								type: WidthType.DXA,
							},
							children: [
								new Paragraph({ spacing: { after: 0 } }),
							],
						}),
				),
			}),
		],
	});
}

/**
 * Who it is for on the left, who it is from with the date line on the
 * right, each in its own column whether or not the other is there, as
 * print pins them over the cover's foot: a borderless table floated to the
 * bottom of the cover's margins, so a short title leaves them where a long
 * one does.
 */
function coverParties(
	writer: Writer,
	forLines: readonly string[],
	byLines: readonly string[],
	dateLine: string,
): Table {
	const { colors } = writer;
	const label = (text: string) =>
		new Paragraph({
			spacing: { before: 0, after: 100, line: SINGLE_LINE },
			keepNext: true,
			children: [
				textRun(text, {
					...writer.monoMedium,
					color: colors.onInkAccent,
					size: COVER_PARTY_LABEL_SIZE,
					allCaps: true,
					characterSpacing: LABEL_TRACKING,
				}),
			],
		});
	const line = (text: string) =>
		new Paragraph({
			spacing: { before: 0, after: 0, line: COVER_PARTY_LINE },
			children: [
				textRun(proseText(text), {
					font: writer.fonts.body,
					color: colors.onInkMuted,
					size: COVER_PARTY_SIZE,
				}),
			],
		});
	const party = (heading: string, lines: readonly string[]) =>
		lines.length === 0 ? [] : [label(heading), ...lines.map(line)];
	// Print's columns of 1 : 1.25, the gap the first column's right margin.
	const free = PORTRAIT_TEXT_WIDTH - COVER_PARTIES_GAP;
	const first = Math.round(free / 2.25);
	const widths = [
		first + COVER_PARTIES_GAP,
		PORTRAIT_TEXT_WIDTH - first - COVER_PARTIES_GAP,
	];
	const cell = (children: Paragraph[], index: number) =>
		new TableCell({
			width: { size: widths[index] ?? 0, type: WidthType.DXA },
			margins: {
				top: 0,
				bottom: 0,
				left: 0,
				right: index === 0 ? COVER_PARTIES_GAP : 0,
			},
			children:
				children.length > 0
					? children
					: [new Paragraph({ spacing: { after: 0 } })],
		});
	return new Table({
		width: { size: PORTRAIT_TEXT_WIDTH, type: WidthType.DXA },
		columnWidths: widths,
		layout: TableLayoutType.FIXED,
		borders: TableBorders.NONE,
		float: {
			horizontalAnchor: TableAnchorType.MARGIN,
			absoluteHorizontalPosition: 0,
			verticalAnchor: TableAnchorType.MARGIN,
			relativeVerticalPosition: RelativeVerticalPosition.BOTTOM,
		},
		rows: [
			new TableRow({
				cantSplit: true,
				children: [
					cell(party("Prepared for", forLines), 0),
					cell(
						[
							...party("Prepared by", byLines),
							...(dateLine === "" ? [] : [line(dateLine)]),
						],
						1,
					),
				],
			}),
		],
	});
}

/**
 * The cover, on the ink as print sets it, with no running footer: the
 * logos' row, the hero, then the eyebrow, the title and the lead in light
 * text from the eyebrow's place down the page, and the parties at the foot.
 * The ink is a picture behind the text (`coverBackdrop`); the hero is a
 * picture of its own above the title, since Word cannot lay the print
 * cover's veil over it.
 *
 * Every field comes from data, as on the print cover: the lead is the
 * preamble's first paragraph when print's cover takes it, and a cover fence
 * in the preamble sets the eyebrow in place of "Proposal", a line about the
 * client under the logos at the right, the party lines in place of the
 * names, and the version on the date line.
 */
export function coverSection(
	writer: Writer,
	backdrop: Buffer,
): ISectionOptions {
	const { input, colors, fonts } = writer;
	const { tokens } = input;
	const proposerName = partyName(tokens.proposer.name.value);
	const recipientName = partyName(tokens.recipient.name.value);
	const details = writer.coverFence?.details ?? null;
	const children: FileChild[] = [];
	let used = 0;

	const brands = coverBrands(writer, proposerName, recipientName);
	if (brands) {
		children.push(brands);
		used += COVER_BRANDS_HEIGHT;
	}

	const organization = details?.organization
		? partyName(proseText(details.organization))
		: null;
	if (organization) {
		children.push(
			new Paragraph({
				alignment: AlignmentType.RIGHT,
				spacing: { before: 0, after: 0, line: SINGLE_LINE },
				children: [
					textRun(organization, {
						font: fonts.mono,
						color: colors.onInkMuted,
						size: ORGANIZATION_SIZE,
						allCaps: true,
						characterSpacing: LABEL_TRACKING,
					}),
				],
			}),
		);
		used += SINGLE_LINE;
	}

	const hero = tokens.proposer.hero.value;
	const heroRun = hero
		? imageRun(
				writer,
				hero,
				fitImage(
					hero,
					hero.width,
					PORTRAIT_TEXT_WIDTH,
					HERO_MAX_HEIGHT,
				),
				"Cover image",
			)
		: null;
	if (heroRun) {
		children.push(
			new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: {
					before: brands ? 480 : 0,
					after: 0,
					line: SINGLE_LINE,
				},
				children: [heroRun],
			}),
		);
	}

	children.push(
		new Paragraph({
			// The eyebrow where print's sits, 3.05in down the page, and closer
			// under a hero.
			spacing: {
				before: heroRun
					? 600
					: Math.max(0, COVER_BODY_TOP - COVER_MARGIN.top - used),
				after: 240,
				line: SINGLE_LINE,
			},
			keepNext: true,
			children: [
				textRun(proseText(details?.eyebrow ?? COVER_EYEBROW), {
					...writer.monoMedium,
					color: colors.onInkPrimary,
					size: EYEBROW_SIZE,
					allCaps: true,
					characterSpacing: COVER_EYEBROW_TRACKING,
				}),
			],
		}),
		new Paragraph({
			heading: HeadingLevel.TITLE,
			children: [
				textRun(proseText(writer.title), {
					font: fonts.display,
					color: colors.onInk,
					size: TITLE_SIZE,
					bold: true,
				}),
			],
		}),
	);
	if (writer.lead) {
		const muted = colors.onInkMuted;
		children.push(
			new Paragraph({
				spacing: { before: 0, after: 0, line: COVER_LEAD_LINE },
				indent: {
					right: Math.max(0, PORTRAIT_TEXT_WIDTH - COVER_LEAD_WIDTH),
				},
				children: inlineChildren(
					writer,
					writer.lead.children,
					{
						font: fonts.body,
						color: muted,
						size: COVER_LEAD_SIZE,
						linkColor: muted,
						linkUnderline: muted,
					},
					{
						textWidth: PORTRAIT_TEXT_WIDTH,
						indent: 0,
						callout: false,
						listDepth: 0,
					},
				),
			}),
		);
	}

	// The fence's lines for a party, else the name the tokens hold.
	const lines = (
		fence: readonly string[] | undefined,
		fallback: string | null,
	): string[] =>
		fence !== undefined && fence.length > 0
			? fence.map((text) => proseText(text))
			: fallback === null
				? []
				: [proseText(fallback)];
	const dateLine = [
		partyName(input.dateLabel),
		details?.version ? coverVersionLabel(details.version) : null,
		FOOTER_CONFIDENTIAL,
	]
		.filter((part): part is string => part !== null)
		.join(FOOTER_SEPARATOR);
	children.push(
		coverParties(
			writer,
			lines(details?.forLines, recipientName),
			lines(details?.byLines, proposerName),
			dateLine,
		),
	);

	return {
		properties: {
			page: {
				size: {
					width: PAGE.width,
					height: PAGE.height,
					orientation: PageOrientation.PORTRAIT,
				},
				margin: COVER_MARGIN,
			},
		},
		headers: { default: coverBackdrop(writer, backdrop) },
		children,
	};
}

/**
 * The cover letter, after the cover and before the contents, or null
 * without one: the proposer's logo at the left with the letter's heading at
 * the right edge, the logo on a plate of the ink when print's letter plates
 * it, then the letter. The heading is a plain paragraph, set
 * as a label, never a Heading 2 and with no outline level, so the contents'
 * TOC field never lists it. The running footer prints on it as on every
 * page after the cover.
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
	const label = textRun(proseText(letter.label), {
		...writer.monoMedium,
		color: colors.muted,
		size: EYEBROW_SIZE,
		allCaps: true,
		characterSpacing: LABEL_TRACKING,
	});
	// A logo drawn for a dark background sits on a plate of the ink, as on
	// print's letter page: a shaded cell that hugs it, beside the label.
	const plated =
		raster !== null &&
		logo !== null &&
		needsPlate(raster, plateBackgrounds(writer.input.tokens).paper);
	const head: FileChild[] = [];
	if (plated) {
		const size = fitImage(
			raster,
			raster.width,
			LOGO_MAX_WIDTH,
			LETTER_LOGO_MAX_HEIGHT,
		);
		const logoWidth =
			size.width * TWIPS_PER_PIXEL +
			LOGO_PLATE_MARGIN.left +
			LOGO_PLATE_MARGIN.right;
		const labelWidth = Math.max(0, PORTRAIT_TEXT_WIDTH - logoWidth);
		head.push(
			new Table({
				width: { size: PORTRAIT_TEXT_WIDTH, type: WidthType.DXA },
				columnWidths: [logoWidth, labelWidth],
				layout: TableLayoutType.FIXED,
				borders: TableBorders.NONE,
				rows: [
					new TableRow({
						cantSplit: true,
						children: [
							new TableCell({
								width: { size: logoWidth, type: WidthType.DXA },
								verticalAlign: VerticalAlignTable.CENTER,
								margins: LOGO_PLATE_MARGIN,
								shading: {
									type: ShadingType.CLEAR,
									color: "auto",
									fill: colors.ink,
								},
								children: [
									new Paragraph({
										spacing: {
											before: 0,
											after: 0,
											line: SINGLE_LINE,
										},
										children: [logo],
									}),
								],
							}),
							new TableCell({
								width: {
									size: labelWidth,
									type: WidthType.DXA,
								},
								verticalAlign: VerticalAlignTable.CENTER,
								margins: {
									top: 0,
									bottom: 0,
									left: 0,
									right: 0,
								},
								children: [
									new Paragraph({
										alignment: AlignmentType.RIGHT,
										spacing: {
											before: 0,
											after: 0,
											line: SINGLE_LINE,
										},
										children: [label],
									}),
								],
							}),
						],
					}),
				],
			}),
			new Paragraph({
				spacing: {
					before: 0,
					after: 480 - HAIRLINE,
					line: HAIRLINE,
					lineRule: LineRuleType.EXACT,
				},
			}),
		);
	} else {
		head.push(
			new Paragraph({
				spacing: { before: 0, after: 480, line: SINGLE_LINE },
				tabStops: [
					{ type: TabStopType.RIGHT, position: PORTRAIT_TEXT_WIDTH },
				],
				children: [
					...(logo ? [logo] : []),
					new TextRun({ children: [new Tab()] }),
					label,
				],
			}),
		);
	}
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
		children: [...head, ...fileChildren(out)],
	};
}
