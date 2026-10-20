/**
 * Tables of the Word writer (Fizzy #2946): Markdown data tables and stat
 * tiles, both laid out as fixed-width Word tables.
 */

import type { StatTileItem } from "@repo/utils/proposal-artifact/stat-tiles";
import {
	AlignmentType,
	BorderStyle,
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
import type { Table as MdTable } from "mdast";
import { flatText } from "../markdown";
import { inlineChildren } from "./inline";
import {
	CELL_MARGIN,
	LABEL_TRACKING,
	NO_BORDER,
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
 * runs onto, filled with the primary colour; data rows alternate with the
 * tint, the first one tinted, as print does; rules in the paint's border
 * colour; column alignment from the Markdown.
 */
export function renderTable(
	writer: Writer,
	table: MdTable,
	out: Out[],
	context: BlockContext,
): void {
	const { colors, fonts } = writer;
	const columns = columnCount(table);
	const width = context.textWidth - context.indent;
	const widths = columnWidths(table, columns, width);
	const rule: IBorderOptions = {
		style: BorderStyle.SINGLE,
		size: 6,
		color: colors.border,
	};
	const headerRule: IBorderOptions = { ...rule, color: colors.primary };

	const rows = table.children.map((row, rowIndex) => {
		const header = rowIndex === 0;
		const tinted = !header && rowIndex % 2 === 1;
		// A link in a header cell takes the cell's own text colour, as print
		// does: the paper's link colour may be the fill.
		const style: RunStyle = header
			? {
					font: fonts.mono,
					color: colors.onPrimary,
					size: TABLE_HEADER_SIZE,
					bold: true,
					allCaps: true,
					characterSpacing: LABEL_TRACKING,
					linkColor: colors.onPrimary,
					linkUnderline: colors.onPrimary,
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
									fill: header ? colors.primary : colors.tint,
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
 * colour over its label in small uppercase, each tile under a primary rule.
 * Narrow empty columns between the tiles keep their rules apart.
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
								font: fonts.mono,
								color: colors.muted,
								size: STAT_LABEL_SIZE,
								bold: true,
								allCaps: true,
								characterSpacing: LABEL_TRACKING,
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
