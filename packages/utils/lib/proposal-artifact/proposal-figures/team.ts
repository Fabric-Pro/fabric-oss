/**
 * The team template: the proposer's pod and the client's people side by
 * side, joined by dashed connectors or through one shared box.
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
	type WrappedLabel,
	wrapLabel,
} from "./svg-text";

const TEAM_MAX_ROWS = 10;
const TEAM_COLUMN_WIDTH = 250;
const TEAM_CARD_INSET = 10;
const TEAM_CARD_PAD = 12;
const TEAM_CARD_GAP = 8;
const TEAM_MIN_CARD = 44;
const TEAM_SHARED_INSET = 12;
/** A dark card: the on-ink colour at this opacity over the ink column. */
const DARK_CARD_OPACITY = 0.1;

/**
 * A team: exactly two subgraphs side by side, the first the proposer's pod
 * (a dark column of dark cards) and the second the client's people (a light
 * column). Cards in the same row share a height, so links meet them level.
 * At most one node outside both columns is a shared box (a meeting rhythm,
 * say) in the gutter. With it, the box is the hub: one dashed primary
 * connector joins the pod to it and one joins it to the client. Without it,
 * every edge between the columns is a dashed connector with a vertical lane
 * of its own. Edges inside a column are not drawn; every link between the
 * sides is named in the description.
 *
 * Null for any other number of subgraphs, an empty column, more than one
 * node outside the columns, or more rows than fit.
 */
export function teamFigureSvg(
	model: FigureModel,
	palette: FigurePalette,
	options: FigureOptions = {},
): string | null {
	const colors = checkedPalette(palette);
	checkedIdPrefix(options);
	if (model.subgraphs.length !== 2) {
		return null;
	}
	const [ours, theirs] = model.subgraphs;
	const outside = model.nodes.filter((node) => node.subgraph === null);
	if (
		outside.length > 1 ||
		ours.nodeIds.length === 0 ||
		theirs.nodeIds.length === 0 ||
		ours.nodeIds.length > TEAM_MAX_ROWS ||
		theirs.nodeIds.length > TEAM_MAX_ROWS
	) {
		return null;
	}
	const byId = new Map(model.nodes.map((node) => [node.id, node]));
	const nodesOf = (graph: FigureSubgraph) =>
		graph.nodeIds.flatMap((id) => {
			const node = byId.get(id);
			return node ? [node] : [];
		});
	const leftNodes = nodesOf(ours);
	const rightNodes = nodesOf(theirs);
	const shared = outside[0] ?? null;

	const rightX = FIGURE_WIDTH - TEAM_COLUMN_WIDTH;
	const cardWidth = TEAM_COLUMN_WIDTH - 2 * TEAM_CARD_INSET;
	const cardBudget = charBudget(cardWidth - 2 * TEAM_CARD_PAD, INTER_EM);
	const headingWidth = TEAM_COLUMN_WIDTH - 2 * 14;
	const leftHeading = headingLines(ours.title, headingWidth);
	const rightHeading = headingLines(theirs.title, headingWidth);
	const headingCount = (heading: ReturnType<typeof headingLines>) =>
		heading.heading.length +
		heading.rest.reduce((sum, lines) => sum + lines.length, 0);
	const headerHeight =
		22 +
		(Math.max(headingCount(leftHeading), headingCount(rightHeading)) - 1) *
			LINE_HEIGHT +
		14;

	const leftLabels = leftNodes.map((node) =>
		wrapLabel(node.lines, cardBudget),
	);
	const rightLabels = rightNodes.map((node) =>
		wrapLabel(node.lines, cardBudget),
	);
	const rowCount = Math.max(leftNodes.length, rightNodes.length);
	const rowHeights = Array.from({ length: rowCount }, (_, row) =>
		Math.max(
			TEAM_MIN_CARD,
			...[leftLabels[row], rightLabels[row]]
				.filter((label): label is WrappedLabel => label !== undefined)
				.map(
					(label) =>
						label.lineCount * LINE_HEIGHT + 2 * TEAM_CARD_PAD - 8,
				),
		),
	);
	const rowTops: number[] = [];
	let y = headerHeight;
	for (const height of rowHeights) {
		rowTops.push(y);
		y += height + TEAM_CARD_GAP;
	}
	let columnHeight = y - TEAM_CARD_GAP + TEAM_CARD_INSET;

	const sharedWidth = rightX - TEAM_COLUMN_WIDTH - 2 * TEAM_SHARED_INSET;
	const sharedLabel = shared
		? wrapLabel(shared.lines, charBudget(sharedWidth - 16, INTER_EM))
		: null;
	const sharedHeight = sharedLabel
		? Math.max(40, sharedLabel.lineCount * LINE_HEIGHT + 16)
		: 0;
	const bodyTop = headerHeight;
	if (sharedLabel) {
		columnHeight = Math.max(columnHeight, bodyTop + sharedHeight + 12);
	}
	const sharedTop =
		bodyTop +
		(columnHeight - bodyTop - sharedHeight) / 2 -
		TEAM_CARD_INSET / 2;

	const body: string[] = [
		`<rect class="column" x="0" y="0" width="${TEAM_COLUMN_WIDTH}" height="${num(columnHeight)}" rx="5" fill="${colors.ink}"/>`,
		`<rect class="column" x="${rightX}" y="0" width="${TEAM_COLUMN_WIDTH}" height="${num(columnHeight)}" rx="5" fill="${colors.ink}" fill-opacity="${PANEL_OPACITY}"/>`,
	];
	const heading = (
		lines: ReturnType<typeof headingLines>,
		x: number,
		color: string,
		subtitle: { fill: string; opacity?: number },
	) => {
		let baseline = 22;
		body.push(
			textElement(lines.heading, x, baseline, {
				className: "team-title",
				mono: true,
				weight: 500,
				fill: color,
				tracking: MONO_TRACKING,
			}),
		);
		baseline += lines.heading.length * LINE_HEIGHT;
		for (const rest of lines.rest) {
			body.push(
				textElement(rest, x, baseline, {
					className: "team-subtitle",
					weight: 400,
					fill: subtitle.fill,
					fillOpacity: subtitle.opacity,
				}),
			);
			baseline += rest.length * LINE_HEIGHT;
		}
	};
	heading(leftHeading, 14, colors.onInk, {
		fill: colors.onInk,
		opacity: 0.75,
	});
	heading(rightHeading, rightX + 14, colors.ink, { fill: colors.muted });

	const cards = (
		labels: readonly WrappedLabel[],
		columnX: number,
		dark: boolean,
	) => {
		labels.forEach((label, row) => {
			const x = columnX + TEAM_CARD_INSET;
			const top = rowTops[row];
			body.push(
				dark
					? `<rect class="role" x="${num(x)}" y="${num(top)}" width="${cardWidth}" height="${num(rowHeights[row])}" rx="3" fill="${colors.onInk}" fill-opacity="${DARK_CARD_OPACITY}"/>`
					: `<rect class="role" x="${num(x)}" y="${num(top)}" width="${cardWidth}" height="${num(rowHeights[row])}" rx="3" fill="${colors.surface}" stroke="${colors.border}"/>`,
			);
			const first =
				top +
				(rowHeights[row] - label.lineCount * LINE_HEIGHT) / 2 +
				FONT_SIZE;
			body.push(
				...labelElements(
					label,
					x + TEAM_CARD_PAD,
					first,
					dark
						? {
								title: colors.onInk,
								detail: colors.onInk,
								detailOpacity: 0.75,
							}
						: { title: colors.ink, detail: colors.muted },
				),
			);
		});
	};
	cards(leftLabels, 0, true);
	cards(rightLabels, rightX, false);

	const sharedX = TEAM_COLUMN_WIDTH + TEAM_SHARED_INSET;
	if (shared && sharedLabel) {
		body.push(
			`<rect class="shared" x="${sharedX}" y="${num(sharedTop)}" width="${num(sharedWidth)}" height="${num(sharedHeight)}" rx="3" fill="${colors.surface}" stroke="${colors.primary}"/>`,
			...labelElements(
				sharedLabel,
				FIGURE_WIDTH / 2,
				sharedTop +
					(sharedHeight - sharedLabel.lineCount * LINE_HEIGHT) / 2 +
					FONT_SIZE,
				{ title: colors.ink, detail: colors.muted },
				"middle",
			),
		);
	}

	type Side = "left" | "right" | "shared";
	const sideOf = (id: string): Side | null => {
		if (shared && id === shared.id) {
			return "shared";
		}
		const node = byId.get(id);
		if (node?.subgraph === ours.id) {
			return "left";
		}
		if (node?.subgraph === theirs.id) {
			return "right";
		}
		return null;
	};
	const anchor = (id: string, side: Side): { x: number; y: number } => {
		if (side === "shared") {
			return { x: 0, y: sharedTop + sharedHeight / 2 };
		}
		const row = (side === "left" ? ours : theirs).nodeIds.indexOf(id);
		return {
			x:
				side === "left"
					? TEAM_COLUMN_WIDTH - TEAM_CARD_INSET + 2
					: rightX + TEAM_CARD_INSET - 2,
			y: rowTops[row] + rowHeights[row] / 2,
		};
	};
	// With a shared box the box is the hub: one connector from the pod to it
	// and one from it to the client, so no link crosses it and none merges
	// with another. Without one, each link drawn between the columns turns in
	// a lane of its own, spread across the gutter, so two links never share a
	// vertical run. Either way every link is named in the description.
	const seenLinks = new Set<string>();
	const links: {
		fromId: string;
		toId: string;
		fromSide: Side;
		toSide: Side;
	}[] = [];
	const descLinks: string[] = [];
	for (const edge of model.edges) {
		let fromSide = sideOf(edge.from);
		let toSide = sideOf(edge.to);
		let fromId = edge.from;
		let toId = edge.to;
		if (!fromSide || !toSide || fromSide === toSide) {
			continue;
		}
		// Read left to right: the pod, then the shared box, then the client.
		const order: Record<Side, number> = { left: 0, shared: 1, right: 2 };
		if (order[fromSide] > order[toSide]) {
			[fromSide, toSide] = [toSide, fromSide];
			[fromId, toId] = [toId, fromId];
		}
		const key = `${fromId}\n${toId}`;
		if (seenLinks.has(key)) {
			continue;
		}
		seenLinks.add(key);
		links.push({ fromId, toId, fromSide, toSide });
		const fromNode = byId.get(fromId);
		const toNode = byId.get(toId);
		if (fromNode && toNode) {
			descLinks.push(
				`${fromNode.lines[0] ?? fromNode.id} with ${toNode.lines[0] ?? toNode.id}`,
			);
		}
	}
	const linkPath = (d: string) =>
		`<path class="link" d="${d}" fill="none" stroke="${colors.primary}" stroke-width="1.2" stroke-dasharray="3 3"/>`;
	if (shared && sharedLabel) {
		const hubY = sharedTop + sharedHeight / 2;
		body.push(
			linkPath(
				`M ${num(TEAM_COLUMN_WIDTH + 2)} ${num(hubY)} H ${num(sharedX - 2)}`,
			),
			linkPath(
				`M ${num(sharedX + sharedWidth + 2)} ${num(hubY)} H ${num(rightX - 2)}`,
			),
		);
	} else {
		const gutterLeft = TEAM_COLUMN_WIDTH + TEAM_SHARED_INSET;
		const gutterWidth = rightX - TEAM_SHARED_INSET - gutterLeft;
		const turning = links.filter(({ fromId, toId, fromSide, toSide }) => {
			return (
				Math.abs(anchor(fromId, fromSide).y - anchor(toId, toSide).y) >=
				0.5
			);
		});
		for (const { fromId, toId, fromSide, toSide } of links) {
			const start = anchor(fromId, fromSide);
			const end = anchor(toId, toSide);
			const lane = turning.findIndex(
				(link) => link.fromId === fromId && link.toId === toId,
			);
			const laneX =
				gutterLeft + (gutterWidth * (lane + 1)) / (turning.length + 1);
			body.push(
				linkPath(
					lane === -1
						? `M ${num(start.x)} ${num(start.y)} H ${num(end.x)}`
						: `M ${num(start.x)} ${num(start.y)} H ${num(laneX)} V ${num(end.y)} H ${num(end.x)}`,
				),
			);
		}
	}

	const people = (nodes: readonly FigureNode[]) =>
		nodes.map((node) => spoken(node.lines)).join("; ");
	const descParts = [
		`${spoken(ours.title)}: ${people(leftNodes)}.`,
		`${spoken(theirs.title)}: ${people(rightNodes)}.`,
	];
	if (shared) {
		descParts.push(`Shared: ${spoken(shared.lines)}.`);
	}
	if (descLinks.length > 0) {
		descParts.push(`Working links: ${descLinks.join("; ")}.`);
	}
	return svgDocument(
		columnHeight,
		figureTitle(options, "team"),
		descParts.join(" "),
		body,
	);
}
