/**
 * The process template, which also draws a timeline: numbered steps in
 * rows, joined by arrows, with an optional dashed loop back.
 *
 * Pure functions and data only: client components import this module.
 */

import type { FigureKind, FigureModel, FigureNode } from "./parse";
import {
	charBudget,
	checkedIdPrefix,
	checkedPalette,
	FIGURE_WIDTH,
	type FigureOptions,
	type FigurePalette,
	FONT_SIZE,
	figureTitle,
	INTER_EM,
	LINE_HEIGHT,
	labelElements,
	MONO_EM,
	num,
	spoken,
	svgDocument,
	textElement,
	type WrappedLabel,
	wrapLabel,
	wrapLine,
} from "./svg-text";

export interface ProcessFigureOptions extends FigureOptions {
	/** Timeline: each node's first label line is a mono eyebrow. */
	dated?: boolean;
}

function arrowMarker(id: string, color: string): string {
	return `<marker id="${id}" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="${color}"/></marker>`;
}

const PROCESS_MAX_STEPS = 16;
const PROCESS_COLUMNS = 4;
const PROCESS_COLUMN_GAP = 20;
const PROCESS_ROW_GAP = 36;
const PROCESS_PAD = 10;
const PROCESS_SQUARE = 22;
const PROCESS_MIN_HEIGHT = 72;
/** Room left of the grid for the loop's rail. */
const LOOP_INSET = 14;
const LOOP_RAIL_X = 5;
const LOOP_DROP = 14;
/** Room above the first row when the loop enters a step from above. */
const LOOP_TOP_INSET = 14;

/**
 * The steps in chain order, or null when the solid edges are not one simple
 * path through every node: a branch, a join, a cycle, a second chain, a
 * labelled solid edge, or a subgraph.
 */
function processChain(model: FigureModel): FigureNode[] | null {
	if (
		model.nodes.length === 0 ||
		model.nodes.length > PROCESS_MAX_STEPS ||
		model.subgraphs.length > 0
	) {
		return null;
	}
	const next = new Map<string, string>();
	const incoming = new Set<string>();
	for (const edge of model.edges) {
		if (edge.dashed) {
			continue;
		}
		if (
			edge.label.length > 0 ||
			next.has(edge.from) ||
			incoming.has(edge.to)
		) {
			return null;
		}
		next.set(edge.from, edge.to);
		incoming.add(edge.to);
	}
	const starts = model.nodes.filter((node) => !incoming.has(node.id));
	if (starts.length !== 1) {
		return null;
	}
	const byId = new Map(model.nodes.map((node) => [node.id, node]));
	const chain: FigureNode[] = [];
	const seen = new Set<string>();
	let id: string | undefined = starts[0].id;
	while (id !== undefined && !seen.has(id)) {
		seen.add(id);
		const node = byId.get(id);
		if (!node) {
			return null;
		}
		chain.push(node);
		id = next.get(id);
	}
	return chain.length === model.nodes.length ? chain : null;
}

interface ProcessBox {
	node: FigureNode;
	index: number;
	row: number;
	column: number;
	x: number;
	eyebrow: string[];
	label: WrappedLabel;
	/** Natural height before the row evens it out. */
	height: number;
	highlight: boolean;
}

/**
 * A numbered process: the steps in chain order, in rows of at most four,
 * each box with its number in a square. A `highlight` class gives the step
 * the tint fill and a primary square. Plain arrows join the steps of a row
 * and an elbow joins one row to the next. One dashed `-.->` back edge from a
 * step in the last row to an earlier step draws as a dashed primary loop
 * under the rows, with its label. With `dated`, each node's first label line
 * is a mono eyebrow beside the number (a timeline).
 *
 * Null when the model is not one chain (see `processChain`), or its dashed
 * edges are anything but one such back edge.
 */
export function processFigureSvg(
	model: FigureModel,
	palette: FigurePalette,
	options: ProcessFigureOptions = {},
): string | null {
	const colors = checkedPalette(palette);
	const prefix = checkedIdPrefix(options);
	const chain = processChain(model);
	if (!chain) {
		return null;
	}
	const position = new Map(chain.map((node, index) => [node.id, index]));
	const dashed = model.edges.filter((edge) => edge.dashed);
	if (dashed.length > 1) {
		return null;
	}
	const columns = Math.min(PROCESS_COLUMNS, chain.length);
	const rowCount = Math.ceil(chain.length / PROCESS_COLUMNS);
	const loopEdge = dashed[0];
	let loop: { from: number; to: number; label: string[] } | null = null;
	if (loopEdge) {
		const from = position.get(loopEdge.from) ?? -1;
		const to = position.get(loopEdge.to) ?? -1;
		if (
			to < 0 ||
			from <= to ||
			Math.floor(from / PROCESS_COLUMNS) !== rowCount - 1
		) {
			return null;
		}
		loop = { from, to, label: loopEdge.label };
	}

	const left = loop ? LOOP_INSET : 0;
	const boxWidth =
		(FIGURE_WIDTH - left - (columns - 1) * PROCESS_COLUMN_GAP) / columns;
	const innerWidth = boxWidth - 2 * PROCESS_PAD;
	const eyebrowWidth = innerWidth - PROCESS_SQUARE - 8;
	const bodyBudget = charBudget(innerWidth, INTER_EM);
	const eyebrowBudget = charBudget(eyebrowWidth, MONO_EM);

	const boxes: ProcessBox[] = chain.map((node, index) => {
		const dated = options.dated === true && node.lines.length > 1;
		const eyebrow = dated ? wrapLine(node.lines[0], eyebrowBudget) : [];
		const label = wrapLabel(
			dated ? node.lines.slice(1) : node.lines,
			bodyBudget,
		);
		const headerBottom = Math.max(
			PROCESS_SQUARE,
			eyebrow.length > 0
				? 15.5 + (eyebrow.length - 1) * LINE_HEIGHT + 4
				: 0,
		);
		const textHeight =
			label.lineCount > 0 ? 8 + label.lineCount * LINE_HEIGHT : 0;
		const column = index % PROCESS_COLUMNS;
		return {
			node,
			index,
			row: Math.floor(index / PROCESS_COLUMNS),
			column,
			x: left + column * (boxWidth + PROCESS_COLUMN_GAP),
			eyebrow,
			label,
			height: Math.max(
				PROCESS_MIN_HEIGHT,
				PROCESS_PAD * 2 + headerBottom + textHeight,
			),
			highlight: node.classes.includes("highlight"),
		};
	});

	const top =
		loop && boxes[loop.to].row === 0 && boxes[loop.to].column !== 0
			? LOOP_TOP_INSET
			: 0;
	const rowHeights = Array.from({ length: rowCount }, (_, row) =>
		Math.max(
			...boxes.filter((box) => box.row === row).map((b) => b.height),
		),
	);
	const rowTops: number[] = [];
	let y = top;
	for (const height of rowHeights) {
		rowTops.push(y);
		y += height + PROCESS_ROW_GAP;
	}
	const gridBottom = y - PROCESS_ROW_GAP;

	const arrowId = `${prefix}-arrow`;
	const loopArrowId = `${prefix}-loop-arrow`;
	const body: string[] = [];
	for (const box of boxes) {
		const boxTop = rowTops[box.row];
		const height = rowHeights[box.row];
		body.push(
			`<rect class="step" x="${num(box.x)}" y="${num(boxTop)}" width="${num(boxWidth)}" height="${num(height)}" rx="4" fill="${box.highlight ? colors.tint : colors.surface}" stroke="${colors.border}"/>`,
		);
		const squareX = box.x + PROCESS_PAD;
		const squareY = boxTop + PROCESS_PAD;
		body.push(
			`<rect class="number" x="${num(squareX)}" y="${num(squareY)}" width="${PROCESS_SQUARE}" height="${PROCESS_SQUARE}" rx="3" fill="${box.highlight ? colors.primary : colors.ink}"/>`,
		);
		body.push(
			textElement(
				[String(box.index + 1)],
				squareX + PROCESS_SQUARE / 2,
				squareY + 15.5,
				{
					className: "step-number",
					mono: true,
					weight: 500,
					fill: box.highlight ? colors.onPrimary : colors.onInk,
					anchor: "middle",
				},
			),
		);
		let headerBottom = PROCESS_SQUARE;
		if (box.eyebrow.length > 0) {
			body.push(
				textElement(
					box.eyebrow,
					squareX + PROCESS_SQUARE + 8,
					squareY + 15.5,
					{
						className: "eyebrow",
						mono: true,
						weight: 500,
						fill: colors.muted,
					},
				),
			);
			headerBottom = Math.max(
				headerBottom,
				15.5 + (box.eyebrow.length - 1) * LINE_HEIGHT + 4,
			);
		}
		body.push(
			...labelElements(
				box.label,
				squareX,
				squareY + headerBottom + 8 + FONT_SIZE,
				{ title: colors.ink, detail: colors.muted },
			),
		);
	}

	const connector = (d: string) =>
		`<path class="connector" d="${d}" fill="none" stroke="${colors.muted}" stroke-width="1.3" marker-end="url(#${arrowId})"/>`;
	for (const box of boxes.slice(0, -1)) {
		const next = boxes[box.index + 1];
		const rowTop = rowTops[box.row];
		if (next.row === box.row) {
			const midY = rowTop + rowHeights[box.row] / 2;
			body.push(
				connector(
					`M ${num(box.x + boxWidth + 3)} ${num(midY)} H ${num(next.x - 3)}`,
				),
			);
		} else {
			const bottom = rowTop + rowHeights[box.row];
			body.push(
				connector(
					`M ${num(box.x + boxWidth / 2)} ${num(bottom + 2)} V ${num(bottom + PROCESS_ROW_GAP / 2)} H ${num(next.x + boxWidth / 2)} V ${num(rowTops[next.row] - 3)}`,
				),
			);
		}
	}

	let height = gridBottom;
	const descParts = boxes.map(
		(box) => `${box.index + 1}. ${spoken(box.node.lines)}.`,
	);
	if (loop) {
		const from = boxes[loop.from];
		const to = boxes[loop.to];
		const railY = gridBottom + LOOP_DROP;
		const fromX = from.x + boxWidth / 2;
		const toTop = rowTops[to.row];
		let d = `M ${num(fromX)} ${num(gridBottom + 2)} V ${num(railY)}`;
		if (to.row === from.row) {
			d += ` H ${num(to.x + boxWidth / 2)} V ${num(gridBottom + 3)}`;
		} else if (to.column === 0) {
			d += ` H ${LOOP_RAIL_X} V ${num(toTop + rowHeights[to.row] / 2)} H ${num(to.x - 3)}`;
		} else {
			const aboveY =
				to.row === 0
					? toTop - LOOP_TOP_INSET / 2
					: toTop - PROCESS_ROW_GAP / 4;
			d += ` H ${LOOP_RAIL_X} V ${num(aboveY)} H ${num(to.x + boxWidth / 2)} V ${num(toTop - 3)}`;
		}
		body.push(
			`<path class="loop" d="${d}" fill="none" stroke="${colors.primary}" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#${loopArrowId})"/>`,
		);
		height = railY + 6;
		const labelBudget = charBudget(FIGURE_WIDTH - left, INTER_EM);
		let baseline = railY + 18;
		for (const line of loop.label) {
			const wrapped = wrapLine(line, labelBudget);
			body.push(
				textElement(wrapped, left, baseline, {
					className: "loop-label",
					weight: 400,
					fill: colors.primary,
				}),
			);
			baseline += wrapped.length * LINE_HEIGHT;
			height = baseline - LINE_HEIGHT + 6;
		}
		descParts.push(
			`Step ${loop.from + 1} returns to step ${loop.to + 1}${loop.label.length > 0 ? `: ${spoken(loop.label)}` : ""}.`,
		);
	}

	const kind: FigureKind = options.dated ? "timeline" : "process";
	const defs = `<defs>${arrowMarker(arrowId, colors.muted)}${loop ? arrowMarker(loopArrowId, colors.primary) : ""}</defs>`;
	return svgDocument(
		height,
		figureTitle(options, kind),
		`Steps in order: ${descParts.join(" ")}`,
		body,
		defs,
	);
}
