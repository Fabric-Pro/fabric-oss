/**
 * Figure templates for a Proposal's diagrams (Fizzy #2946): a numbered
 * process (or timeline), architecture layers, a team, a bar chart and a
 * gantt chart, drawn as fixed SVG instead of a generic Mermaid layout.
 *
 * A fence asks for a template with one comment line in its leading `%%`
 * block, after the generated-visual marker and the caption:
 *
 *   ```mermaid
 *   %% fabric-visual: k3v9q2m7x1a8c4d6
 *   %% caption: How one scope line moves
 *   %% figure: process
 *   flowchart TD
 *     f0["Scope<br/>Agree what done looks like"]
 *     f1["Build"]
 *     f0 --> f1
 *   ```
 *
 * The source stays Mermaid, so whatever cannot draw the template (Glossy,
 * the Markdown download, an older reader) still draws the fence as an
 * ordinary diagram. The bars kind reads a subset of the `xychart` language
 * of its own (`bars.ts`), and the gantt kind one of the `gantt` language
 * (`gantt.ts`). The other templates read a small subset of the
 * flowchart language: a `flowchart`/`graph` header, node declarations, `-->` and
 * `-.->` edges (optionally `|labelled|` and chained), `class` lines, and
 * `subgraph … end` blocks without nesting. Labels are decoded the way the
 * Proposal templating writes them (`<br/>` splits lines, Mermaid and HTML
 * entity escapes are decoded, zero-width spaces are removed). Anything else
 * (another tag, a `click` line, an `%%{init}` directive, frontmatter, a
 * nested subgraph, a `url(` in a style line, an unknown statement) makes the
 * parser return null, and so does a model whose shape the requested
 * template cannot draw; the caller then draws the fence as Mermaid.
 *
 * A flowchart fence with no figure line at all whose graph is one plain
 * chain of seven steps or more draws as a numbered process too
 * (`figureKindOf`): the engine would draw it as a column too tall to print
 * legibly. Only the drawing changes; the fence keeps its Mermaid text.
 *
 * Every template is 662 px wide (the print column, so print never scales
 * it), sets no text below 12 px, carries `role="img"`, a `<title>` and a
 * `<desc>` that lists its content in reading order, and uses only the
 * elements and attributes the export's SVG cleaner keeps. Colours come in
 * as a {@link FigurePalette} the caller resolves from the theme; the output
 * is deterministic for the same input.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

import { barsFigureSvg, parseBarsSource } from "./bars";
import { ganttFigureSvg, parseGanttSource } from "./gantt";
import { layersFigureSvg } from "./layers";
import {
	FIGURE_LINE,
	type FigureKind,
	parseFigureSource,
	readFigureKind,
} from "./parse";
import { isPlainProcessChain, processFigureSvg } from "./process";
import type { FigureOptions, FigurePalette } from "./svg-text";
import { teamFigureSvg } from "./team";

export {
	type BarsEntry,
	type BarsModel,
	type BarsNumber,
	barsFigureSvg,
	barsOverGrey,
	parseBarsSource,
} from "./bars";
export {
	type GanttMilestone,
	type GanttModel,
	type GanttTask,
	ganttFigureSvg,
	parseGanttSource,
} from "./gantt";
export { layersFigureSvg } from "./layers";
export {
	FIGURE_KINDS,
	FIGURE_LINE,
	type FigureEdge,
	type FigureKind,
	type FigureModel,
	type FigureNode,
	type FigureSubgraph,
	isFigureKind,
	parseFigureSource,
	readFigureKind,
	withFigureKind,
} from "./parse";
export {
	INFERRED_PROCESS_MIN_STEPS,
	type ProcessFigureOptions,
	processFigureSvg,
} from "./process";
export {
	FIGURE_PALETTE_ROLES,
	FIGURE_WIDTH,
	type FigureOptions,
	type FigurePalette,
	FONT_SIZE as FIGURE_TEXT_PX,
} from "./svg-text";
export { teamFigureSvg } from "./team";

/**
 * The figure `kind` draws for a fence body or source, or null when the
 * parser or the kind's shape check refuses it and the fence should draw as
 * Mermaid. The kind picks the parser: bars read an xychart, gantt a gantt,
 * every other kind a flowchart.
 */
export function renderFigureSvg(
	kind: FigureKind,
	source: string,
	palette: FigurePalette,
	options: FigureOptions = {},
): string | null {
	if (kind === "bars") {
		const bars = parseBarsSource(source);
		return bars ? barsFigureSvg(bars, palette, options) : null;
	}
	if (kind === "gantt") {
		const gantt = parseGanttSource(source);
		return gantt ? ganttFigureSvg(gantt, palette, options) : null;
	}
	const model = parseFigureSource(source);
	if (!model) {
		return null;
	}
	switch (kind) {
		case "process":
			return processFigureSvg(model, palette, {
				...options,
				dated: false,
			});
		case "timeline":
			return processFigureSvg(model, palette, {
				...options,
				dated: true,
			});
		case "layers":
			return layersFigureSvg(model, palette, options);
		case "team":
			return teamFigureSvg(model, palette, options);
		default:
			return null;
	}
}

/**
 * The figure template a client Proposal draws a fence body with, on its
 * page, in the PDF and in the Word file alike: the kind its figure line
 * asks for; for a fence with no figure line at all, `process` when its
 * flowchart is one plain chain of at least `INFERRED_PROCESS_MIN_STEPS`
 * steps (`isPlainProcessChain`); else null. A figure line of any value
 * anywhere in the fence, `none` or one no template knows included, keeps
 * the fence as written.
 */
export function figureKindOf(source: string): FigureKind | null {
	const asked = readFigureKind(source);
	if (asked !== null) {
		return asked;
	}
	if (
		source.split(/\r\n?|\n/).some((line) => FIGURE_LINE.test(line.trim()))
	) {
		return null;
	}
	const model = parseFigureSource(source);
	return model && isPlainProcessChain(model) ? "process" : null;
}

/**
 * The figure template a fence body draws with (`figureKindOf`), or null when
 * it takes none, or the template refuses its source, the palette or the
 * options (a paint colour or id prefix it cannot use): the fence then draws
 * as Mermaid.
 */
export function tryRenderFigure(
	source: string,
	palette: FigurePalette,
	options: FigureOptions = {},
): string | null {
	const kind = figureKindOf(source);
	if (kind === null) {
		return null;
	}
	try {
		return renderFigureSvg(kind, source, palette, options);
	} catch {
		return null;
	}
}
