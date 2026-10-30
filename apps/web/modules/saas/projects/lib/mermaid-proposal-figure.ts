import {
	type DiagramPrintability,
	diagramPrintability,
	figurePaletteOf,
} from "@repo/utils/proposal-artifact/diagram-printability";
import { tryRenderFigure } from "@repo/utils/proposal-artifact/proposal-figures";
import type { ProposalThemePaint } from "@repo/utils/proposal-artifact/theme-tokens";
import {
	readDiagramCaption,
	withDiagramCaption,
} from "@repo/utils/proposal-artifact/visual-identity";

/**
 * How a Proposal's diagram draws on its live page (Fizzy #2946): a fence
 * with a `%% figure:` line draws its SVG template, a fence the export
 * cannot draw is marked as staying out of the PDF, and a diagram takes a
 * figure number exactly when the export numbers it.
 */

/**
 * The narrowest a figure template is drawn on the live page, in CSS px:
 * its 12 px text stays at 10 px or more. A narrower column scrolls.
 */
export const FIGURE_MIN_LIVE_WIDTH = 550;

/** An id prefix the template accepts, from a React id (`:r1:`, `«r1»`). */
export function figureIdPrefix(reactId: string): string {
	return `figure-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * The unsanitized template SVG a fence asks for, or null when it asks for
 * none, or the template refuses its source or the palette: the fence then
 * draws as Mermaid.
 */
export function drawFigureTemplate(
	code: string,
	paint: ProposalThemePaint,
	idPrefix: string,
): string | null {
	return tryRenderFigure(code, figurePaletteOf(paint), {
		caption: readDiagramCaption(code),
		idPrefix,
	});
}

/**
 * What the export does with the fence (`diagram-printability.ts`), fed as
 * the export feeds it: without the caption line. The page numbers it and
 * notes it by that and by the engine that drew it.
 */
export function livePrintability(code: string): DiagramPrintability {
	return diagramPrintability(withDiagramCaption(code, null).trim());
}
