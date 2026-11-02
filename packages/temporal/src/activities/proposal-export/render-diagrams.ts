/**
 * The diagrams of a Proposal export (Fizzy #2946): every diagram fence of
 * Main drawn as cleaned SVG for the print page and, for DOCX, screenshotted
 * as a PNG; or, when it is not drawn, left out or kept as a captioned
 * placeholder, by cause.
 *
 * Not an activity of its own: the export activity calls it with the fence
 * bodies `prepareExportMarkdown` collected, in document order, and both
 * writers look a fence's result up by that order.
 *
 * Figure templates. A fence with a `%% figure:` line draws its SVG template
 * (`proposal-figures/`), as the live page does, coloured from the same
 * paint as the diagram roles. A template needs no layout, is drawn at the
 * print column's width and is never turned or re-wrapped; when the template
 * refuses the source, the fence draws as below.
 *
 * Parity with the live page. The page passes the trimmed fence to
 * beautiful-mermaid and, when that throws, falls back to mermaid.js in the
 * browser. mermaid.js would need page JavaScript, which the export's
 * Chromium never runs, so a fence of a kind only mermaid.js draws prints as
 * a placeholder, and one of a kind neither engine knows is left out. That
 * is decided on the fence as written (`diagram-printability.ts`, which
 * the editor's figure numbers and its "not in PDF" note read too), before
 * anything is stripped from it; only then are `%%` lines
 * and `click` lines removed (beautiful-mermaid draws a `click` line as a
 * stray box named "click"), and, for a flowchart, the role `classDef`
 * lines appended through the helper the page uses too, so a
 * `class <id> primary` node takes the theme's colour. A node's own `style`
 * line still wins over its role, as it does on the page. An xychart is
 * recognised past its leading `%%` lines, which the engine alone would not
 * do: the strip here hands it the chart header first, and the page strips
 * the same lines before drawing it, so a `%% figure: bars` fence its
 * template refuses prints as a plain chart under the page's number.
 *
 * Layout runs in a worker thread of its own (`diagram-layout.ts`), each
 * diagram under a wall-clock limit and all of them inside the export's
 * deadline, so a fence that takes long to lay out never stalls the worker.
 *
 * Nothing about a diagram fails the export. What does not draw is, by cause:
 *
 * - a kind only the live page draws (mermaid.js knows it, beautiful-mermaid
 *   does not take it): the captioned placeholder, counted toward one
 *   `DIAGRAM_NOT_PRINTABLE` warning, whether or not the page can draw it;
 * - a fence of a kind beautiful-mermaid takes that the export could not
 *   draw for a reason other than the source (a layout that ran past its
 *   time limit or the export's, a layout thread that failed or could not
 *   start, a source or an SVG past its size limit, an SVG
 *   the cleaner refused): the live page draws and numbers it, so the
 *   numbered placeholder, counted toward that same `DIAGRAM_NOT_PRINTABLE`
 *   warning. A layout whose thread failed or could not start is tried once
 *   more first, so a thread that dies does not cost a figure at random;
 *   one that ran past its time limit is not, so a slow fence never costs
 *   twice the time the diagrams after it need;
 * - a fence past the export's diagram limit: the placeholder, counted
 *   toward one `DIAGRAM_LIMIT` warning;
 * - a drawn diagram whose DOCX screenshot fails: still printed in the PDF,
 *   and in the DOCX a placeholder under its own "Figure n." caption, so the
 *   two number every figure alike; counted toward one `DIAGRAM_PLACEHOLDER`
 *   warning;
 * - anything else (a header neither engine knows, a syntax error, a
 *   flowchart header with no direction it knows, a source the engine
 *   refused): the live page does not number it either, so it is left out,
 *   and counted toward one `DIAGRAM_PLACEHOLDER` warning.
 *
 * Print legibility. A diagram wider than the print column is shrunk to it,
 * and one taller than a printed figure may be (`PRINT_FIGURE_MAX_HEIGHT_PX`,
 * the height the Word writer shrinks a picture to) is shrunk to that, and
 * its labels with it; `printedNodeLabelPt` measures both. A flowchart with
 * node labels of `ALWAYS_WRAPPED_LABEL_CHARS` or more is laid out as
 * prepared and with those labels broken into lines, since the engine's
 * estimate of a long line's width runs short of the text, and the copy
 * whose labels print larger is kept, the broken one on a tie: a tall
 * diagram broken this way can grow taller than a figure may be, and then
 * keeps its labels on one line. When a left-to-right flowchart's labels
 * would print below `PRINT_LABEL_FLOOR_PT`, it is laid out once more
 * top-down (the fence in Main is untouched; only the export's copy turns),
 * as written as well as broken when the broken copy was kept, and the
 * render whose labels print larger is kept. When that is still
 * below the floor, a
 * flowchart's long single-line node labels are broken into lines in the
 * copy (title, sentence and trailing parenthesis apart, then at words) and
 * it is laid out once more, top-down when it was sideways; again the larger
 * labels win. One still below the floor prints as it is and counts toward
 * one `DIAGRAM_BELOW_PRINT_FLOOR` warning. Only flowcharts and state
 * diagrams are measured: other kinds size their text by rules of their own.
 * A flowchart or state diagram keeps a narrow blank margin around its
 * drawing rather than the engine's wide one, so its figure is only as tall
 * as what it draws.
 *
 * The live page draws with the same helpers, label length, measure, floor
 * and canvas margin (`@repo/utils/proposal-artifact/diagram-label-wrap`),
 * so a client Proposal's page lays each fence out as it prints; any other
 * page always breaks the long labels and keeps the author's direction.
 */

import {
	ALWAYS_WRAPPED_LABEL_CHARS,
	DIAGRAM_CANVAS_PADDING_PX,
	PRINT_LABEL_FLOOR_PT,
	printedNodeLabelPt,
	turnFlowchartTopDown,
	wrapFlowchartNodeLabels,
} from "@repo/utils/proposal-artifact/diagram-label-wrap";
import {
	diagramPrintability,
	figurePaletteOf,
	type PrintableDiagramKind,
	printableDiagramKind,
} from "@repo/utils/proposal-artifact/diagram-printability";
import {
	type FigurePalette,
	tryRenderFigure,
} from "@repo/utils/proposal-artifact/proposal-figures";
import {
	diagramColors,
	type ProposalThemePaint,
	withVisualRoleClassDefs,
} from "@repo/utils/proposal-artifact/theme-tokens";
import type { RenderOptions } from "beautiful-mermaid";
import type { Page } from "playwright";
import type { ExportBrowser } from "../../lib/proposal-export/browser";
import {
	type CleanedDiagramSvg,
	cleanDiagramSvg,
} from "../../lib/proposal-export/clean-svg";
import {
	type DiagramLayout,
	openDiagramLayout,
} from "../../lib/proposal-export/diagram-layout";
import { PRINT_FONTS, printFontFaceCss } from "../../lib/proposal-export/fonts";
import {
	type ExportDiagram,
	type ExportRaster,
	PROPOSAL_EXPORT_LIMITS,
	type ProposalExportWarning,
} from "../../lib/proposal-export/types";
import { activityLogger } from "../lib/activity-logger";

/**
 * The print column, its label floor and the canvas margin, as the live page
 * reads them too.
 */
export {
	DIAGRAM_CANVAS_PADDING_PX,
	PRINT_COLUMN_PX,
	PRINT_LABEL_FLOOR_PT,
	printedNodeLabelPt,
} from "@repo/utils/proposal-artifact/diagram-label-wrap";

export interface RenderDiagramsInput {
	/** Diagram fence bodies in document order, from `prepareExportMarkdown`. */
	sources: readonly string[];
	/**
	 * Each fence's caption, by the same order, or null: a figure template's
	 * accessible title. Without it a template is titled by its kind.
	 */
	captions?: readonly (string | null)[];
	/** The theme as it paints: `resolveThemePaint(tokens)`. */
	paint: ProposalThemePaint;
	/** The export's browser; needed only when `withPng`. */
	browser: ExportBrowser | null;
	/** DOCX places a PNG of each diagram; print inlines the SVG. */
	withPng: boolean;
	/**
	 * When layout stops (epoch milliseconds): a diagram not laid out by then
	 * prints as a placeholder. The export passes its own deadline less the
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
 * What a diagram kept as a placeholder prints instead. Client-facing, so it
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

const COMMENT_LINE = /^\s*%%/;
const CLICK_LINE = /^\s*click\s+\S/;

interface PreparedDiagram {
	text: string;
	kind: PrintableDiagramKind;
}

/**
 * Why a fence is not drawn: its source is broken (left out, as the live page
 * does not number it), or the export could not print what the live page
 * draws (a numbered placeholder).
 */
type NotDrawn = "broken" | "notPrintable";

/**
 * The fence as beautiful-mermaid should see it, with its kind; or, when the
 * engine does not take it, whether it is a kind only the live page draws (a
 * placeholder) or one no engine knows, broken or empty (left out).
 */
function prepareDiagramSource(
	source: string,
	paint: ProposalThemePaint,
): PreparedDiagram | NotDrawn {
	const trimmed = source.trim();
	const kind = printableDiagramKind(trimmed);
	if (kind === null) {
		return diagramPrintability(trimmed) === "liveOnly"
			? "notPrintable"
			: "broken";
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
		font: PRINT_FONTS.body,
		transparent: true,
		padding: DIAGRAM_CANVAS_PADDING_PX,
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

	const palette = figurePaletteOf(paint);
	const diagrams: ExportDiagram[] = [];
	let belowFloor = 0;
	let notPrintable = 0;
	try {
		for (const [index, source] of sources.entries()) {
			const scopeId = diagramScopeId(index);
			if (index >= PROPOSAL_EXPORT_LIMITS.maxDiagrams) {
				diagrams.push(placeholder());
				continue;
			}
			const template = drawTemplate(
				source,
				palette,
				input.captions?.[index] ?? null,
				scopeId,
			);
			if (template) {
				diagrams.push(drawnDiagram(template));
				continue;
			}
			const prepared = prepareDiagramSource(source, paint);
			// Without an engine, nothing about the source is known to be
			// wrong, and the live page draws it.
			const drawn =
				typeof prepared === "string"
					? prepared
					: layout
						? await renderOne(layout, source, prepared, options, {
								scopeId,
								deadline: input.deadline,
							})
						: "notPrintable";
			if (drawn === "broken") {
				diagrams.push(OMITTED);
				continue;
			}
			if (drawn === "notPrintable") {
				notPrintable += 1;
				diagrams.push(placeholder());
				continue;
			}
			if (drawn.belowFloor) {
				belowFloor += 1;
			}
			diagrams.push(drawnDiagram(drawn.svg));
		}
	} finally {
		if (ownsLayout) {
			await layout?.close();
		}
	}

	if (withPng && browser) {
		await screenshotDiagrams(browser, diagrams);
	}

	const omitted = diagrams.filter(
		(diagram) =>
			diagram.kind === "omitted" ||
			(withPng && diagram.kind === "svg" && diagram.png === null),
	).length;
	const overLimit = Math.max(
		0,
		sources.length - PROPOSAL_EXPORT_LIMITS.maxDiagrams,
	);
	const warnings: ProposalExportWarning[] = [];
	if (omitted > 0) {
		warnings.push({ code: "DIAGRAM_PLACEHOLDER", count: omitted });
	}
	if (notPrintable > 0) {
		warnings.push({ code: "DIAGRAM_NOT_PRINTABLE", count: notPrintable });
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
	return {
		kind: "placeholder",
		caption: DIAGRAM_PLACEHOLDER_CAPTION,
		numbered: true,
	};
}

const OMITTED: ExportDiagram = { kind: "omitted", numbered: false };

function drawnDiagram(svg: CleanedDiagramSvg): ExportDiagram {
	return { kind: "svg", ...svg, png: null, numbered: true };
}

/**
 * The fence's figure template, cleaned, or null when it asks for none, or
 * the template or the cleaner refuses it: the fence then draws as Mermaid,
 * as on the live page.
 */
function drawTemplate(
	source: string,
	palette: FigurePalette,
	caption: string | null,
	scopeId: string,
): CleanedDiagramSvg | null {
	const svg = tryRenderFigure(source, palette, { caption });
	return svg === null ? null : cleanDiagramSvg(svg, { scopeId });
}

interface DrawnDiagram {
	svg: CleanedDiagramSvg;
	/** Its node labels still print below the floor. */
	belowFloor: boolean;
}

/**
 * One fence drawn and cleaned, or why it is not. A flowchart with node
 * labels of `ALWAYS_WRAPPED_LABEL_CHARS` or more is laid out both as
 * prepared and with those labels broken into lines, as the live page draws
 * a Proposal's diagrams, and the copy whose labels print larger is kept:
 * the broken one on a tie, as its labels stay inside their boxes, and the
 * one as prepared when breaking makes the diagram taller than a printed
 * figure may be. A copy the engine refuses drops out. Then a sideways
 * flowchart whose labels would print below the floor is tried top-down too,
 * both the copy kept and, when it is the broken one, the copy as prepared,
 * then a flowchart still below it with every long label broken into lines,
 * and a graph still below it is marked. Labels are measured at the size
 * they print, shrunk to the column's width or a figure's height.
 * Each layout gets at most the per-diagram limit, and never more than the
 * export has left; a fence whose first layout was abandoned is not laid out
 * again as another copy.
 */
async function renderOne(
	layout: DiagramLayout,
	source: string,
	prepared: PreparedDiagram,
	options: RenderOptions,
	at: { scopeId: string; deadline: number },
): Promise<DrawnDiagram | NotDrawn> {
	if (source.length > PROPOSAL_EXPORT_LIMITS.maxDiagramSourceLength) {
		return "notPrintable";
	}
	// Only the layouts that decide whether the fence prints at all are tried
	// again; the turned and re-wrapped copies only compete with them.
	const deciding = { ...at, attempts: 2 };
	const asPrepared = await drawPrepared(
		layout,
		prepared.text,
		options,
		deciding,
	);
	// A fence whose layout was abandoned, or found no time left, is not laid
	// out again as another copy.
	if (asPrepared === "notPrintable") {
		return asPrepared;
	}
	// What the variants below start from: the copy kept of the two.
	let base = prepared.text;
	let drawn: CleanedDiagramSvg | NotDrawn = asPrepared;
	const longBroken = wrapFlowchartNodeLabels(prepared.text, {
		minChars: ALWAYS_WRAPPED_LABEL_CHARS,
	});
	if (longBroken !== null) {
		const broken = await drawPrepared(
			layout,
			longBroken,
			options,
			deciding,
		);
		if (
			typeof broken !== "string" &&
			(typeof drawn === "string" ||
				printedNodeLabelPt(broken) >= printedNodeLabelPt(drawn))
		) {
			base = longBroken;
			drawn = broken;
		}
	}
	if (typeof drawn === "string") {
		return drawn;
	}
	// Only a graph's labels are drawn at the node label size; a chart's or
	// a sequence's text is sized and placed by rules of its own.
	if (prepared.kind !== "graph") {
		return { svg: drawn, belowFloor: false };
	}
	let best = drawn;
	const belowFloor = () => printedNodeLabelPt(best) < PRINT_LABEL_FLOOR_PT;
	// A variant replaces the best layout only when its labels print larger.
	const tryVariant = async (variant: string): Promise<void> => {
		const redrawn = await drawPrepared(layout, variant, options, at);
		if (
			typeof redrawn !== "string" &&
			printedNodeLabelPt(redrawn) > printedNodeLabelPt(best)
		) {
			best = redrawn;
		}
	};
	if (belowFloor()) {
		const turned = turnFlowchartTopDown(base);
		if (turned) {
			await tryVariant(turned);
		}
		// The copy as written is turned too: broken labels make a turned
		// diagram taller, and a tall one prints smaller, so it can print
		// larger than the broken copy turned, which wins a tie.
		if (base !== prepared.text) {
			const turnedAsPrepared = turnFlowchartTopDown(prepared.text);
			if (turnedAsPrepared) {
				await tryVariant(turnedAsPrepared);
			}
		}
		if (belowFloor()) {
			const wrapped = wrapFlowchartNodeLabels(turned ?? base);
			if (wrapped) {
				await tryVariant(wrapped);
			}
		}
	}
	return { svg: best, belowFloor: belowFloor() };
}

/**
 * A prepared source laid out and cleaned; `broken` when the engine refused
 * it, or `notPrintable` when the layout was abandoned, no time was left or
 * the SVG is past its size limit or refused by the cleaner. A layout whose
 * thread failed is tried again, up to `attempts` in all, while time is
 * left; one that ran past its time limit, and a source the engine refused,
 * never is.
 */
async function drawPrepared(
	layout: DiagramLayout,
	prepared: string,
	options: RenderOptions,
	at: { scopeId: string; deadline: number; attempts?: number },
): Promise<CleanedDiagramSvg | NotDrawn> {
	for (let attempt = 1; ; attempt++) {
		const left = at.deadline - Date.now();
		if (left <= 0) {
			return "notPrintable";
		}
		const laidOut = await layout.render(
			prepared,
			options,
			Math.min(DIAGRAM_LAYOUT_TIMEOUT_MS, left),
		);
		if (laidOut.svg !== null) {
			const cleaned =
				laidOut.svg.length > PROPOSAL_EXPORT_LIMITS.maxSvgLength
					? null
					: cleanDiagramSvg(laidOut.svg, { scopeId: at.scopeId });
			return cleaned ?? "notPrintable";
		}
		if (laidOut.abandoned === false) {
			return "broken";
		}
		if (laidOut.abandoned !== "thread" || attempt >= (at.attempts ?? 1)) {
			return "notPrintable";
		}
	}
}

/**
 * A PNG of every drawn diagram, on one hardened page (JavaScript off,
 * offline, every request aborted): each cleaned SVG is set as the page's
 * whole content and its element screenshotted. A diagram whose screenshot
 * fails keeps its `png` null and its number, so the DOCX prints its
 * placeholder under the same "Figure n." the PDF gives it. Opening the page is not caught: it fails
 * only when the export's browser or its time budget is gone, which the
 * export itself reports.
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
			let png: ExportRaster | null = null;
			try {
				png = await screenshotDiagram(page, diagram, index);
			} catch (error) {
				activityLogger.warn(
					"Proposal export diagram screenshot failed",
					{
						diagram: index + 1,
						error: error instanceof Error ? error.name : "unknown",
					},
				);
			}
			if (png) {
				diagrams[index] = { ...diagram, png };
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
 * The page a diagram is screenshotted on: the embedded print faces (a
 * figure template's Inter 600 and JetBrains Mono 500 among them), a white
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
		printFontFaceCss(),
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
