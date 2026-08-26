/**
 * Custom TipTap Image extension with S3 key tracking, centered display,
 * and optional caption support.
 *
 * Images are always displayed centered. Width can be set to 25%/50%/100%.
 * Caption is stored as a data-caption attribute and rendered as <figcaption>.
 */

import { mergeAttributes } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";

export const DocumentImage = Image.extend({
	name: "image",

	addAttributes() {
		return {
			...this.parent?.(),

			"data-s3-key": {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-s3-key"),
				renderHTML: (attributes: Record<string, unknown>) => {
					if (!attributes["data-s3-key"]) {
						return {};
					}
					return { "data-s3-key": attributes["data-s3-key"] };
				},
			},

			width: {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-width") ||
					element.getAttribute("width") ||
					element.style.width ||
					null,
				renderHTML: (attributes: Record<string, unknown>) => {
					if (!attributes.width) {
						return {};
					}
					// Store as data-width (not HTML width attr which expects pixels).
					// The actual CSS width is applied via inline style in renderHTML.
					return { "data-width": attributes.width };
				},
			},

			height: {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("height") ||
					element.style.height ||
					null,
				renderHTML: (attributes: Record<string, unknown>) => {
					if (!attributes.height) {
						return {};
					}
					return { height: attributes.height };
				},
			},

			caption: {
				default: null,
				parseHTML: (element: HTMLElement) => {
					const figure = element.closest("figure");
					const figcaption = figure?.querySelector("figcaption");
					return (
						figcaption?.textContent ||
						element.getAttribute("data-caption") ||
						null
					);
				},
				renderHTML: (attributes: Record<string, unknown>) => {
					if (!attributes.caption) {
						return {};
					}
					return { "data-caption": attributes.caption as string };
				},
			},
		};
	},

	renderHTML({ HTMLAttributes }) {
		const caption =
			HTMLAttributes["data-caption"] || HTMLAttributes.caption;

		// Always center images
		const {
			"data-caption": _dc,
			caption: _c,
			"data-align": _da,
			"data-width": dataWidth,
			...imgAttrs
		} = HTMLAttributes;

		const widthValue = dataWidth || imgAttrs.width || "";

		const figureAttrs = {
			class: "image-figure",
			style: "text-align: center; margin: 1rem 0;",
		};

		const imgTag = [
			"img",
			mergeAttributes(this.options.HTMLAttributes, {
				...imgAttrs,
				"data-width": widthValue || undefined,
				style: `display: block; margin: 0 auto; max-width: 100%;${widthValue ? ` width: ${widthValue};` : ""}`,
			}),
		] as const;

		if (caption) {
			return [
				"figure",
				figureAttrs,
				imgTag,
				["figcaption", { class: "image-caption-text" }, caption],
			];
		}

		// No caption — render figure without figcaption (caption can be added via toolbar)
		return ["figure", figureAttrs, imgTag];
	},

	parseHTML() {
		return [
			{
				tag: "figure img",
			},
			{
				tag: "img[src]",
			},
		];
	},
});
