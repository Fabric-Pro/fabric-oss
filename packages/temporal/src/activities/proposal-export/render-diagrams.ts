/**
 * The diagrams of a Proposal export (Fizzy #2946): every diagram fence of
 * Main drawn as cleaned SVG for the print page and, for DOCX, screenshotted
 * as a PNG; or, when it cannot be drawn here, a captioned placeholder.
 *
 * Not an activity of its own: the export activity calls it with the fence
 * bodies `prepareExportMarkdown` collected, in document order, and both
 * writers look a fence's result up by that order.
 *
 * Parity with the live page. The page passes the trimmed fence to
 * beautiful-mermaid and, when that throws, falls back to mermaid.js in the
 * browser. mermaid.js would need page JavaScript, which the export's
 * Chromium never runs, so a fence the page would hand to mermaid.js prints
 * as a placeholder. Which engine the page uses is decided on the fence as
 * written, before anything is stripped from it; only then are `%%` lines
 * and `click` lines removed (beautiful-mermaid draws a `click` line as a
 * stray box named "click"), and, for a flowchart, the role `classDef`
 * lines appended through the helper the page uses too, so a
 * `class <id> primary` node takes the theme's colour. A node's own `style`
 * line still wins over its role, as it does on the page.
 *
 * Layout runs in a worker thread of its own (`diagram-layout.ts`), each
 * diagram under a wall-clock limit and all of them inside the export's
 * deadline, so a fence that takes long to lay out never stalls the worker.
 *
 * Nothing about a diagram fails the export: an engine refusal, a syntax
 * error, a budget, a time limit, a refused SVG or a failed screenshot each
 * print the placeholder and count toward one `DIAGRAM_PLACEHOLDER` warning.
 *
 * Print legibility. A diagram wider than the print column is shrunk to it,
 * and its labels with it. When a left-to-right flowchart's labels would
 * print below `PRINT_LABEL_FLOOR_PT`, it is laid out once more top-down
 * (the fence in Main is untouched; only the export's copy turns), and the
 * render whose labels print larger is kept. When that is still below the
 * floor, a flowchart's long single-line node labels are broken into lines
 * in the copy (title, sentence and trailing parenthesis apart, then at
 * words) and it is laid out once more, top-down when it was sideways; again
 * the larger labels win. One still below the floor prints as it is and
 * counts toward one `DIAGRAM_BELOW_PRINT_FLOOR` warning. Only flowcharts
 * and state diagrams are measured: other kinds size their text by rules of
 * their own. The live page keeps drawing the fence as written.
 */

import {
	diagramColors,
	type ProposalThemePaint,
	withVisualRoleClassDefs,
} from "@repo/utils/proposal-artifact/theme-tokens";
import type { RenderOptions } from "beautiful-mermaid";
import type { Page } from "playwright";
import type { ExportBrowser } from "../../lib/proposal-export/browser";
import {
	PORTRAIT_TEXT_WIDTH,
	TWIPS_PER_PIXEL,
} from "../../lib/proposal-export/build-docx/styles";
import {
	type CleanedDiagramSvg,
	cleanDiagramSvg,
} from "../../lib/proposal-export/clean-svg";
import {
	type DiagramLayout,
	openDiagramLayout,
} from "../../lib/proposal-export/diagram-layout";
import {
	interFontFaceCss,
	PRINT_FONT_FAMILY,
} from "../../lib/proposal-export/fonts";
import {
	type ExportDiagram,
	type ExportRaster,
	PROPOSAL_EXPORT_LIMITS,
	type ProposalExportWarning,
} from "../../lib/proposal-export/types";
import { activityLogger } from "../lib/activity-logger";

export interface RenderDiagramsInput {
	/** Diagram fence bodies in document order, from `prepareExportMarkdown`. */
	sources: readonly string[];
	/** The theme as it paints: `resolveThemePaint(tokens)`. */
	paint: ProposalThemePaint;
	/** The export's browser; needed only when `withPng`. */
	browser: ExportBrowser | null;
	/** DOCX places a PNG of each diagram; print inlines the SVG. */
	withPng: boolean;
	/**
	 * When layout stops (epoch milliseconds): a diagram not laid out by then
	 * prints its placeholder. The export passes its own deadline less the
	 * time it keeps for the stages after layout.
	 */
	deadline: number;
	/** The layout engine; a worker-thread layout by default. */
	layout?: DiagramLayout;
}

export interface RenderDiagramsResult {
	/** One entry per source, in the same order. */
	diagrams: ExportDiagram[];
	warnings: ProposalExportWarning[];
}

/**
 * What a diagram that is not drawn prints instead. Client-facing, so it
 * says nothing about why.
 */
export const DIAGRAM_PLACEHOLDER_CAPTION =
	"This diagram is available in the online version of this document.";

/** Screenshots are taken at twice the CSS size, for print-quality DOCX. */
const PNG_SCALE = 2;

/**
 * The longest edge a screenshot is drawn at, in CSS pixels, so the PNG's
 * longest edge stays within what an export places as an image.
 */
const MAX_PNG_CSS_EDGE = PROPOSAL_EXPORT_LIMITS.maxImageEdge / PNG_SCALE;

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * The longest one diagram may take to lay out. A generated visual takes
 * milliseconds; only a hostile or runaway fence comes near this.
 */
const DIAGRAM_LAYOUT_TIMEOUT_MS = 10_000;

/**
 * The diagram kinds beautiful-mermaid takes, by its own header rules:
 * xychart, sequence, class and ER diagrams are recognised on the fence's
 * very first line; anything else goes to its flowchart parser, which skips
 * `%%` lines and accepts only a `stateDiagram` or a `graph`/`flowchart` with
 * a direction. "graph" covers flowcharts and state diagrams.
 */
type EngineKind = "graph" | "other";

/**
 * The print column in CSS pixels: the portrait page less its side margins,
 * the width the print layer's `max-width: 100%` shrinks a diagram to.
 */
export const PRINT_COLUMN_PX = PORTRAIT_TEXT_WIDTH / TWIPS_PER_PIXEL;

/** The smallest a printed diagram's node labels may be, in points. */
export const PRINT_LABEL_FLOOR_PT = 9;

/** beautiful-mermaid's node label size, in CSS pixels (its `FONT_SIZES`). */
const NODE_LABEL_PX = 13;

/** Points per CSS pixel: 72 per inch over 96. */
const PT_PER_PX = 0.75;

/** A drawn diagram's node labels as printed at the column, in points. */
export function printedNodeLabelPt(svgWidth: number): number {
	return NODE_LABEL_PX * Math.min(1, PRINT_COLUMN_PX / svgWidth) * PT_PER_PX;
}

/** A left-to-right or right-to-left flowchart header line. */
const SIDEWAYS_HEADER = /^(\s*(?:graph|flowchart)\s+)(?:LR|RL)(\s*)$/i;

const COMMENT_LINE = /^\s*%%/;
const CLICK_LINE = /^\s*click\s+\S/;

/** Which kind beautiful-mermaid would draw the trimmed fence as, or null. */
function engineKind(trimmed: string): EngineKind | null {
	const firstLine = trimmed.split(/[\n;]/)[0]?.trim().toLowerCase() ?? "";
	if (
		/^xychart(-beta)?\b/.test(firstLine) ||
		/^sequencediagram\s*$/.test(firstLine) ||
		/^classdiagram\s*$/.test(firstLine) ||
		/^erdiagram\s*$/.test(firstLine)
	) {
		return "other";
	}
	const header = trimmed
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.startsWith("%%"));
	if (
		header !== undefined &&
		(/^stateDiagram(-v2)?\s*$/i.test(header) ||
			/^(?:graph|flowchart)\s+(?:TD|TB|LR|BT|RL)\s*$/i.test(header))
	) {
		return "graph";
	}
	// A frontmatter block, a kind only mermaid.js draws (timeline, gantt,
	// pie, mindmap …), or a header beautiful-mermaid rejects.
	return null;
}

/**
 * The fence as beautiful-mermaid should see it, with its kind, or null when
 * the live page would draw it with mermaid.js instead.
 */
function prepareDiagramSource(
	source: string,
	paint: ProposalThemePaint,
): { text: string; kind: EngineKind } | null {
	const trimmed = source.trim();
	const kind = engineKind(trimmed);
	if (kind === null) {
		return null;
	}
	const stripped = trimmed
		.split("\n")
		.filter((line) => !COMMENT_LINE.test(line) && !CLICK_LINE.test(line))
		.join("\n");
	return { text: withVisualRoleClassDefs(stripped, paint), kind };
}

/**
 * Every source drawn, cleaned and, when `withPng`, screenshotted. The same
 * input always yields the same SVG strings.
 */
export async function renderExportDiagrams(
	input: RenderDiagramsInput,
): Promise<RenderDiagramsResult> {
	const { sources, paint, browser, withPng } = input;
	// A Word export without diagrams runs without a browser at all.
	if (sources.length === 0) {
		return { diagrams: [], warnings: [] };
	}
	if (withPng && browser === null) {
		throw new TypeError("renderExportDiagrams: withPng needs a browser");
	}
	const options: RenderOptions = {
		...diagramColors(paint),
		font: PRINT_FONT_FAMILY,
		transparent: true,
	};

	let layout: DiagramLayout | null = input.layout ?? null;
	const ownsLayout = !input.layout;
	if (!layout) {
		try {
			layout = openDiagramLayout();
		} catch (error) {
			activityLogger.warn(
				"Proposal export diagram engine failed to load",
				{
					error: error instanceof Error ? error.name : "unknown",
				},
			);
		}
	}

	const diagrams: ExportDiagram[] = [];
	let belowFloor = 0;
	try {
		for (const [index, source] of sources.entries()) {
			const drawn =
				layout && index < PROPOSAL_EXPORT_LIMITS.maxDiagrams
					? await renderOne(layout, source, paint, options, {
							scopeId: diagramScopeId(index),
							deadline: input.deadline,
						})
					: null;
			if (drawn?.belowFloor) {
				belowFloor += 1;
			}
			diagrams.push(
				drawn
					? { kind: "svg", ...drawn.svg, png: null }
					: placeholder(),
			);
		}
	} finally {
		if (ownsLayout) {
			await layout?.close();
		}
	}

	if (withPng && browser) {
		await screenshotDiagrams(browser, diagrams);
	}

	const placeholders = diagrams.filter(
		(diagram) =>
			diagram.kind === "placeholder" || (withPng && diagram.png === null),
	).length;
	const overLimit = Math.max(
		0,
		sources.length - PROPOSAL_EXPORT_LIMITS.maxDiagrams,
	);
	const warnings: ProposalExportWarning[] = [];
	if (placeholders > 0) {
		warnings.push({ code: "DIAGRAM_PLACEHOLDER", count: placeholders });
	}
	if (overLimit > 0) {
		warnings.push({ code: "DIAGRAM_LIMIT", count: overLimit });
	}
	if (belowFloor > 0) {
		warnings.push({ code: "DIAGRAM_BELOW_PRINT_FLOOR", count: belowFloor });
	}
	return { diagrams, warnings };
}

/**
 * The id of a diagram's root `<svg>` and the prefix of every id inside it:
 * by document position, so it is the same on every export and unique on
 * one page.
 */
function diagramScopeId(index: number): string {
	return `pa-diagram-${index + 1}`;
}

function placeholder(): ExportDiagram {
	return { kind: "placeholder", caption: DIAGRAM_PLACEHOLDER_CAPTION };
}

interface DrawnDiagram {
	svg: CleanedDiagramSvg;
	/** Its node labels still print below the floor. */
	belowFloor: boolean;
}

/**
 * One fence drawn and cleaned, or null for its placeholder; a sideways
 * flowchart whose labels would print below the floor is tried top-down too,
 * then a flowchart still below it with its long labels broken into lines,
 * and a graph still below it is marked.
 * Each layout gets at most the per-diagram limit, and never more than the
 * export has left.
 */
async function renderOne(
	layout: DiagramLayout,
	source: string,
	paint: ProposalThemePaint,
	options: RenderOptions,
	at: { scopeId: string; deadline: number },
): Promise<DrawnDiagram | null> {
	if (source.length > PROPOSAL_EXPORT_LIMITS.maxDiagramSourceLength) {
		return null;
	}
	const prepared = prepareDiagramSource(source, paint);
	if (prepared === null) {
		return null;
	}
	const drawn = await drawPrepared(layout, prepared.text, options, at);
	if (drawn === null) {
		return null;
	}
	// Only a graph's labels are drawn at the node label size; a chart's or
	// a sequence's text is sized and placed by rules of its own.
	if (prepared.kind !== "graph") {
		return { svg: drawn, belowFloor: false };
	}
	let best = drawn;
	if (printedNodeLabelPt(best.width) < PRINT_LABEL_FLOOR_PT) {
		const turned = turnTopDown(prepared.text);
		const redrawn = turned
			? await drawPrepared(layout, turned, options, at)
			: null;
		if (
			redrawn &&
			printedNodeLabelPt(redrawn.width) > printedNodeLabelPt(best.width)
		) {
			best = redrawn;
		}
		if (printedNodeLabelPt(best.width) < PRINT_LABEL_FLOOR_PT) {
			const wrapped = wrapNodeLabels(turned ?? prepared.text);
			const rewrapped = wrapped
				? await drawPrepared(layout, wrapped, options, at)
				: null;
			if (
				rewrapped &&
				printedNodeLabelPt(rewrapped.width) >
					printedNodeLabelPt(best.width)
			) {
				best = rewrapped;
			}
		}
	}
	return {
		svg: best,
		belowFloor: printedNodeLabelPt(best.width) < PRINT_LABEL_FLOOR_PT,
	};
}

/** A prepared source laid out and cleaned, or null. */
async function drawPrepared(
	layout: DiagramLayout,
	prepared: string,
	options: RenderOptions,
	at: { scopeId: string; deadline: number },
): Promise<CleanedDiagramSvg | null> {
	const left = at.deadline - Date.now();
	if (left <= 0) {
		return null;
	}
	const svg = await layout.render(
		prepared,
		options,
		Math.min(DIAGRAM_LAYOUT_TIMEOUT_MS, left),
	);
	if (svg === null || svg.length > PROPOSAL_EXPORT_LIMITS.maxSvgLength) {
		return null;
	}
	return cleanDiagramSvg(svg, { scopeId: at.scopeId });
}

/**
 * A prepared flowchart's copy with its `LR`/`RL` header turned `TD`, or null
 * when its header is not sideways. Only the header line changes.
 */
function turnTopDown(prepared: string): string | null {
	const lines = prepared.split("\n");
	const headerIndex = lines.findIndex((line) => line.trim().length > 0);
	const header = lines[headerIndex];
	if (header === undefined || !SIDEWAYS_HEADER.test(header)) {
		return null;
	}
	lines[headerIndex] = header.replace(SIDEWAYS_HEADER, "$1TD$2");
	return lines.join("\n");
}

/** The longest line a broken node label gets, in characters. */
const WRAPPED_LABEL_LINE_CHARS = 30;

/**
 * beautiful-mermaid 1.1.3's flowchart node shapes, in the order its parser
 * tries them (`NODE_PATTERNS`); the second group is the label as written,
 * `open` characters after the id.
 * Mirrored so a label is found exactly where the engine finds it: re-check
 * on an engine upgrade.
 */
const NODE_PATTERNS: readonly { regex: RegExp; shape: string; open: number }[] =
	[
		{ regex: /^([\w-]+)\(\(\((.+?)\)\)\)/, shape: "doublecircle", open: 3 },
		{ regex: /^([\w-]+)\(\[(.+?)\]\)/, shape: "stadium", open: 2 },
		{ regex: /^([\w-]+)\(\((.+?)\)\)/, shape: "circle", open: 2 },
		{ regex: /^([\w-]+)\[\[(.+?)\]\]/, shape: "subroutine", open: 2 },
		{ regex: /^([\w-]+)\[\((.+?)\)\]/, shape: "cylinder", open: 2 },
		{ regex: /^([\w-]+)\[\/(.+?)\\\]/, shape: "trapezoid", open: 2 },
		{ regex: /^([\w-]+)\[\\(.+?)\/\]/, shape: "trapezoid-alt", open: 2 },
		{ regex: /^([\w-]+)>(.+?)\]/, shape: "asymmetric", open: 1 },
		{ regex: /^([\w-]+)\{\{(.+?)\}\}/, shape: "hexagon", open: 2 },
		{ regex: /^([\w-]+)\[(.+?)\]/, shape: "rectangle", open: 1 },
		{ regex: /^([\w-]+)\((.+?)\)/, shape: "rounded", open: 1 },
		{ regex: /^([\w-]+)\{(.+?)\}/, shape: "diamond", open: 1 },
	];
const BARE_NODE = /^[\w-]+/;
const CLASS_SHORTHAND = /^:::[\w][\w-]*/;
const ARROW = /^(<)?(-->|-.->|==>|---|-\.-|===)(?:\|([^|]*)\|)?/;
const TEXT_ARROW = /^(<)?(--|-\.|==)\s+(.+?)\s+(-->|---|\.->|-\.-|==>|===)/;

/** Lines the engine's flowchart parser reads as something other than edges. */
const NON_EDGE_LINES: readonly RegExp[] = [
	/^classDef\s+(\w+)\s+(.+)$/,
	/^class\s+([\w,-]+)\s+(\w+)$/,
	/^style\s+([\w,-]+)\s+(.+)$/,
	/^linkStyle\s+(default|[\d,\s]+)\s+(.+)$/,
	/^direction\s+(TD|TB|LR|BT|RL)\s*$/i,
	/^subgraph\s+(.+)$/,
	/^end$/,
];

/** A line break inside a label, as both Mermaid engines read it. */
const LABEL_BREAK = "<br/>";

/** A label already broken into lines, or formatted across words. */
const UNWRAPPABLE_LABEL = /<br\s*\/?>|\\n|[*`<]|~~/i;

/** The first " — ", " – " or " - " between a label's title and its sentence. */
const TITLE_DASH = /\s+([—–-])\s+/;

/** A label's last parenthesis, balanced and at its very end. */
const TRAILING_PARENTHESIS = /\s+(\([^()]*\))$/;

interface LabelSpan {
	shape: string;
	start: number;
	end: number;
}

/**
 * Where each node label of one trimmed flowchart line sits, walked as the
 * engine walks it (`parseEdgeLine`): a node group joined by `&`, then an
 * arrow, a group, and so on until something is not one.
 */
function nodeLabelSpans(line: string): LabelSpan[] {
	const spans: LabelSpan[] = [];
	let at = 0;
	const skipSpace = () => {
		while (at < line.length && /\s/.test(line.charAt(at))) {
			at++;
		}
	};
	const consumeNode = (): boolean => {
		const rest = line.slice(at);
		let length = 0;
		for (const { regex, shape, open } of NODE_PATTERNS) {
			const match = regex.exec(rest);
			if (match) {
				const start = at + String(match[1]).length + open;
				spans.push({
					shape,
					start,
					end: start + String(match[2]).length,
				});
				length = match[0].length;
				break;
			}
		}
		if (length === 0) {
			length = BARE_NODE.exec(rest)?.[0].length ?? 0;
		}
		if (length === 0) {
			return false;
		}
		at += length;
		at += CLASS_SHORTHAND.exec(line.slice(at))?.[0].length ?? 0;
		return true;
	};
	const consumeGroup = (): boolean => {
		if (!consumeNode()) {
			return false;
		}
		skipSpace();
		while (line.charAt(at) === "&") {
			at++;
			skipSpace();
			if (!consumeNode()) {
				break;
			}
			skipSpace();
		}
		return true;
	};
	if (!consumeGroup()) {
		return spans;
	}
	while (at < line.length) {
		const rest = line.slice(at);
		const arrow = ARROW.exec(rest) ?? TEXT_ARROW.exec(rest);
		if (!arrow) {
			break;
		}
		at += arrow[0].length;
		skipSpace();
		if (!consumeGroup()) {
			break;
		}
	}
	return spans;
}

/** `text` greedily wrapped at spaces; a word longer than a line stays whole. */
function wrapAtWords(text: string): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (
			line &&
			Array.from(`${line} ${word}`).length > WRAPPED_LABEL_LINE_CHARS
		) {
			lines.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) {
		lines.push(line);
	}
	return lines;
}

/**
 * A long single-line label's text broken into lines with `<br/>`, or null
 * to leave it as written: the title before a spaced dash (the dash kept at
 * its end), the sentence, and a trailing parenthesis each start a line of
 * their own, and each wraps at words. Every word stays, in order; only
 * spacing changes.
 */
function wrapLabelText(text: string): string | null {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (
		UNWRAPPABLE_LABEL.test(collapsed) ||
		Array.from(collapsed).length <= WRAPPED_LABEL_LINE_CHARS
	) {
		return null;
	}
	const parts: string[] = [];
	let rest = collapsed;
	const dash = TITLE_DASH.exec(rest);
	if (dash && dash.index > 0 && dash.index + dash[0].length < rest.length) {
		parts.push(`${rest.slice(0, dash.index)} ${dash[1]}`);
		rest = rest.slice(dash.index + dash[0].length);
	}
	const parenthesis = TRAILING_PARENTHESIS.exec(rest);
	const tail = parenthesis && parenthesis.index > 0 ? parenthesis[1] : null;
	if (parenthesis && tail) {
		rest = rest.slice(0, parenthesis.index);
	}
	parts.push(rest);
	if (tail) {
		parts.push(tail);
	}
	const lines = parts.flatMap(wrapAtWords);
	return lines.length > 1 ? lines.join(LABEL_BREAK) : null;
}

/** A label's text as the engine draws it, ignoring line breaks and spacing. */
function labelWords(label: string): string {
	const unquoted =
		label.length >= 2 && label.startsWith('"') && label.endsWith('"')
			? label.slice(1, -1)
			: label;
	return unquoted
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** One trimmed flowchart line with its long node labels broken, or as is. */
function wrapLineLabels(line: string): string {
	const spans = nodeLabelSpans(line);
	let rewritten = line;
	for (const span of [...spans].reverse()) {
		const label = line.slice(span.start, span.end);
		const quoted =
			label.length >= 2 && label.startsWith('"') && label.endsWith('"');
		const wrapped = wrapLabelText(quoted ? label.slice(1, -1) : label);
		if (wrapped !== null) {
			rewritten = `${rewritten.slice(0, span.start)}${
				quoted ? `"${wrapped}"` : wrapped
			}${rewritten.slice(span.end)}`;
		}
	}
	if (rewritten === line) {
		return line;
	}
	// The engine must find the same nodes, shapes and words in the rewritten
	// line; anything else keeps the line as written.
	const after = nodeLabelSpans(rewritten);
	const same =
		after.length === spans.length &&
		after.every((span, index) => {
			const before = spans[index];
			return (
				before !== undefined &&
				span.shape === before.shape &&
				labelWords(rewritten.slice(span.start, span.end)) ===
					labelWords(line.slice(before.start, before.end))
			);
		});
	return same ? rewritten : line;
}

/**
 * A prepared flowchart's copy with its long single-line node labels broken
 * into lines, or null when it is not a flowchart or no label changed.
 */
function wrapNodeLabels(prepared: string): string | null {
	const lines = prepared.split("\n");
	const headerIndex = lines.findIndex((line) => line.trim().length > 0);
	if (!/^\s*(?:graph|flowchart)\s/i.test(lines[headerIndex] ?? "")) {
		return null;
	}
	let changed = false;
	const rewritten = lines.map((line, index) => {
		const trimmed = line.trim();
		if (
			index <= headerIndex ||
			trimmed.length === 0 ||
			trimmed.startsWith("%%") ||
			NON_EDGE_LINES.some((pattern) => pattern.test(trimmed))
		) {
			return line;
		}
		const wrapped = wrapLineLabels(trimmed);
		if (wrapped === trimmed) {
			return line;
		}
		changed = true;
		return `${line.slice(0, line.length - line.trimStart().length)}${wrapped}`;
	});
	return changed ? rewritten.join("\n") : null;
}

/**
 * A PNG of every drawn diagram, on one hardened page (JavaScript off,
 * offline, every request aborted): each cleaned SVG is set as the page's
 * whole content and its element screenshotted. A failed screenshot leaves
 * that diagram's `png` null, and the DOCX prints its placeholder. Opening
 * the page is not caught: it fails only when the export's browser or its
 * time budget is gone, which the export itself reports.
 */
async function screenshotDiagrams(
	browser: ExportBrowser,
	diagrams: ExportDiagram[],
): Promise<void> {
	if (!diagrams.some((diagram) => diagram.kind === "svg")) {
		return;
	}
	const page = await browser.newPage({
		deviceScaleFactor: PNG_SCALE,
		// Every screenshot fits, so none depends on scrolling.
		viewport: { width: MAX_PNG_CSS_EDGE, height: MAX_PNG_CSS_EDGE },
	});
	try {
		for (const [index, diagram] of diagrams.entries()) {
			if (diagram.kind !== "svg") {
				continue;
			}
			try {
				diagram.png = await screenshotDiagram(page, diagram, index);
			} catch (error) {
				activityLogger.warn(
					"Proposal export diagram screenshot failed",
					{
						diagram: index + 1,
						error: error instanceof Error ? error.name : "unknown",
					},
				);
			}
		}
	} finally {
		await page
			.context()
			.close()
			.catch(() => undefined);
	}
}

async function screenshotDiagram(
	page: Page,
	diagram: Extract<ExportDiagram, { kind: "svg" }>,
	index: number,
): Promise<ExportRaster | null> {
	const scale = Math.min(
		1,
		MAX_PNG_CSS_EDGE / Math.max(diagram.width, diagram.height),
	);
	const width = roundCss(diagram.width * scale);
	const height = roundCss(diagram.height * scale);
	await page.setContent(screenshotDocument(diagram.svg, width, height), {
		waitUntil: "load",
	});
	const bytes = await page
		.locator(`#${diagramScopeId(index)}`)
		.screenshot({ type: "png", omitBackground: false });
	const size = readPngSize(bytes);
	return size ? { mimeType: "image/png", bytes, ...size } : null;
}

/**
 * The page a diagram is screenshotted on: the embedded Inter, a white
 * background behind the transparent diagram, and the cleaned SVG at an
 * explicit size. No script, and nothing that loads.
 */
function screenshotDocument(
	svg: string,
	width: number,
	height: number,
): string {
	return [
		"<!DOCTYPE html>",
		'<html><head><meta charset="utf-8"><style>',
		interFontFaceCss(),
		"\nhtml,body{margin:0;padding:0;background:#fff}",
		`\nsvg{display:block;width:${width}px;height:${height}px}`,
		"</style></head><body>",
		svg,
		"</body></html>",
	].join("");
}

function roundCss(value: number): number {
	return Math.max(1, Math.round(value * 100) / 100);
}

/** A PNG's pixel size from its IHDR chunk, or null when it is not a PNG. */
function readPngSize(bytes: Buffer): { width: number; height: number } | null {
	if (
		bytes.length < 24 ||
		!bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
		bytes.toString("latin1", 12, 16) !== "IHDR"
	) {
		return null;
	}
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	return width > 0 && height > 0 ? { width, height } : null;
}
