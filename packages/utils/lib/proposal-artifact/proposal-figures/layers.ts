/**
 * The architecture layers template: one row per subgraph, with an optional
 * cross-cutting column on the right.
 *
 * Pure functions and data only: client components import this module.
 */

import type { FigureModel, FigureNode, FigureSubgraph } from "./parse";
import {
	charBudget,
	checkedIdPrefix,
	checkedPalette,
	FIGURE_WIDTH,
	type FigureOptions,
	type FigurePalette,
	FONT_SIZE,
	figureTitle,
	headingLines,
	INTER_EM,
	LINE_HEIGHT,
	labelElements,
	MONO_TRACKING,
	num,
	PANEL_OPACITY,
	spoken,
	svgDocument,
	textElement,
	wrapLabel,
	wrapLine,
} from "./svg-text";

/** The subgraph id that becomes the right-hand column. */
const CROSSCUTTING_ID = "crosscutting";
const LAYERS_MAX_ROWS = 8;
const LAYERS_MAX_BOXES = 5;
const LAYERS_LABEL_WIDTH = 120;
const LAYERS_SIDE_WIDTH = 140;
const LAYERS_GAP_X = 8;
const LAYERS_ROW_GAP = 8;
const LAYERS_BOX_GAP = 6;
const LAYERS_MIN_ROW = 58;
const LAYERS_PAD = 10;
const LAYERS_BOX_INSET = 8;
/** A layer box's side padding: narrower than elsewhere, as boxes sit five across. */
const LAYERS_BOX_PAD = 6;
/** The least room a layer box is given, in characters. */
const LAYERS_MIN_BOX_CHARS = 8;

/**
 * The widths of a row's boxes, sharing `available` in proportion to each
 * label's longest word (and at least `LAYERS_MIN_BOX_CHARS`), so a long
 * word such as "Notifications" gets the room it needs and is not broken
 * while a short neighbour gives some up.
 */
function layerBoxWidths(
	nodes: readonly FigureNode[],
	available: number,
): number[] {
	const weights = nodes.map(
		(node) =>
			Math.max(
				LAYERS_MIN_BOX_CHARS,
				...node.lines.flatMap((line) =>
					line.split(/\s+/).map((word) => Array.from(word).length),
				),
			) + 2,
	);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	return weights.map((weight) => (available * weight) / total);
}

/**
 * Architecture layers: one row per subgraph in source order, its title in a
 * light label panel on the left (the first title line in mono capitals, the
 * rest as a subtitle) and its nodes as boxes spread across the rest of the
 * row. A subgraph with the id `crosscutting` becomes a dark column on the
 * right listing its nodes. A `highlight` class gives a box the tint fill and
 * a primary outline. Edges are not drawn.
 *
 * Null when a node sits outside every subgraph, a layer is empty, there is
 * no layer besides the cross-cutting column, or a row or the figure holds
 * more than it can draw legibly.
 */
export function layersFigureSvg(
	model: FigureModel,
	palette: FigurePalette,
	options: FigureOptions = {},
): string | null {
	const colors = checkedPalette(palette);
	checkedIdPrefix(options);
	const isSide = (graph: FigureSubgraph) =>
		graph.id.toLowerCase() === CROSSCUTTING_ID;
	const layers = model.subgraphs.filter((graph) => !isSide(graph));
	const side = model.subgraphs.find(isSide) ?? null;
	if (
		layers.length === 0 ||
		layers.length > LAYERS_MAX_ROWS ||
		model.subgraphs.filter(isSide).length > 1 ||
		model.nodes.some((node) => node.subgraph === null) ||
		layers.some(
			(graph) =>
				graph.nodeIds.length === 0 ||
				graph.nodeIds.length > LAYERS_MAX_BOXES,
		)
	) {
		return null;
	}
	const byId = new Map(model.nodes.map((node) => [node.id, node]));
	const nodesOf = (graph: FigureSubgraph) =>
		graph.nodeIds.flatMap((id) => {
			const node = byId.get(id);
			return node ? [node] : [];
		});

	const boxesLeft = LAYERS_LABEL_WIDTH + LAYERS_GAP_X;
	const boxesRight = side
		? FIGURE_WIDTH - LAYERS_SIDE_WIDTH - LAYERS_GAP_X
		: FIGURE_WIDTH;
	const labelWidth = LAYERS_LABEL_WIDTH - 2 * LAYERS_PAD;

	const rows = layers.map((graph) => {
		const nodes = nodesOf(graph);
		const boxWidths = layerBoxWidths(
			nodes,
			boxesRight - boxesLeft - (nodes.length - 1) * LAYERS_BOX_GAP,
		);
		const labels = nodes.map((node, index) =>
			wrapLabel(
				node.lines,
				charBudget(boxWidths[index] - 2 * LAYERS_BOX_PAD, INTER_EM),
			),
		);
		const heading = headingLines(graph.title, labelWidth);
		const headingCount =
			heading.heading.length +
			heading.rest.reduce((sum, lines) => sum + lines.length, 0);
		const panelHeight = 22 + (headingCount - 1) * LINE_HEIGHT + 14;
		const tallest = Math.max(...labels.map((label) => label.lineCount));
		const boxHeight = Math.max(42, tallest * LINE_HEIGHT + 20);
		return {
			graph,
			nodes,
			boxWidths,
			labels,
			heading,
			height: Math.max(
				LAYERS_MIN_ROW,
				panelHeight,
				boxHeight + 2 * LAYERS_BOX_INSET,
			),
		};
	});

	const body: string[] = [];
	let y = 0;
	for (const row of rows) {
		body.push(
			`<rect class="layer" x="0" y="${num(y)}" width="${LAYERS_LABEL_WIDTH}" height="${num(row.height)}" rx="4" fill="${colors.ink}" fill-opacity="${PANEL_OPACITY}"/>`,
		);
		let baseline = y + 22;
		body.push(
			textElement(row.heading.heading, LAYERS_PAD, baseline, {
				className: "layer-title",
				mono: true,
				weight: 500,
				fill: colors.ink,
				tracking: MONO_TRACKING,
			}),
		);
		baseline += row.heading.heading.length * LINE_HEIGHT;
		for (const lines of row.heading.rest) {
			body.push(
				textElement(lines, LAYERS_PAD, baseline, {
					className: "layer-subtitle",
					weight: 400,
					fill: colors.muted,
				}),
			);
			baseline += lines.length * LINE_HEIGHT;
		}
		const boxTop = y + LAYERS_BOX_INSET;
		const boxHeight = row.height - 2 * LAYERS_BOX_INSET;
		let x = boxesLeft;
		row.nodes.forEach((node, index) => {
			const boxWidth = row.boxWidths[index];
			const highlight = node.classes.includes("highlight");
			body.push(
				`<rect class="box" x="${num(x)}" y="${num(boxTop)}" width="${num(boxWidth)}" height="${num(boxHeight)}" rx="3" fill="${highlight ? colors.tint : colors.surface}" stroke="${highlight ? colors.primary : colors.border}"/>`,
			);
			const label = row.labels[index];
			const first =
				boxTop +
				(boxHeight - label.lineCount * LINE_HEIGHT) / 2 +
				FONT_SIZE;
			body.push(
				...labelElements(
					label,
					x + boxWidth / 2,
					first,
					{ title: colors.ink, detail: colors.muted },
					"middle",
				),
			);
			x += boxWidth + LAYERS_BOX_GAP;
		});
		y += row.height + LAYERS_ROW_GAP;
	}
	let height = y - LAYERS_ROW_GAP;

	const descParts = rows.map(
		(row) =>
			`${spoken(row.graph.title)}: ${row.nodes.map((node) => spoken(node.lines)).join("; ")}.`,
	);
	if (side) {
		const x = FIGURE_WIDTH - LAYERS_SIDE_WIDTH;
		const width = LAYERS_SIDE_WIDTH - 2 * LAYERS_PAD;
		const heading = headingLines(side.title, width);
		const parts: string[] = [];
		let baseline = 22;
		parts.push(
			textElement(heading.heading, x + LAYERS_PAD, baseline, {
				className: "side-title",
				mono: true,
				weight: 500,
				fill: colors.onInk,
				tracking: MONO_TRACKING,
			}),
		);
		baseline += heading.heading.length * LINE_HEIGHT;
		for (const lines of heading.rest) {
			parts.push(
				textElement(lines, x + LAYERS_PAD, baseline, {
					className: "side-subtitle",
					weight: 400,
					fill: colors.onInk,
					fillOpacity: 0.75,
				}),
			);
			baseline += lines.length * LINE_HEIGHT;
		}
		baseline += 12;
		const budget = charBudget(width, INTER_EM);
		const items = nodesOf(side);
		for (const node of items) {
			for (const line of node.lines) {
				const wrapped = wrapLine(line, budget);
				parts.push(
					textElement(wrapped, x + LAYERS_PAD, baseline, {
						className: "side-item",
						weight: 400,
						fill: colors.onInk,
					}),
				);
				baseline += wrapped.length * LINE_HEIGHT;
			}
			baseline += 8;
		}
		height = Math.max(height, baseline - LINE_HEIGHT - 8 + 14);
		body.push(
			`<rect class="crosscutting" x="${x}" y="0" width="${LAYERS_SIDE_WIDTH}" height="${num(height)}" rx="4" fill="${colors.ink}"/>`,
			...parts,
		);
		descParts.push(
			`Across every layer, ${spoken(side.title)}: ${items.map((node) => spoken(node.lines)).join("; ")}.`,
		);
	}

	return svgDocument(
		height,
		figureTitle(options, "layers"),
		`Layers from top to bottom. ${descParts.join(" ")}`,
		body,
	);
}
