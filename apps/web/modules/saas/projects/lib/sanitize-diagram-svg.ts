import DOMPurify from "dompurify";
import {
	cleanDiagramStylesheet,
	isInertDiagramAttribute,
} from "./diagram-svg-url-guard";

export function sanitizeDiagramSvg(dirty: string): string {
	return diagramPurifier().sanitize(dirty, {
		USE_PROFILES: { svg: true, svgFilters: true },
		// The SVG profile drops `role`, an HTML attribute; a figure template
		// names itself an image with it, and it carries no behaviour.
		ADD_ATTR: ["role"],
	});
}

let purifier: typeof DOMPurify | null = null;

/** The diagram sanitizer's own DOMPurify, made on first use in the browser. */
function diagramPurifier(): typeof DOMPurify {
	if (purifier === null) {
		const instance = DOMPurify();
		instance.addHook("uponSanitizeElement", (node, data) => {
			if (data.tagName === "style") {
				node.textContent = cleanDiagramStylesheet(
					node.textContent ?? "",
				);
			}
		});
		instance.addHook("uponSanitizeAttribute", (node, data) => {
			if (
				!isInertDiagramAttribute(
					node.nodeName,
					data.attrName,
					data.attrValue,
				)
			) {
				data.keepAttr = false;
			}
		});
		purifier = instance;
	}
	return purifier;
}
