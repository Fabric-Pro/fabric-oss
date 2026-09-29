/**
 * Pure templating from a visual spec to renderable source (Fizzy #2589,
 * R17, R19, KTD15). Timeline, flow, and org chart specs map to Mermaid
 * source; stat and comparison specs map to an SVG card. `existing_mermaid`
 * is not templated here — R19 restyles the document's own Mermaid source
 * as-is rather than regenerating it — and `auto` is a slot placeholder that
 * never reaches this module (see `visual-spec.ts`).
 *
 * Every function here is pure string transformation: no DOM, no Mermaid
 * runtime, no rasterization. Whether the *output* still parses as valid
 * Mermaid through the real engine is exercised by U13's mermaid-in-jsdom
 * test, not here — this module only guarantees the string-level escaping
 * contract documented on `escapeMermaidLabel` and `escapeXmlText` below.
 *
 * No Node built-ins: same browser-safety rule as `visual-spec.ts`, since the
 * browser is what actually renders these templates' output.
 */

import type {
	ComparisonVisualSpec,
	FlowVisualSpec,
	OrgChartVisualSpec,
	StatVisualSpec,
	TimelineVisualSpec,
	VisualSpec,
} from "./visual-spec";

// ---------------------------------------------------------------------------
// Shared: color placeholders and fonts
// ---------------------------------------------------------------------------

/**
 * Named color placeholders emitted into Mermaid `style` directives and SVG
 * `fill`/`stroke` attributes instead of literal hex values (KTD15: "colors
 * are placeholders that the browser fills with validated palette values").
 * This module has no dependency on `brand-colors.ts` or on an organization's
 * resolved palette — it only knows the token names. The browser substitutes
 * each token for a validated `#rrggbb` value before rendering, so a spec's
 * template output is stable across organizations and never embeds an
 * unvalidated color string. Plain identifier tokens (no `#`, spaces, commas,
 * or colons) so they are safe unescaped inside both an SVG attribute value
 * and a Mermaid `style ... fill:X,stroke:Y` list.
 */
export const VISUAL_COLOR_PLACEHOLDERS = {
	surface: "GLOSSY_COLOR_SURFACE",
	border: "GLOSSY_COLOR_BORDER",
	primary: "GLOSSY_COLOR_PRIMARY",
	ink: "GLOSSY_COLOR_INK",
	muted: "GLOSSY_COLOR_MUTED",
} as const;

/** One fixed system font stack for every SVG card, so text metrics are
 * predictable across organizations and platforms (KTD15). */
export const SVG_CARD_FONT_STACK =
	"system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ---------------------------------------------------------------------------
// Mermaid label escaping
// ---------------------------------------------------------------------------

/**
 * U+200B, built via `fromCharCode` rather than typed as a literal character
 * so the source file contains no actual invisible code point — an invisible
 * character sitting directly in source is easy for an editor or a future
 * diff to lose track of.
 */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Sequences Mermaid acts on anywhere in a line or in the whole source, quoted
 * or not. Each pattern matches the part that gets a U+200B inserted after it
 * (a lookahead holds the rest), so the text still displays as typed but no
 * longer matches:
 * - `%%`: a `%%{init: ...}%%` directive is applied as configuration and cut
 *   out of the text wherever it appears, and one whose JSON does not parse
 *   discards every directive, the brand theme's included.
 * - `#` before `word;`: `#40;` and `#lt;` are Mermaid's entity codes.
 * - `<` before a tag name, `/`, `!`, or `?`: Mermaid rewrites `="..."` to
 *   `='...'` between a `<tag` and the next `>`, across lines, which can turn
 *   one label's closing quote and the next label's opening quote into `'`;
 *   the label sanitizer would also parse and rewrite the tag.
 * - `direction` before whitespace and `TB`, `BT`, `RL`, `LR`, or `TD`: the
 *   flowchart lexer's direction rules start with `.*`, so they match from
 *   the lexer's position to the end of the line, label included, and turn a
 *   node or subgraph line into a direction statement ("Strategic direction
 *   TBD"). Their `\s` is JavaScript's, so it also takes a tab or a
 *   non-breaking space. The flowchart lexer's rules are case-sensitive; the
 *   break ignores case anyway, as the same rules do in Mermaid's state, ER,
 *   and requirement lexers, and an extra break costs one invisible character.
 * - `C4` before `Container`, `Component`, `Dynamic`, or `Deployment`:
 *   Mermaid's C4 diagram detector matches those words anywhere in the source
 *   (only its `C4Context` alternative is anchored to the start) and runs
 *   before the flowchart one, so the whole visual would be parsed as a C4
 *   diagram and fail to render.
 * - `ﬂ°` and `¶ß` (U+FB02 U+00B0, U+00B6 U+00DF): Mermaid's internal form of
 *   an entity code. It turns every one in the finished SVG back into `&` or
 *   `;`, so a label holding them would draw a decoded entity (`ﬂ°lt¶ß` as
 *   `<`) or put a bare `&` into the SVG markup.
 */
const ZERO_WIDTH_BREAKS: readonly RegExp[] = [
	/%(?=%)/g,
	/#(?=\w+;)/g,
	/<(?=[\w/!?])/g,
	/direction(?=\s+(?:TB|BT|RL|LR|TD))/gi,
	/C4(?=Container|Component|Dynamic|Deployment)/g,
	/\uFB02(?=\u00B0)/g,
	/\u00B6(?=\u00DF)/g,
];

/**
 * A label that, unescaped, would read as Mermaid's own `click`/`style` line
 * directive, or, starting with a backtick right after the opening quote,
 * would open a Markdown string.
 */
const LEADING_KEYWORD_OR_BACKTICK = /^(?:(?:click|style)\b|`)/i;

/**
 * Straight double quotes as typographic ones, opening and closing in turn
 * so a quoted phrase reads naturally; an unpaired last quote closes.
 */
function typographicQuotes(text: string): string {
	const total = text.split('"').length - 1;
	let seen = 0;
	return text.replace(/"/g, () => {
		seen += 1;
		return seen % 2 === 1 && seen < total ? "“" : "”";
	});
}

/**
 * Escape a text label for interpolation into generated Mermaid source.
 *
 * Every template below writes a label inside double quotes (`id["label"]`,
 * `subgraph laneN["title"]`), and once the flowchart lexer reaches the
 * opening `"` its string state is exclusive: up to the next `"` it reads
 * everything as text. Quoting alone does not make a label inert, though:
 * before that quote the lexer is in its initial state, and it tries each of
 * that state's rules against the rest of the line, label included. Almost
 * all of them (`click`, `style`, `classDef`, `class`, `linkStyle`,
 * `interpolate`, `subgraph`, `end`, `accTitle`, `accDescr`, `href`, `call`,
 * `default`) match only at the lexer's position, which is never inside a
 * label, so brackets, parentheses, braces, `%`, `end`, and `click` inside
 * the quotes stay literal and as typed. The exceptions are the direction
 * rules, which start with `.*` (see `ZERO_WIDTH_BREAKS`). What can still
 * escape a label:
 * - a `"`, which would close the string early: replaced by typographic
 *   quotes (“ ”);
 * - a line break: folded to a space, because comment stripping runs line by
 *   line before the lexer, whatever the quoting;
 * - the sequences in `ZERO_WIDTH_BREAKS`, matched over a whole line or the
 *   whole source before the lexer reaches the label's quotes;
 * - a leading backtick, which would open a Markdown string: Markdown drops a
 *   link's text and rewrites formatting, and an unterminated one swallows
 *   the rest of the diagram.
 * A leading backtick and a leading `click`/`style` keyword (defense in depth
 * for a template that puts a label first on a line) are both prefixed with
 * U+200B rather than an ordinary space: a lexer commonly skips leading ASCII
 * whitespace, which would undo a plain-space prefix, but U+200B is outside
 * the `\s`/`trim()` class.
 *
 * One escape is for display only: Mermaid's SVG-text labels drop a `>` that
 * is not part of a `<…>` pair ("A -> B" would draw as "A - B"), so `>` is
 * written as `&gt;`, which they decode. A `<` needs no help: it sends the
 * label through the sanitizer, which escapes it.
 *
 * Fizzy #2589 follow-up: labels used to swap every syntax character for a
 * full-width look-alike, which the diagrams drew with wide built-in padding
 * ("leadership （Lead）", "85–90％"). Mermaid's own `#40;` entity codes are no
 * replacement: with SVG-text labels they reach the drawing undecoded.
 * Residual, display only: Mermaid drops the last `;` of a line matching
 * `style…:…#…;` or `classDef…:…#…;`, so a label of that shape loses a `;`,
 * or shows a `>` as `&gt`.
 */
export function escapeMermaidLabel(text: string): string {
	let escaped = typographicQuotes(text.replace(/\r\n|\r|\n/g, " ")).replace(
		/>/g,
		"&gt;",
	);
	for (const pattern of ZERO_WIDTH_BREAKS) {
		escaped = escaped.replace(pattern, `$&${ZERO_WIDTH_SPACE}`);
	}
	if (LEADING_KEYWORD_OR_BACKTICK.test(escaped.trim())) {
		escaped = `${ZERO_WIDTH_SPACE}${escaped}`;
	}
	return escaped;
}

// ---------------------------------------------------------------------------
// timeline / flow / org_chart -> Mermaid
// ---------------------------------------------------------------------------

/**
 * A chain of rectangle nodes, one per item, in order, each linked to the
 * next. Node ids are `<idPrefix><index>`, never text from the spec.
 */
function chainToMermaid<T>(
	direction: "LR" | "TD",
	idPrefix: string,
	items: readonly T[],
	labelOf: (item: T) => string,
): string {
	const lines = [`flowchart ${direction}`];
	let previousId: string | null = null;
	items.forEach((item, index) => {
		const id = `${idPrefix}${index}`;
		const label = escapeMermaidLabel(labelOf(item));
		lines.push(`${id}["${label}"]`);
		lines.push(
			`style ${id} fill:${VISUAL_COLOR_PLACEHOLDERS.surface},stroke:${VISUAL_COLOR_PLACEHOLDERS.border}`,
		);
		if (previousId) {
			lines.push(`${previousId} --> ${id}`);
		}
		previousId = id;
	});
	return lines.join("\n");
}

function timelineItemLabel(item: TimelineVisualSpec["items"][number]): string {
	const base = `${item.date} — ${item.label}`;
	return item.description ? `${base} (${item.description})` : base;
}

/** A left-to-right chain of rectangle nodes, one per timeline item, in order. */
export function timelineToMermaid(spec: TimelineVisualSpec): string {
	return chainToMermaid("LR", "t", spec.items, timelineItemLabel);
}

function flowStepLabel(step: FlowVisualSpec["steps"][number]): string {
	return step.description
		? `${step.label} (${step.description})`
		: step.label;
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
export function flowToMermaid(spec: FlowVisualSpec): string {
	const lanes = flowLanes(spec.steps);
	if (!lanes) {
		return chainToMermaid("TD", "f", spec.steps, flowStepLabel);
	}
	const lines = ["flowchart TD"];
	// Every node is declared inside its lane before any edge names it: Mermaid
	// places a node in the graph where it first appears.
	lanes.forEach((lane, laneIndex) => {
		lines.push(`subgraph lane${laneIndex}["${escapeMermaidLabel(lane)}"]`);
		spec.steps.forEach((step, index) => {
			if (stepLane(step) === lane) {
				lines.push(
					`f${index}["${escapeMermaidLabel(flowStepLabel(step))}"]`,
				);
			}
		});
		lines.push("end");
	});
	spec.steps.forEach((_, index) => {
		lines.push(
			`style f${index} fill:${VISUAL_COLOR_PLACEHOLDERS.surface},stroke:${VISUAL_COLOR_PLACEHOLDERS.border}`,
		);
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
export function orgChartToMermaid(spec: OrgChartVisualSpec): string {
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
		lines.push(
			`style ${id} fill:${VISUAL_COLOR_PLACEHOLDERS.surface},stroke:${VISUAL_COLOR_PLACEHOLDERS.border}`,
		);
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

/** Dispatch a spec to the matching Mermaid template. Throws for a kind this module does not template (`stat`, `comparison`, `existing_mermaid`, `auto`). */
export function visualSpecToMermaid(spec: VisualSpec): string {
	switch (spec.kind) {
		case "timeline":
			return timelineToMermaid(spec);
		case "flow":
			return flowToMermaid(spec);
		case "org_chart":
			return orgChartToMermaid(spec);
		default:
			throw new Error(
				`visualSpecToMermaid does not template the "${spec.kind}" kind (timeline, flow, and org_chart only).`,
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

const ELLIPSIS = "…";

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
