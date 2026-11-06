/**
 * Tables of the Word writer (Fizzy #2946): Markdown data tables, stat tiles,
 * card grids and two columns, all laid out as fixed-width Word tables.
 */

import type {
	CardItem,
	ColumnBlock,
	InlineSegment,
} from "@repo/utils/proposal-artifact/proposal-blocks";
import type { StatTileItem } from "@repo/utils/proposal-artifact/stat-tiles";
import {
	AlignmentType,
	BorderStyle,
	HeightRule,
	type IBorderOptions,
	type IParagraphOptions,
	Paragraph,
	ShadingType,
	Table,
	TableBorders,
	TableCell,
	TableLayoutType,
	TableRow,
	TextRun,
	VerticalAlignTable,
	WidthType,
} from "docx";
import type { Table as MdTable, PhrasingContent } from "mdast";
import { writtenRows } from "../document-content";
import { flatText } from "../markdown";
import { inlineChildren } from "./inline";
import {
	CELL_MARGIN,
	EYEBROW_TRACKING,
	LABEL_TRACKING,
	LIST_ITEM_AFTER,
	NO_BORDER,
	registerList,
	SINGLE_LINE,
	STAT_LABEL_SIZE,
	STAT_TILE_GAP,
	STAT_VALUE_SIZE,
	TABLE_HEADER_SIZE,
	TABLE_SIZE,
} from "./styles";
import {
	type BlockContext,
	bodyRunStyle,
	type Out,
	proseText,
	type RunStyle,
	textRun,
	type Writer,
} from "./writer";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function columnCount(table: MdTable): number {
	return Math.max(1, ...table.children.map((row) => row.children.length));
}

/**
 * Column widths in twips that add up to the column exactly, weighted by the
 * longest text each column holds (within limits, so a short column is never
 * a sliver). Without explicit widths docx writes a 100-twip grid, which
 * readers that lay a table out by its grid squeeze to a letter a column.
 */
function columnWidths(
	table: MdTable,
	columns: number,
	width: number,
): number[] {
	const weights = Array.from({ length: columns }, (_, column) => {
		const longest = Math.max(
			0,
			...table.children.map((row) => {
				const cell = row.children[column];
				return cell ? flatText(cell).length : 0;
			}),
		);
		return Math.min(Math.max(longest, 6), 40);
	});
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	const widths = weights.map((weight) =>
		Math.floor((width * weight) / total),
	);
	let remainder = width - widths.reduce((sum, value) => sum + value, 0);
	for (let column = 0; remainder > 0; column = (column + 1) % columns) {
		widths[column] = (widths[column] ?? 0) + 1;
		remainder--;
	}
	return widths;
}

const CELL_ALIGNMENT = {
	left: AlignmentType.LEFT,
	center: AlignmentType.CENTER,
	right: AlignmentType.RIGHT,
} as const;

/**
 * A data table: the first row is the header, repeated on every page it
 * runs onto, filled with the ink and set in light mono labels, as print's
 * header row is; rows alternate with the tint,
 * counted over the rows written, so a data row right under the header is
 * tinted; rules in the paint's border colour; column alignment from the
 * Markdown. A header row with nothing in it is left out, as print leaves
 * it out, so the table opens on a plain row and nothing repeats; a table
 * with nothing else writes nothing.
 */
export function renderTable(
	writer: Writer,
	table: MdTable,
	out: Out[],
	context: BlockContext,
): void {
	const { colors } = writer;
	const written = writtenRows(table);
	if (written.length === 0) {
		return;
	}
	const headerless = written.length < table.children.length;
	const columns = columnCount(table);
	const width = context.textWidth - context.indent;
	const widths = columnWidths(table, columns, width);
	const rule: IBorderOptions = {
		style: BorderStyle.SINGLE,
		size: 6,
		color: colors.border,
	};
	const headerRule: IBorderOptions = { ...rule, color: colors.ink };

	const rows = written.map((row, rowIndex) => {
		const header = !headerless && rowIndex === 0;
		const tinted = !header && rowIndex % 2 === 1;
		// A link in a header cell takes the cell's own text colour, as print
		// does: the paper's link colour may be the fill.
		const style: RunStyle = header
			? {
					...writer.monoMedium,
					color: colors.onInk,
					size: TABLE_HEADER_SIZE,
					allCaps: true,
					characterSpacing: LABEL_TRACKING,
					linkColor: colors.onInk,
					linkUnderline: colors.onInk,
				}
			: { ...bodyRunStyle(writer), size: TABLE_SIZE };
		return new TableRow({
			tableHeader: header,
			cantSplit: true,
			children: Array.from({ length: columns }, (_, column) => {
				const cell = row.children[column];
				const align = table.align?.[column];
				return new TableCell({
					width: { size: widths[column] ?? 0, type: WidthType.DXA },
					verticalAlign: header
						? VerticalAlignTable.BOTTOM
						: VerticalAlignTable.TOP,
					shading:
						header || tinted
							? {
									type: ShadingType.CLEAR,
									color: "auto",
									fill: header ? colors.ink : colors.tint,
								}
							: undefined,
					borders: header
						? {
								top: headerRule,
								bottom: headerRule,
								left: headerRule,
								right: headerRule,
							}
						: undefined,
					children: [
						new Paragraph({
							alignment: align
								? CELL_ALIGNMENT[align]
								: undefined,
							spacing: { before: 0, after: 0, line: 276 },
							children: cell
								? inlineChildren(writer, cell.children, style, {
										...context,
										indent: 0,
										callout: false,
										textWidth:
											(widths[column] ?? 0) -
											CELL_MARGIN.left -
											CELL_MARGIN.right,
									})
								: [],
						}),
					],
				});
			}),
		});
	});

	out.push({
		table: new Table({
			width: { size: width, type: WidthType.DXA },
			columnWidths: widths,
			layout: TableLayoutType.FIXED,
			indent:
				context.indent > 0
					? { size: context.indent, type: WidthType.DXA }
					: undefined,
			margins: CELL_MARGIN,
			borders: {
				top: rule,
				bottom: rule,
				left: rule,
				right: rule,
				insideHorizontal: rule,
				insideVertical: rule,
			},
			rows,
		}),
	});
	out.push({ paragraph: spacerParagraph() });
}

/**
 * A table cannot follow a table directly (Word merges the two), and a
 * paragraph straight after one has no room above it: a small empty
 * paragraph gives both.
 */
export function spacerParagraph(): IParagraphOptions {
	return {
		spacing: { before: 0, after: 120, line: SINGLE_LINE },
		children: [new TextRun({ text: "", size: 12 })],
	};
}

/**
 * Stat tiles: a borderless one-row table, the value large in the heading
 * colour over its label, each tile under a primary rule. The value and the
 * label are at print's sizes, and the label is muted body text at regular
 * weight in its own case, as print sets it. Narrow empty columns between
 * the tiles keep their rules apart.
 */
export function statTilesTable(
	writer: Writer,
	items: readonly StatTileItem[],
	context: BlockContext,
): Table {
	const { colors, fonts } = writer;
	const width = context.textWidth - context.indent;
	const gaps = items.length - 1;
	const tileWidth = Math.floor((width - STAT_TILE_GAP * gaps) / items.length);
	const widths: number[] = [];
	const cells: TableCell[] = [];
	items.forEach((item, index) => {
		if (index > 0) {
			widths.push(STAT_TILE_GAP);
			cells.push(
				new TableCell({
					width: { size: STAT_TILE_GAP, type: WidthType.DXA },
					borders: {
						top: NO_BORDER,
						bottom: NO_BORDER,
						left: NO_BORDER,
						right: NO_BORDER,
					},
					children: [new Paragraph({ spacing: { after: 0 } })],
				}),
			);
		}
		widths.push(tileWidth);
		cells.push(
			new TableCell({
				width: { size: tileWidth, type: WidthType.DXA },
				margins: { top: 160, bottom: 120, left: 0, right: 80 },
				borders: {
					top: {
						style: BorderStyle.SINGLE,
						size: 24,
						color: colors.primary,
					},
					bottom: NO_BORDER,
					left: NO_BORDER,
					right: NO_BORDER,
				},
				children: [
					new Paragraph({
						spacing: { before: 0, after: 60, line: SINGLE_LINE },
						keepNext: true,
						children: [
							textRun(proseText(item.value), {
								font: fonts.display,
								color: colors.heading,
								size: STAT_VALUE_SIZE,
								bold: true,
							}),
						],
					}),
					new Paragraph({
						spacing: { before: 0, after: 0, line: SINGLE_LINE },
						children: [
							textRun(proseText(item.label), {
								font: fonts.body,
								color: colors.muted,
								size: STAT_LABEL_SIZE,
							}),
						],
					}),
				],
			}),
		);
	});
	return new Table({
		width: {
			size: widths.reduce((sum, value) => sum + value, 0),
			type: WidthType.DXA,
		},
		columnWidths: widths,
		layout: TableLayoutType.FIXED,
		indent:
			context.indent > 0
				? { size: context.indent, type: WidthType.DXA }
				: undefined,
		borders: TableBorders.NONE,
		rows: [new TableRow({ cantSplit: true, children: cells })],
	});
}

// ---------------------------------------------------------------------------
// Cards and columns
// ---------------------------------------------------------------------------

/** Card and column type in half-points, at print's sizes. */
const CARD_LABEL_SIZE = 16;
const CARD_TITLE_SIZE = 21;
const CARD_TEXT_SIZE = 18;
const COLUMNS_SIZE = 18;
const COLUMN_HEADING_SIZE = 21;
/** The leading of card and column text, as Word reads print's 1.5. */
const SMALL_TEXT_LINE = 312;
/** The gap between two cards, across and down: print's 10pt. */
const CARD_GAP = 200;
/** A card's padding: print's 13pt by 15pt. */
const CARD_MARGIN = { top: 260, bottom: 260, left: 300, right: 300 } as const;
/** Each column's share of print's 0.28in gap between the two. */
const COLUMN_HALF_GAP = 202;
/** The space a column leaves after a paragraph or a list. */
const COLUMN_BLOCK_AFTER = 120;
/** The space above a column heading that follows other blocks. */
const COLUMN_HEADING_BEFORE = 200;

const NO_BORDERS = {
	top: NO_BORDER,
	bottom: NO_BORDER,
	left: NO_BORDER,
	right: NO_BORDER,
} as const;

/**
 * A run of marked text from a cards or columns block, as the Markdown it
 * came from, so the inline writer sets it exactly as body text: bold,
 * italic and shaded inline code, each character kept.
 */
function segmentNodes(segments: readonly InlineSegment[]): PhrasingContent[] {
	return segments.map((segment) => {
		let node: PhrasingContent = segment.code
			? { type: "inlineCode", value: segment.text }
			: { type: "text", value: segment.text };
		if (segment.italic) {
			node = { type: "emphasis", children: [node] };
		}
		if (segment.bold) {
			node = { type: "strong", children: [node] };
		}
		return node;
	});
}

/** Text inside a cell: no indent of its own, the cell's width less its padding. */
function cellContext(
	context: BlockContext,
	width: number,
	margins: { left: number; right: number },
): BlockContext {
	return {
		...context,
		indent: 0,
		callout: false,
		textWidth: width - margins.left - margins.right,
	};
}

/**
 * An empty borderless cell: a gap between cards, or a slot no card fills.
 * No padding, so Word never widens a gap narrower than its default padding.
 */
function emptyCell(width: number): TableCell {
	return new TableCell({
		width: { size: width, type: WidthType.DXA },
		margins: { top: 0, bottom: 0, left: 0, right: 0 },
		borders: NO_BORDERS,
		children: [
			new Paragraph({
				spacing: { before: 0, after: 0, line: SINGLE_LINE },
				children: [new TextRun({ text: "", size: 2 })],
			}),
		],
	});
}

/** One card: its label in mono capitals in the label colour, its title and text. */
function cardCell(
	writer: Writer,
	item: CardItem,
	width: number,
	context: BlockContext,
): TableCell {
	const { colors, fonts } = writer;
	const rule: IBorderOptions = {
		style: BorderStyle.SINGLE,
		size: 6,
		color: colors.border,
	};
	const text = cellContext(context, width, CARD_MARGIN);
	const paragraphs: IParagraphOptions[] = [
		{
			spacing: { before: 0, after: 100, line: SINGLE_LINE },
			children: [
				textRun(proseText(item.label), {
					...writer.monoMedium,
					color: colors.label,
					size: CARD_LABEL_SIZE,
					allCaps: true,
					characterSpacing: EYEBROW_TRACKING,
				}),
			],
		},
	];
	if (item.title) {
		paragraphs.push({
			spacing: { before: 0, after: item.text ? 60 : 0, line: 264 },
			children: inlineChildren(
				writer,
				segmentNodes(item.title),
				{
					font: fonts.display,
					color: colors.ink,
					size: CARD_TITLE_SIZE,
					bold: true,
				},
				text,
			),
		});
	}
	if (item.text) {
		paragraphs.push({
			spacing: { before: 0, after: 0, line: SMALL_TEXT_LINE },
			children: inlineChildren(
				writer,
				segmentNodes(item.text),
				{
					...bodyRunStyle(writer),
					color: colors.muted,
					size: CARD_TEXT_SIZE,
				},
				text,
			),
		});
	}
	return new TableCell({
		width: { size: width, type: WidthType.DXA },
		margins: CARD_MARGIN,
		verticalAlign: VerticalAlignTable.TOP,
		borders: { top: rule, bottom: rule, left: rule, right: rule },
		children: paragraphs.map((options) => new Paragraph(options)),
	});
}

/**
 * A card grid: a borderless table whose cards are bordered cells, two to a
 * row, or three when there are exactly three. Narrow empty columns and
 * short empty rows keep the cards apart, as print's gap does; a slot no
 * card fills stays empty.
 */
export function cardsTable(
	writer: Writer,
	items: readonly CardItem[],
	context: BlockContext,
): Table {
	const across = items.length === 3 ? 3 : 2;
	const width = context.textWidth - context.indent;
	const cardWidth = Math.floor((width - CARD_GAP * (across - 1)) / across);
	const widths: number[] = [];
	for (let column = 0; column < across; column++) {
		if (column > 0) {
			widths.push(CARD_GAP);
		}
		widths.push(cardWidth);
	}

	const rows: TableRow[] = [];
	for (let first = 0; first < items.length; first += across) {
		if (first > 0) {
			rows.push(
				new TableRow({
					height: { value: CARD_GAP, rule: HeightRule.EXACT },
					children: widths.map((size) => emptyCell(size)),
				}),
			);
		}
		const cells: TableCell[] = [];
		for (let column = 0; column < across; column++) {
			if (column > 0) {
				cells.push(emptyCell(CARD_GAP));
			}
			const item = items[first + column];
			cells.push(
				item
					? cardCell(writer, item, cardWidth, context)
					: emptyCell(cardWidth),
			);
		}
		rows.push(new TableRow({ cantSplit: true, children: cells }));
	}

	return new Table({
		width: {
			size: widths.reduce((sum, value) => sum + value, 0),
			type: WidthType.DXA,
		},
		columnWidths: widths,
		layout: TableLayoutType.FIXED,
		indent:
			context.indent > 0
				? { size: context.indent, type: WidthType.DXA }
				: undefined,
		borders: TableBorders.NONE,
		rows,
	});
}

/**
 * One column's blocks: a heading in the display face, never a Word heading,
 * so it stays out of the contents; bullets through the list numbering, one
 * definition per list; paragraphs. The column ends without a gap.
 */
function columnParagraphs(
	writer: Writer,
	blocks: readonly ColumnBlock[],
	context: BlockContext,
): Paragraph[] {
	const { colors, fonts } = writer;
	const body: RunStyle = { ...bodyRunStyle(writer), size: COLUMNS_SIZE };
	const heading: RunStyle = {
		font: fonts.display,
		color: colors.ink,
		size: COLUMN_HEADING_SIZE,
		bold: true,
	};
	const paragraphs: IParagraphOptions[] = [];
	const endBlock = () => {
		const last = paragraphs.at(-1);
		if (last) {
			paragraphs[paragraphs.length - 1] = {
				...last,
				spacing: { ...last.spacing, after: COLUMN_BLOCK_AFTER },
			};
		}
	};
	for (const block of blocks) {
		switch (block.type) {
			case "heading":
				paragraphs.push({
					keepNext: true,
					keepLines: true,
					spacing: {
						before:
							paragraphs.length > 0 ? COLUMN_HEADING_BEFORE : 0,
						after: 80,
						line: 264,
					},
					children: inlineChildren(
						writer,
						segmentNodes(block.segments),
						heading,
						context,
					),
				});
				break;
			case "list": {
				const reference = registerList(writer, {
					type: "list",
					ordered: false,
					children: [],
				});
				for (const item of block.items) {
					paragraphs.push({
						numbering: { reference, level: 0, instance: 0 },
						spacing: {
							before: 0,
							after: LIST_ITEM_AFTER,
							line: SMALL_TEXT_LINE,
						},
						children: inlineChildren(
							writer,
							segmentNodes(item),
							body,
							context,
						),
					});
				}
				endBlock();
				break;
			}
			case "paragraph":
				paragraphs.push({
					spacing: {
						before: 0,
						after: COLUMN_BLOCK_AFTER,
						line: SMALL_TEXT_LINE,
					},
					children: inlineChildren(
						writer,
						segmentNodes(block.segments),
						body,
						context,
					),
				});
				break;
		}
	}
	const last = paragraphs.at(-1);
	if (last) {
		paragraphs[paragraphs.length - 1] = {
			...last,
			spacing: { ...last.spacing, after: 0 },
		};
	}
	return paragraphs.map((options) => new Paragraph(options));
}

/**
 * Two columns: a borderless two-cell table, each half of print's gap on its
 * inner side. Its one row may run onto the next page, since two columns can
 * hold more than a page.
 */
export function columnsTable(
	writer: Writer,
	columns: readonly [ColumnBlock[], ColumnBlock[]],
	context: BlockContext,
): Table {
	const width = context.textWidth - context.indent;
	const leftWidth = Math.floor(width / 2);
	const widths = [leftWidth, width - leftWidth];
	const cells = columns.map((blocks, index) => {
		const cellWidth = widths[index] ?? 0;
		const margins =
			index === 0
				? { top: 0, bottom: 0, left: 0, right: COLUMN_HALF_GAP }
				: { top: 0, bottom: 0, left: COLUMN_HALF_GAP, right: 0 };
		return new TableCell({
			width: { size: cellWidth, type: WidthType.DXA },
			margins,
			verticalAlign: VerticalAlignTable.TOP,
			borders: NO_BORDERS,
			children: columnParagraphs(
				writer,
				blocks,
				cellContext(context, cellWidth, margins),
			),
		});
	});
	return new Table({
		width: { size: width, type: WidthType.DXA },
		columnWidths: widths,
		layout: TableLayoutType.FIXED,
		indent:
			context.indent > 0
				? { size: context.indent, type: WidthType.DXA }
				: undefined,
		borders: TableBorders.NONE,
		rows: [new TableRow({ children: cells })],
	});
}
