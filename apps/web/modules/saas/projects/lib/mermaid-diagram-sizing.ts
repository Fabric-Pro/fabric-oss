/**
 * How wide a diagram is drawn on a client-document Proposal's page, so its
 * labels stay readable (Fizzy #2946).
 *
 * The page used to shrink every diagram to the column (`max-width: 100%`).
 * A long timeline drawn at 1,400 px with 13 px labels then showed them at
 * about 6 px in a 640 px column. Here a diagram is shrunk only as far as its
 * smallest label stays at {@link MIN_DIAGRAM_LABEL_PX}; a diagram that would
 * need more keeps that width and scrolls sideways in its container.
 *
 * Pure, so the rule is tested without layout.
 */

/** The smallest a diagram's label is drawn on the page, in CSS px. */
export const MIN_DIAGRAM_LABEL_PX = 12;

export interface DiagramSizingInput {
	/** The SVG's own width, in px. */
	naturalWidth: number;
	/** The SVG's smallest label size at its own width, in px. */
	labelPx: number;
	/** The width the diagram has in its column, in px. */
	columnWidth: number;
	/** The smallest label size allowed; defaults to {@link MIN_DIAGRAM_LABEL_PX}. */
	minLabelPx?: number;
}

export interface DiagramSizing {
	/** The width to draw the diagram at, in px. */
	width: number;
	/** Wider than the column: its container scrolls sideways. */
	scrollable: boolean;
}

/**
 * The width a diagram is drawn at:
 * - one that fits its column keeps its own width;
 * - one shrunk to the column with labels still at the minimum fills it;
 * - any other is drawn so its smallest label is exactly the minimum, and
 *   scrolls when that is wider than the column.
 *
 * Unknown sizes (no layout yet, an SVG without a width) keep the natural
 * width and never scroll.
 */
export function diagramDisplayWidth({
	naturalWidth,
	labelPx,
	columnWidth,
	minLabelPx = MIN_DIAGRAM_LABEL_PX,
}: DiagramSizingInput): DiagramSizing {
	if (
		!(naturalWidth > 0) ||
		!(columnWidth > 0) ||
		!Number.isFinite(naturalWidth) ||
		!Number.isFinite(columnWidth)
	) {
		return { width: naturalWidth, scrollable: false };
	}
	const label =
		labelPx > 0 && Number.isFinite(labelPx) ? labelPx : minLabelPx;
	const fitScale = Math.min(1, columnWidth / naturalWidth);
	if (label * fitScale >= minLabelPx) {
		return { width: naturalWidth * fitScale, scrollable: false };
	}
	// The scale at which the smallest label is exactly the minimum; above 1
	// for a diagram whose labels are drawn smaller than that to begin with.
	const width = naturalWidth * (minLabelPx / label);
	return { width, scrollable: width > columnWidth };
}

/**
 * The width and smallest label size an SVG string declares: its `width`
 * attribute (or its viewBox) and its smallest `font-size`. Null when it
 * declares no width in px, as the mermaid.js fallback's `width="100%"`.
 */
export function readSvgNaturalSize(
	svg: string,
): { width: number; labelPx: number } | null {
	const open = /<svg\b[^>]*>/i.exec(svg)?.[0];
	if (!open) {
		return null;
	}
	const widthAttr = /\swidth="([0-9.]+)(px)?"/i.exec(open)?.[1];
	let width = widthAttr ? Number.parseFloat(widthAttr) : Number.NaN;
	if (!Number.isFinite(width)) {
		if (/\swidth="/i.test(open)) {
			return null;
		}
		const viewBox =
			/\sviewBox="[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)/i.exec(open)?.[1];
		width = viewBox ? Number.parseFloat(viewBox) : Number.NaN;
	}
	if (!(width > 0)) {
		return null;
	}
	const sizes = [...svg.matchAll(/font-size(?:="|:\s*)([0-9.]+)/gi)]
		.map((match) => Number.parseFloat(match[1] ?? ""))
		.filter((size) => size > 0);
	return {
		width,
		labelPx: sizes.length > 0 ? Math.min(...sizes) : MIN_DIAGRAM_LABEL_PX,
	};
}
