/**
 * Pure templating from a visual spec to renderable source (Fizzy #2589,
 * R17, R19, KTD15). Timeline, flow, and org chart specs map to Mermaid
 * source, and so do a Proposal's layers and team specs (Fizzy #2946, in
 * `./visual-figure-templates`, re-exported here); stat and comparison specs
 * map to an SVG card. `existing_mermaid`
 * is not templated here — R19 restyles the document's own Mermaid source
 * as-is rather than regenerating it — and `auto` is a slot placeholder that
 * never reaches this module (see `visual-spec.ts`).
 *
 * Every function here is pure string transformation: no DOM, no Mermaid
 * runtime, no rasterization. Whether the *output* still parses as valid
 * Mermaid through the real engine is exercised by U13's mermaid-in-jsdom
 * test, not here — this module only guarantees the string-level escaping
 * contract documented on `escapeMermaidLabel` (in `./visual-labels`) and
 * `escapeXmlText` below.
 *
 * No Node built-ins: same browser-safety rule as `visual-spec.ts`, since the
 * browser is what actually renders these templates' output.
 */

import { layersToMermaid, teamToMermaid } from "./visual-figure-templates";
import {
	cutLabelAtWord,
	ELLIPSIS,
	escapeMermaidLabel,
	nodeColorLine,
	PROPOSAL_VISUAL_LINE_MAX_CHARS,
	PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
	PROPOSAL_VISUAL_TITLE_MAX_LINES,
	proposalNodeLabel,
	SVG_CARD_FONT_STACK,
	VISUAL_COLOR_PLACEHOLDERS,
	type VisualTemplateOptions,
} from "./visual-labels";
import type {
	ComparisonVisualSpec,
	FlowVisualSpec,
	OrgChartVisualSpec,
	ProposalVisualSpec,
	StatVisualSpec,
	TimelineVisualSpec,
	VisualSpec,
} from "./visual-spec";

export {
	cutLabelAtWord,
	escapeMermaidLabel,
	layersToMermaid,
	PROPOSAL_VISUAL_LINE_MAX_CHARS,
	PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
	PROPOSAL_VISUAL_TITLE_MAX_LINES,
	SVG_CARD_FONT_STACK,
	teamToMermaid,
	VISUAL_COLOR_PLACEHOLDERS,
	type VisualTemplateOptions,
};

// ---------------------------------------------------------------------------
// timeline / flow / org_chart -> Mermaid
// ---------------------------------------------------------------------------

function chainToMermaid<T>(
	direction: "LR" | "TD",
	idPrefix: string,
	items: readonly T[],
	labelOf: (item: T) => string,
	options: VisualTemplateOptions,
): string {
	const lines = [`flowchart ${direction}`];
	let previousId: string | null = null;
	items.forEach((item, index) => {
		const id = `${idPrefix}${index}`;
		lines.push(`${id}["${labelOf(item)}"]`);
		lines.push(nodeColorLine(id, options));
		if (previousId) {
			lines.push(`${previousId} --> ${id}`);
		}
		previousId = id;
	});
	return lines.join("\n");
}

function timelineItemLabel(
	item: TimelineVisualSpec["items"][number],
	options: VisualTemplateOptions,
): string {
	if (options.layout === "proposal") {
		return proposalNodeLabel(
			item.label,
			item.description,
			options.wrapTitle !== false,
			item.date,
		);
	}
	const base = `${item.date} — ${item.label}`;
	return escapeMermaidLabel(
		item.description ? `${base} (${item.description})` : base,
	);
}

/**
 * A chain of rectangle nodes, one per timeline item, in order: left to
 * right, or for a Proposal always top-down.
 */
export function timelineToMermaid(
	spec: TimelineVisualSpec,
	options: VisualTemplateOptions = {},
): string {
	// A Proposal timeline is always drawn top-down: printed at the page column,
	// even four short items left to right fall below a readable label size.
	const direction = options.layout === "proposal" ? "TD" : "LR";
	return chainToMermaid(
		direction,
		"t",
		spec.items,
		(item) => timelineItemLabel(item, options),
		options,
	);
}

function flowStepLabel(
	step: FlowVisualSpec["steps"][number],
	options: VisualTemplateOptions,
): string {
	if (options.layout === "proposal") {
		return proposalNodeLabel(
			step.label,
			step.description,
			options.wrapTitle !== false,
		);
	}
	return escapeMermaidLabel(
		step.description ? `${step.label} (${step.description})` : step.label,
	);
}

function stepLane(step: FlowVisualSpec["steps"][number]): string {
	return step.lane?.trim() ?? "";
}

/**
 * The flow's distinct lanes in first-appearance order, or `null` when it
 * draws as a plain chain: swimlanes need every step to name its lane, and at
 * least two lanes, since a single lane around every step says nothing.
 */
function flowLanes(steps: FlowVisualSpec["steps"]): string[] | null {
	const lanes = steps.map(stepLane);
	if (lanes.includes("")) {
		return null;
	}
	const distinct = Array.from(new Set(lanes));
	return distinct.length >= 2 ? distinct : null;
}

/**
 * A top-to-bottom chain of rectangle nodes, one per flow step, in order.
 * When `flowLanes` finds swimlanes, each lane becomes a subgraph holding its
 * steps and the edges still run step to step in order; otherwise the output
 * is exactly the plain chain. Subgraph ids are our own generated
 * `lane<index>` tokens, never text from the spec, and a lane's title is
 * escaped and quoted exactly as a node label is.
 */
export function flowToMermaid(
	spec: FlowVisualSpec,
	options: VisualTemplateOptions = {},
): string {
	const lanes = flowLanes(spec.steps);
	if (!lanes) {
		return chainToMermaid(
			"TD",
			"f",
			spec.steps,
			(step) => flowStepLabel(step, options),
			options,
		);
	}
	const lines = ["flowchart TD"];
	// Every node is declared inside its lane before any edge names it: Mermaid
	// places a node in the graph where it first appears.
	lanes.forEach((lane, laneIndex) => {
		lines.push(`subgraph lane${laneIndex}["${escapeMermaidLabel(lane)}"]`);
		spec.steps.forEach((step, index) => {
			if (stepLane(step) === lane) {
				lines.push(`f${index}["${flowStepLabel(step, options)}"]`);
			}
		});
		lines.push("end");
	});
	spec.steps.forEach((_, index) => {
		lines.push(nodeColorLine(`f${index}`, options));
		if (index > 0) {
			lines.push(`f${index - 1} --> f${index}`);
		}
	});
	return lines.join("\n");
}

/**
 * A top-down tree from the org chart's nodes. Mermaid node ids are always
 * our own generated `o<index>` tokens, never a spec-provided `id` — a
 * model-provided id is free text (bounded, but not restricted to Mermaid's
 * identifier charset) and does not belong in the syntax position, only in
 * an escaped label. `visual-spec.ts`'s `validateOrgChartTree` already
 * guarantees every `parentId` resolves to a real node and the tree has no
 * cycle, so the lookups below cannot miss for a spec that passed
 * `visualSpecSchema`.
 */
export function orgChartToMermaid(
	spec: OrgChartVisualSpec,
	options: VisualTemplateOptions = {},
): string {
	const idByNodeId = new Map(
		spec.nodes.map((node, index) => [node.id, `o${index}`]),
	);
	const lines = ["flowchart TD"];
	for (const node of spec.nodes) {
		const id = idByNodeId.get(node.id);
		if (!id) {
			continue;
		}
		lines.push(`${id}["${escapeMermaidLabel(node.label)}"]`);
		lines.push(nodeColorLine(id, options));
	}
	for (const node of spec.nodes) {
		if (node.parentId === null) {
			continue;
		}
		const parentMermaidId = idByNodeId.get(node.parentId);
		const childMermaidId = idByNodeId.get(node.id);
		if (parentMermaidId && childMermaidId) {
			lines.push(`${parentMermaidId} --> ${childMermaidId}`);
		}
	}
	return lines.join("\n");
}

/**
 * The figure template a Proposal fence of `spec` asks for, written as its
 * `%% figure:` line (`proposal-artifact/proposal-figures/`) by the
 * callers that assemble a Proposal fence: a flow without lanes draws as a
 * numbered process, a timeline as a dated one, layers and a team as their
 * own figures. A flow with lanes and an org chart stay Mermaid (null). The
 * templating itself never writes the line, so its output, Glossy's
 * included, is unchanged.
 */
export function proposalFigureKind(
	spec: ProposalVisualSpec,
): "process" | "timeline" | "layers" | "team" | null {
	switch (spec.kind) {
		case "timeline":
			return "timeline";
		case "flow":
			return flowLanes(spec.steps) ? null : "process";
		case "layers":
			return "layers";
		case "team":
			return "team";
		default:
			return null;
	}
}

/**
 * The template options a Proposal fence of `spec` is written with: a fence
 * that asks for a figure template (`proposalFigureKind`) gets each title as
 * one label line, since the template wraps it to its own width; a fence that
 * stays Mermaid keeps the wrapped title.
 */
export function proposalVisualTemplateOptions(
	spec: ProposalVisualSpec,
): VisualTemplateOptions {
	return {
		...PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
		wrapTitle: proposalFigureKind(spec) === null,
	};
}

/** Dispatch a spec to the matching Mermaid template. Throws for a kind this module does not template (`stat`, `comparison`, `existing_mermaid`, `auto`). */
export function visualSpecToMermaid(
	spec: ProposalVisualSpec,
	options: VisualTemplateOptions = {},
): string {
	switch (spec.kind) {
		case "timeline":
			return timelineToMermaid(spec, options);
		case "flow":
			return flowToMermaid(spec, options);
		case "org_chart":
			return orgChartToMermaid(spec, options);
		case "layers":
			return layersToMermaid(spec, options);
		case "team":
			return teamToMermaid(spec, options);
		default:
			throw new Error(
				`visualSpecToMermaid does not template the "${spec.kind}" kind (timeline, flow, org_chart, layers, and team only).`,
			);
	}
}

// ---------------------------------------------------------------------------
// stat / comparison -> SVG card
// ---------------------------------------------------------------------------

/** XML/text-node escaping for SVG `<text>` content and attribute values. */
export function escapeXmlText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Conservative average glyph advance, as a fraction of the font size. SVG
 * `<text>` never wraps and this module cannot measure text (it stays pure),
 * so wrapping budgets every character at this width, which is wider than
 * the font stack's average; a line that fits the estimate fits its box.
 */
const GLYPH_WIDTH_EM = 0.6;

/** Baseline-to-baseline distance of wrapped lines, as a multiple of the font size. */
const LINE_HEIGHT_EM = 1.3;

/** How one text element wraps: its font size, and the lines it may use. */
interface WrapStyle {
	fontSize: number;
	maxLines: number;
}

function lineHeight(style: WrapStyle): number {
	return Math.round(style.fontSize * LINE_HEIGHT_EM);
}

/**
 * Greedy word wrap of `text` into lines that fit `width` at the estimated
 * glyph width. Text that already fits is returned as-is, so a short label
 * renders exactly as a single line; otherwise whitespace runs collapse (SVG
 * collapses them anyway), a word longer than a line is broken, and text past
 * `maxLines` is cut, the last line ending in an ellipsis. Counts code
 * points, so a surrogate pair is never split. Wraps raw text: escape each
 * line afterwards, so an entity is neither counted as several characters
 * nor broken across lines.
 */
function wrapText(text: string, width: number, style: WrapStyle): string[] {
	const maxChars = Math.max(
		1,
		Math.floor(width / (style.fontSize * GLYPH_WIDTH_EM)),
	);
	if (Array.from(text).length <= maxChars) {
		return [text];
	}

	const lines: string[] = [];
	let line: string[] = [];
	for (const word of text.trim().split(/\s+/)) {
		let chars = Array.from(word);
		if (line.length > 0 && line.length + 1 + chars.length > maxChars) {
			lines.push(line.join(""));
			line = [];
		}
		if (line.length > 0) {
			line.push(" ");
		}
		// Only reached with an empty line: a word that fit after a space
		// is shorter than a whole line.
		while (chars.length > maxChars) {
			lines.push(chars.slice(0, maxChars).join(""));
			chars = chars.slice(maxChars);
		}
		line.push(...chars);
	}
	// Whitespace-only text still yields one (empty) line.
	if (line.length > 0 || lines.length === 0) {
		lines.push(line.join(""));
	}

	if (lines.length <= style.maxLines) {
		return lines;
	}
	const kept = lines.slice(0, style.maxLines);
	const last = Array.from(kept[kept.length - 1]).slice(0, maxChars - 1);
	kept[kept.length - 1] = `${last.join("").trimEnd()}${ELLIPSIS}`;
	return kept;
}

/**
 * A `<text>` element's escaped content: a single line as-is, or one
 * `<tspan>` per line, each after the first back at `x` and one line lower.
 */
function svgTextContent(
	lines: readonly string[],
	x: number,
	style: WrapStyle,
): string {
	if (lines.length === 1) {
		return escapeXmlText(lines[0]);
	}
	const dy = lineHeight(style);
	return lines
		.map((line, index) =>
			index === 0
				? `<tspan>${escapeXmlText(line)}</tspan>`
				: `<tspan x="${x}" dy="${dy}">${escapeXmlText(line)}</tspan>`,
		)
		.join("");
}

/** The extra height `lines` take beyond a single line. */
function extraLinesHeight(lines: readonly string[], style: WrapStyle): number {
	return (lines.length - 1) * lineHeight(style);
}

const STAT_CARD_WIDTH = 320;
const STAT_ROW_HEIGHT = 84;
const STAT_TITLE_HEIGHT = 40;
const STAT_PADDING_TOP = 16;
const STAT_TEXT_X = 20;
const STAT_TEXT_WIDTH = STAT_CARD_WIDTH - 2 * STAT_TEXT_X;
const STAT_TITLE_STYLE: WrapStyle = { fontSize: 14, maxLines: 3 };
const STAT_VALUE_STYLE: WrapStyle = { fontSize: 32, maxLines: 2 };
const STAT_LABEL_STYLE: WrapStyle = { fontSize: 13, maxLines: 5 };

/**
 * A rounded card listing each stat's value and label, stacked vertically.
 * Each text wraps to the card's inner width, and a row grows by the extra
 * lines its value and label take.
 */
export function statToSvgCard(spec: StatVisualSpec): string {
	const title = spec.title
		? wrapText(spec.title, STAT_TEXT_WIDTH, STAT_TITLE_STYLE)
		: null;
	const rows = spec.items.map((item) => {
		const value = wrapText(item.value, STAT_TEXT_WIDTH, STAT_VALUE_STYLE);
		const label = wrapText(item.label, STAT_TEXT_WIDTH, STAT_LABEL_STYLE);
		const valueExtra = extraLinesHeight(value, STAT_VALUE_STYLE);
		return {
			value,
			label,
			valueExtra,
			height:
				STAT_ROW_HEIGHT +
				valueExtra +
				extraLinesHeight(label, STAT_LABEL_STYLE),
		};
	});
	const titleHeight = title
		? STAT_TITLE_HEIGHT + extraLinesHeight(title, STAT_TITLE_STYLE)
		: STAT_PADDING_TOP;
	const height = rows.reduce((sum, row) => sum + row.height, titleHeight);

	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STAT_CARD_WIDTH} ${height}" width="${STAT_CARD_WIDTH}" height="${height}" role="img">`,
		`<rect x="0" y="0" width="${STAT_CARD_WIDTH}" height="${height}" rx="12" fill="${VISUAL_COLOR_PLACEHOLDERS.surface}" stroke="${VISUAL_COLOR_PLACEHOLDERS.border}"/>`,
	];

	let y = STAT_PADDING_TOP;
	if (title) {
		parts.push(
			`<text x="${STAT_TEXT_X}" y="${y + 16}" font-family="${SVG_CARD_FONT_STACK}" font-size="${STAT_TITLE_STYLE.fontSize}" font-weight="600" fill="${VISUAL_COLOR_PLACEHOLDERS.muted}">${svgTextContent(title, STAT_TEXT_X, STAT_TITLE_STYLE)}</text>`,
		);
		y += titleHeight;
	}
	for (const row of rows) {
		parts.push(
			`<text x="${STAT_TEXT_X}" y="${y + 34}" font-family="${SVG_CARD_FONT_STACK}" font-size="${STAT_VALUE_STYLE.fontSize}" font-weight="700" fill="${VISUAL_COLOR_PLACEHOLDERS.primary}">${svgTextContent(row.value, STAT_TEXT_X, STAT_VALUE_STYLE)}</text>`,
		);
		parts.push(
			`<text x="${STAT_TEXT_X}" y="${y + 58 + row.valueExtra}" font-family="${SVG_CARD_FONT_STACK}" font-size="${STAT_LABEL_STYLE.fontSize}" fill="${VISUAL_COLOR_PLACEHOLDERS.ink}">${svgTextContent(row.label, STAT_TEXT_X, STAT_LABEL_STYLE)}</text>`,
		);
		y += row.height;
	}
	parts.push("</svg>");
	return parts.join("");
}

const COMPARISON_COLUMN_WIDTH = 240;
const COMPARISON_COLUMN_GAP = 20;
const COMPARISON_MARGIN = 20;
const COMPARISON_HEADER_HEIGHT = 44;
const COMPARISON_POINT_HEIGHT = 22;
const COMPARISON_TOP_PADDING = 20;
const COMPARISON_BOTTOM_PADDING = 20;
const COMPARISON_TEXT_INSET = 16;
const COMPARISON_TEXT_WIDTH =
	COMPARISON_COLUMN_WIDTH - 2 * COMPARISON_TEXT_INSET;
/** Room for a point's `• ` prefix; a point's later lines start this far in, under its text. */
const COMPARISON_BULLET_HANG = 8;
const COMPARISON_TITLE_STYLE: WrapStyle = { fontSize: 16, maxLines: 3 };
const COMPARISON_POINT_STYLE: WrapStyle = { fontSize: 12, maxLines: 6 };

/**
 * A row of cards, one per comparison item, each with a title and bulleted
 * points. Titles and points wrap to the column's inner width. Every column
 * shares the tallest title's header band, so points start level across the
 * row, and every column is as tall as the tallest one.
 */
export function comparisonToSvgCard(spec: ComparisonVisualSpec): string {
	const columnCount = spec.items.length;
	const width =
		COMPARISON_MARGIN * 2 +
		columnCount * COMPARISON_COLUMN_WIDTH +
		(columnCount - 1) * COMPARISON_COLUMN_GAP;
	const columns = spec.items.map((item) => ({
		title: wrapText(
			item.title,
			COMPARISON_TEXT_WIDTH,
			COMPARISON_TITLE_STYLE,
		),
		points: item.points.map((point) =>
			wrapText(
				point,
				COMPARISON_TEXT_WIDTH - COMPARISON_BULLET_HANG,
				COMPARISON_POINT_STYLE,
			),
		),
	}));
	const pointHeight = (lines: readonly string[]) =>
		COMPARISON_POINT_HEIGHT +
		extraLinesHeight(lines, COMPARISON_POINT_STYLE);
	const headerHeight = Math.max(
		...columns.map(
			(column) =>
				COMPARISON_HEADER_HEIGHT +
				extraLinesHeight(column.title, COMPARISON_TITLE_STYLE),
		),
	);
	const columnHeight =
		headerHeight +
		Math.max(
			...columns.map((column) =>
				column.points.reduce(
					(sum, lines) => sum + pointHeight(lines),
					0,
				),
			),
		);
	const height =
		COMPARISON_TOP_PADDING + columnHeight + COMPARISON_BOTTOM_PADDING;

	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
	];

	columns.forEach((column, index) => {
		const x =
			COMPARISON_MARGIN +
			index * (COMPARISON_COLUMN_WIDTH + COMPARISON_COLUMN_GAP);
		const textX = x + COMPARISON_TEXT_INSET;
		parts.push(
			`<rect x="${x}" y="${COMPARISON_TOP_PADDING}" width="${COMPARISON_COLUMN_WIDTH}" height="${columnHeight}" rx="10" fill="${VISUAL_COLOR_PLACEHOLDERS.surface}" stroke="${VISUAL_COLOR_PLACEHOLDERS.border}"/>`,
		);
		parts.push(
			`<text x="${textX}" y="${COMPARISON_TOP_PADDING + 28}" font-family="${SVG_CARD_FONT_STACK}" font-size="${COMPARISON_TITLE_STYLE.fontSize}" font-weight="700" fill="${VISUAL_COLOR_PLACEHOLDERS.ink}">${svgTextContent(column.title, textX, COMPARISON_TITLE_STYLE)}</text>`,
		);
		let pointTop = COMPARISON_TOP_PADDING + headerHeight;
		for (const lines of column.points) {
			const [first, ...rest] = lines;
			parts.push(
				`<text x="${textX}" y="${pointTop + 14}" font-family="${SVG_CARD_FONT_STACK}" font-size="${COMPARISON_POINT_STYLE.fontSize}" fill="${VISUAL_COLOR_PLACEHOLDERS.muted}">${svgTextContent([`• ${first}`, ...rest], textX + COMPARISON_BULLET_HANG, COMPARISON_POINT_STYLE)}</text>`,
			);
			pointTop += pointHeight(lines);
		}
	});

	parts.push("</svg>");
	return parts.join("");
}

/** Dispatch a spec to the matching SVG card template. Throws for a kind this module does not template (`timeline`, `flow`, `org_chart`, `existing_mermaid`, `auto`). */
export function visualSpecToSvgCard(spec: VisualSpec): string {
	switch (spec.kind) {
		case "stat":
			return statToSvgCard(spec);
		case "comparison":
			return comparisonToSvgCard(spec);
		default:
			throw new Error(
				`visualSpecToSvgCard does not template the "${spec.kind}" kind (stat and comparison only).`,
			);
	}
}
