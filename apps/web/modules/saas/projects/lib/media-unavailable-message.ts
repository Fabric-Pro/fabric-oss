/**
 * The one visual treatment for media a reader cannot see.
 *
 * Two unrelated failures land in a description and used to look like two
 * different products (Fizzy card 2027):
 *
 *  - the pull ingester could not download the file from the PM tool, so it
 *    substituted a bracketed text token (`media-import-placeholder-extension`);
 *  - the file is referenced but its `src` never resolves in the browser, so the
 *    picture would paint as a native broken icon (`image-load-fallback-extension`).
 *
 * A reader cannot perceive that distinction and should not have to. Both now
 * render this element, so they are one consistent state with one wording shape.
 *
 * Built as raw DOM rather than JSX because both callers are ProseMirror WIDGET
 * decorations — they hand ProseMirror a node, not a React tree. The icon is an
 * inline SVG (lucide `image-off`) rather than the emoji this replaced: an emoji
 * is rasterised per platform and ignores `currentColor`, so it could never sit
 * consistently beside the lucide icons used everywhere else in Fabric.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** lucide `image-off`, as [tag, attributes] so it can be built without innerHTML. */
const ICON_PARTS: ReadonlyArray<readonly [string, Record<string, string>]> = [
	["line", { x1: "2", x2: "22", y1: "2", y2: "22" }],
	["path", { d: "M10.41 10.41a2 2 0 1 1-2.83-2.83" }],
	["line", { x1: "13.5", x2: "6", y1: "13.5", y2: "21" }],
	["line", { x1: "18", x2: "21", y1: "12", y2: "15" }],
	[
		"path",
		{
			d: "M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59",
		},
	],
	["path", { d: "M21 15V5a2 2 0 0 0-2-2H9" }],
];

const ICON_ATTRS: Record<string, string> = {
	xmlns: SVG_NS,
	width: "16",
	height: "16",
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	"stroke-width": "2",
	"stroke-linecap": "round",
	"stroke-linejoin": "round",
	// Decorative: the adjacent text already carries the whole message.
	"aria-hidden": "true",
	focusable: "false",
	class: "media-unavailable-icon",
};

function buildIcon(): SVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	for (const [name, value] of Object.entries(ICON_ATTRS)) {
		svg.setAttribute(name, value);
	}
	for (const [tag, attrs] of ICON_PARTS) {
		const part = document.createElementNS(SVG_NS, tag);
		for (const [name, value] of Object.entries(attrs)) {
			part.setAttribute(name, value);
		}
		svg.appendChild(part);
	}
	return svg;
}

/**
 * Build the stand-in element for a piece of media the reader cannot see.
 *
 * `message` is remote-derived (a filename from a PM tool, or a provider label),
 * so it is written with `textContent` and never as markup.
 */
export function buildMediaUnavailableMessage(message: string): HTMLElement {
	const container = document.createElement("span");
	container.className = "media-unavailable";
	container.appendChild(buildIcon());

	const label = document.createElement("span");
	label.className = "media-unavailable-text";
	label.textContent = message;
	container.appendChild(label);

	return container;
}
