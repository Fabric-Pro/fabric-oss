import DOMPurify from "isomorphic-dompurify";

/**
 * Project-scoped frame rendering (inverted-loop plan, Slice 3 "Frame
 * rendering — prerequisite").
 *
 * Frames that carry a `projectId` are agent-authored from customer material
 * (spike demos). They are rendered in an iframe with `sandbox="allow-scripts"`
 * only — no `allow-same-origin` — so the document runs in an opaque origin and
 * cannot touch the host page, cookies or storage. On top of that the srcdoc
 * carries a Content-Security-Policy that denies every network fetch (images
 * and fonts must be data/blob URIs), and nested browsing contexts are stripped
 * so the sandbox cannot be escaped through a child frame.
 *
 * Non-project frames keep the historical renderer; see `FrameRenderer.tsx`.
 */

/** Sandbox attribute for project frames. Never add `allow-same-origin`. */
export const PROJECT_FRAME_SANDBOX = "allow-scripts";

/** CSP injected as the first child of `<head>`; must be a head child to apply. */
export const PROJECT_FRAME_CSP =
	"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";

/** postMessage type the injected resize script uses to report its height. */
export const PROJECT_FRAME_HEIGHT_MESSAGE = "fabric-project-frame:set-height";

/** Upper bound accepted from a height message; anything larger is clamped. */
export const PROJECT_FRAME_MAX_HEIGHT = 12000;

/** Elements that create a nested browsing context or rewrite document URLs. */
const FORBIDDEN_PROJECT_TAGS = [
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"portal",
	"base",
	"link",
	"meta",
];

const ALLOWED_TAGS = [
	"html",
	"head",
	"body",
	"title",
	"style",
	"script",
	"div",
	"span",
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"br",
	"hr",
	"a",
	"img",
	"svg",
	"path",
	"circle",
	"ellipse",
	"rect",
	"line",
	"polyline",
	"polygon",
	"g",
	"defs",
	"use",
	"text",
	"tspan",
	"clipPath",
	"linearGradient",
	"radialGradient",
	"stop",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"th",
	"td",
	"caption",
	"ul",
	"ol",
	"li",
	"dl",
	"dt",
	"dd",
	"b",
	"i",
	"u",
	"s",
	"strong",
	"em",
	"small",
	"big",
	"sub",
	"sup",
	"code",
	"pre",
	"kbd",
	"samp",
	"var",
	"mark",
	"ins",
	"del",
	"blockquote",
	"q",
	"cite",
	"abbr",
	"address",
	"time",
	"progress",
	"meter",
	"details",
	"summary",
	"figure",
	"figcaption",
	"canvas",
	"button",
	"input",
	"label",
	"select",
	"option",
	"optgroup",
	"textarea",
	"form",
	"fieldset",
	"legend",
	"header",
	"footer",
	"main",
	"section",
	"article",
	"aside",
	"nav",
	"template",
	"picture",
	"source",
	"video",
	"audio",
];

const ALLOWED_ATTR = [
	"class",
	"id",
	"style",
	"title",
	"alt",
	"src",
	"srcset",
	"href",
	"target",
	"rel",
	"width",
	"height",
	"viewBox",
	"preserveAspectRatio",
	"fill",
	"fill-opacity",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-dasharray",
	"opacity",
	"d",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"dx",
	"dy",
	"offset",
	"stop-color",
	"stop-opacity",
	"points",
	"transform",
	"text-anchor",
	"dominant-baseline",
	"font-size",
	"font-family",
	"font-weight",
	"xmlns",
	"version",
	"lang",
	"dir",
	"type",
	"role",
	"aria-*",
	"data-*",
	"for",
	"value",
	"placeholder",
	"checked",
	"selected",
	"disabled",
	"readonly",
	"multiple",
	"min",
	"max",
	"step",
	"pattern",
	"required",
	"name",
	"colspan",
	"rowspan",
	"scope",
	"open",
	"controls",
	"autoplay",
	"loop",
	"muted",
	"playsinline",
	"poster",
	"tabindex",
];

/**
 * Inside a `<script>` the only way to end the element is a literal
 * `</script` sequence. DOMPurify already re-parses and re-serialises the
 * document, so a breakout that was in the input has been parsed as markup and
 * sanitised. This guards the re-serialised text nonetheless: any `</script`
 * (any case, optional whitespace) still present in script text is escaped so
 * it can never close the element early inside the srcdoc.
 */
function neutraliseScriptText(text: string): string {
	return text.replace(/<\/(\s*script)/gi, "<\\/$1");
}

/**
 * The resize reporter runs inside the sandboxed document and posts the
 * rendered height to its parent. postMessage is not a network request, so
 * the CSP allows it; the parent verifies `event.source` before trusting it.
 */
const RESIZE_SCRIPT = `(function(){var h=0;function send(){var d=document.documentElement,b=document.body;var n=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0,b?b.offsetHeight:0);if(n>0&&n!==h){h=n;try{window.parent.postMessage({type:${JSON.stringify(PROJECT_FRAME_HEIGHT_MESSAGE)},height:n},"*")}catch(e){}}}if(typeof ResizeObserver==="function"&&document.body){new ResizeObserver(send).observe(document.body)}window.addEventListener("load",send);setTimeout(send,0);setTimeout(send,400);setTimeout(send,1200)})();`;

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Build the srcdoc for a project-scoped frame block.
 *
 * - Sanitises with a profile that forbids nested browsing contexts
 *   (`iframe`, `frame`, `object`, `embed`, `portal`) and URL-rewriting head
 *   elements (`base`, `link`, `meta`). Scripts and inline styles are kept —
 *   the sandbox and CSP are the isolation boundary, not the tag list.
 * - Rebuilds a full document so the CSP `<meta>` is the first child of
 *   `<head>` (a CSP meta outside `<head>` is ignored by browsers).
 * - Escapes any `</script` left inside script text.
 * - Appends the resize reporter as the last body child.
 */
export function buildProjectFrameSrcdoc(html: string): string {
	const sanitised = DOMPurify.sanitize(html ?? "", {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		FORBID_TAGS: FORBIDDEN_PROJECT_TAGS,
		ALLOW_DATA_ATTR: true,
		SANITIZE_DOM: true,
		WHOLE_DOCUMENT: true,
		RETURN_DOM: true,
	}) as unknown as Element;

	// Belt-and-braces: FORBID_TAGS already dropped these; make sure nothing
	// with a nested browsing context survived under a different parser path.
	for (const node of Array.from(
		sanitised.querySelectorAll(FORBIDDEN_PROJECT_TAGS.join(",")),
	)) {
		node.remove();
	}

	for (const script of Array.from(sanitised.querySelectorAll("script"))) {
		const text = script.textContent ?? "";
		const safe = neutraliseScriptText(text);
		if (safe !== text) {
			script.textContent = safe;
		}
	}

	const head = sanitised.querySelector("head");
	const body = sanitised.querySelector("body");
	const headHtml = head?.innerHTML ?? "";
	const bodyHtml = body?.innerHTML ?? "";

	return [
		"<!doctype html>",
		"<html>",
		"<head>",
		`<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(PROJECT_FRAME_CSP)}">`,
		'<meta charset="utf-8">',
		headHtml,
		"</head>",
		"<body>",
		bodyHtml,
		`<script>${RESIZE_SCRIPT}</script>`,
		"</body>",
		"</html>",
	].join("");
}

/** Type guard for the height message posted by the injected resize script. */
export function isProjectFrameHeightMessage(
	data: unknown,
): data is { type: typeof PROJECT_FRAME_HEIGHT_MESSAGE; height: number } {
	return (
		typeof data === "object" &&
		data !== null &&
		(data as { type?: unknown }).type === PROJECT_FRAME_HEIGHT_MESSAGE &&
		typeof (data as { height?: unknown }).height === "number" &&
		Number.isFinite((data as { height: number }).height)
	);
}
