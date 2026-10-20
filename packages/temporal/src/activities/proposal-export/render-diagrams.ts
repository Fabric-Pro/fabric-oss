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
 * stray box named "click"), and the role `classDef` lines appended so a
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
 */

import {
	diagramColors,
	type ProposalThemePaint,
	visualRoleClassDefs,
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
 * a direction. "graph" covers flowcharts and state diagrams, the two kinds
 * whose parser reads `classDef`.
 */
type EngineKind = "graph" | "other";

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
 * The fence as beautiful-mermaid should see it, or null when the live page
 * would draw it with mermaid.js instead.
 */
function prepareDiagramSource(
	source: string,
	paint: ProposalThemePaint,
): string | null {
	const trimmed = source.trim();
	const kind = engineKind(trimmed);
	if (kind === null) {
		return null;
	}
	const lines = trimmed
		.split("\n")
		.filter((line) => !COMMENT_LINE.test(line) && !CLICK_LINE.test(line));
	if (kind === "graph") {
		lines.push(...visualRoleClassDefs(paint));
	}
	return lines.join("\n");
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
	try {
		for (const [index, source] of sources.entries()) {
			const drawn =
				layout && index < PROPOSAL_EXPORT_LIMITS.maxDiagrams
					? await renderOne(layout, source, paint, options, {
							scopeId: diagramScopeId(index),
							deadline: input.deadline,
						})
					: null;
			diagrams.push(
				drawn ? { kind: "svg", ...drawn, png: null } : placeholder(),
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

/**
 * One fence drawn and cleaned, or null for its placeholder. It gets at most
 * the per-diagram limit, and never more than the export has left.
 */
async function renderOne(
	layout: DiagramLayout,
	source: string,
	paint: ProposalThemePaint,
	options: RenderOptions,
	at: { scopeId: string; deadline: number },
): Promise<CleanedDiagramSvg | null> {
	if (source.length > PROPOSAL_EXPORT_LIMITS.maxDiagramSourceLength) {
		return null;
	}
	const prepared = prepareDiagramSource(source, paint);
	const left = at.deadline - Date.now();
	if (prepared === null || left <= 0) {
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
