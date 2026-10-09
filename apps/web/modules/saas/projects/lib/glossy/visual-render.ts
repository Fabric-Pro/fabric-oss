"use client";

/**
 * Render Glossy visual specs into branded images (Fizzy #2589, KTD15).
 *
 * Timeline, flow, and org chart specs go through U5's Mermaid templates and
 * existing Mermaid is restyled as-is; both render with one engine,
 * mermaid.js under `renderThemedMermaidSvg`'s configuration. Stat and
 * comparison specs become U5's SVG cards. The templates emit color
 * placeholders that are filled here with validated palette values, and
 * everything is rasterized through `svgToPng`, so the preview, the PDF, and
 * the DOCX show the same pixels.
 *
 * A visual that cannot render is reported by key, never replaced by its
 * source or a text stand-in (R13, R20).
 */

import type { EditionVisual } from "@repo/utils/glossy/edition-content";
import {
	fillVisualColors,
	type GlossyPalette,
	glossyMermaidThemeVariables,
} from "@repo/utils/glossy/visual-colors";
import type { VisualSpec } from "@repo/utils/glossy/visual-spec";
import {
	SVG_CARD_FONT_STACK,
	visualSpecToMermaid,
	visualSpecToSvgCard,
} from "@repo/utils/glossy/visual-templates";
import { svgToPng } from "../document-export-helpers";
import {
	type MermaidExportTheme,
	renderMermaidToPng,
} from "../markdown-to-document";

// The placeholder fill lives in `@repo/utils/glossy/visual-colors`, so the
// worker filling a Proposal's visuals resolves colors exactly as this
// renderer does (Fizzy #2801).
export { fillVisualColors };

export interface RenderedGlossyVisual {
	/** PNG data URL. */
	dataUrl: string;
	/** Intrinsic size in CSS pixels; the PNG itself is drawn at twice this. */
	width: number;
	height: number;
}

export interface GlossyVisualFailure {
	visualKey: string;
	kind: string;
	/** `unsupported_kind` for a spec with no renderer (an unresolved `auto`). */
	reason: "unsupported_kind" | "render_failed";
}

export interface GlossyVisualRenderResult {
	images: Map<string, RenderedGlossyVisual>;
	failures: GlossyVisualFailure[];
}

export function glossyMermaidTheme(palette: GlossyPalette): MermaidExportTheme {
	return {
		themeVariables: glossyMermaidThemeVariables(palette),
		fontFamily: SVG_CARD_FONT_STACK,
	};
}

/** One spec to a PNG, or `null` when it cannot render. */
export async function renderGlossyVisual(
	spec: VisualSpec,
	palette: GlossyPalette,
): Promise<RenderedGlossyVisual | null> {
	try {
		switch (spec.kind) {
			case "timeline":
			case "flow":
			case "org_chart":
				return await renderMermaidToPng(
					fillVisualColors(visualSpecToMermaid(spec), palette),
					glossyMermaidTheme(palette),
				);
			case "existing_mermaid":
				return await renderMermaidToPng(
					spec.source,
					glossyMermaidTheme(palette),
				);
			case "stat":
			case "comparison":
				return await svgToPng(
					fillVisualColors(visualSpecToSvgCard(spec), palette),
				);
			default:
				return null;
		}
	} catch (error) {
		console.error("[Glossy] Visual render failed:", error);
		return null;
	}
}

/**
 * Render an edition's visuals one at a time (mermaid.js is a singleton),
 * skipping keys `include` rejects — discarded visuals, for example.
 */
export async function renderGlossyVisuals(
	visuals: Readonly<Record<string, EditionVisual>>,
	palette: GlossyPalette,
	include: (visualKey: string) => boolean = () => true,
): Promise<GlossyVisualRenderResult> {
	const images = new Map<string, RenderedGlossyVisual>();
	const failures: GlossyVisualFailure[] = [];
	for (const [visualKey, visual] of Object.entries(visuals)) {
		if (!include(visualKey)) {
			continue;
		}
		if (visual.spec.kind === "auto") {
			failures.push({
				visualKey,
				kind: visual.kind,
				reason: "unsupported_kind",
			});
			continue;
		}
		const image = await renderGlossyVisual(visual.spec, palette);
		if (image) {
			images.set(visualKey, image);
		} else {
			failures.push({
				visualKey,
				kind: visual.kind,
				reason: "render_failed",
			});
		}
	}
	return { images, failures };
}
