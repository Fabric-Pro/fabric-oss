import DOMPurify from "isomorphic-dompurify";
import { FABRIC_RUNTIME_SCRIPT } from "./fabric-runtime-script";

/**
 * Project-scoped frame rendering (inverted-loop plan, Slice 3 "Frame
 * rendering — prerequisite").
 *
 * Frames that carry a `projectId` are agent-authored from customer material
 * (spike demos). They are rendered in an iframe sandboxed to scripts and forms
 * — never `allow-same-origin` — so the document runs in an opaque origin and
 * cannot touch the host page, cookies or storage. On top of that the srcdoc
 * carries a Content-Security-Policy that denies every network fetch (images
 * and fonts must be data/blob URIs), and nested browsing contexts are stripped
 * so the sandbox cannot be escaped through a child frame.
 *
 * That policy governs what the page loads, not where it goes: a page can still
 * navigate its own frame to another address with what it holds in the URL. The
 * frame is closed to that by the page that frames it, whose Content-Security-
 * Policy names what a frame may load (`FRAME_EMBED_PARENT_CSP` in `proxy.ts`),
 * so the two together are what keep a page from sending anything out.
 *
 * Non-project frames keep the historical renderer; see `FrameRenderer.tsx`.
 */

/**
 * Sandbox attribute for project frames. Never add `allow-same-origin`.
 *
 * `allow-forms` is there because without it the browser blocks a form's
 * submission before its `submit` event fires, so a page that saves through a
 * `<form>` handler silently never ran it. It opens no new way out: a submission
 * the page does not handle is a navigation of its own frame, which the framing
 * page's `frame-src` (`FRAME_EMBED_PARENT_CSP`) already confines exactly as it
 * confines `location = …` from the page's script.
 */
export const PROJECT_FRAME_SANDBOX = "allow-scripts allow-forms";

/**
 * CSP injected as the first child of `<head>`; must be a head child to apply.
 * `form-action` does not fall back to `default-src`, so it is named as well;
 * the framing page's `frame-src` remains the control a navigation answers to.
 */
export const PROJECT_FRAME_CSP =
	"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'";

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
	"maxlength",
	"minlength",
	"autocomplete",
	"inputmode",
	"size",
	"rows",
	"cols",
	"hidden",
	"label",
];

/**
 * Inside a `<script>` the only way to end the element is a literal
 * `</script` sequence. DOMPurify already re-parses and re-serialises the
 * document, so a breakout that was in the input has been parsed as markup and
 * sanitised. This guards the re-serialised text nonetheless: any `</script`
 * (any case, optional whitespace) still present in script text is escaped so
 * it can never close the element early inside the srcdoc.
 *
 * A `<script` opener in the text is escaped too, its first letter as a `\x`
 * escape (the same character inside a string or a regular expression): after a
 * `<!--`, the HTML parser stops treating the next `</script>` as the end of the
 * element, and the page's own script text is now kept as written, where the
 * sanitiser used to drop it.
 */
function neutraliseScriptText(text: string): string {
	return text
		.replace(/<\/(\s*script)/gi, "<\\/$1")
		.replace(
			/<(s)(cript)(?=[\s/>])/gi,
			(_match, first: string, rest: string) => {
				const code = first.charCodeAt(0).toString(16);
				return `<\\x${code}${rest}`;
			},
		);
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
 * An opening `<script …>` tag (quoted attribute values may hold a `>`) and the
 * text up to the first `</script` that the HTML parser would take as its end
 * tag (`</script` followed by whitespace, `/` or `>`), or the end of the input.
 */
const SCRIPT_ELEMENT_PATTERN =
	/(<script(?=[\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*>)([\s\S]*?)(?=<\/script[\s/>]|$)/gi;

function randomHex(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * DOMPurify removes any element with no element children whose text looks like
 * markup (`<li>`, `</div>`), which is every page script that builds HTML. The
 * page's scripts are the one thing this profile keeps on purpose, so each
 * script body is swapped for a placeholder that is unique to this call before
 * sanitising, and put back afterwards into the script element that kept it.
 */
function shieldScriptBodies(html: string): {
	shielded: string;
	bodies: Map<string, string>;
} {
	const token = `fabric-script-${randomHex()}`;
	const bodies = new Map<string, string>();
	const shielded = html.replace(
		SCRIPT_ELEMENT_PATTERN,
		(_match, open: string, body: string) => {
			if (body === "") {
				return open;
			}
			const placeholder = `${token}-${bodies.size}`;
			bodies.set(placeholder, body);
			return `${open}${placeholder}`;
		},
	);
	return { shielded, bodies };
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
 * - Defines the page runtime (`window.fabric`) right after it, ahead of every
 *   script of the page.
 * - Keeps the text of each page script as written, even when it holds markup
 *   such as `'<li>'` (see `shieldScriptBodies`).
 * - Escapes any `</script` left inside script text.
 * - Appends the resize reporter as the last body child.
 *
 * With `scripts: false` the page is drawn without a single script of its own,
 * and without the page runtime, which would have nothing to serve. That is how
 * a page an unattended run wrote is shown: such a run reads private data next
 * to data nobody vetted, and a script it was talked into writing must not run.
 */
export function buildProjectFrameSrcdoc(
	html: string,
	{ scripts = true }: { scripts?: boolean } = {},
): string {
	const forbiddenTags = scripts
		? FORBIDDEN_PROJECT_TAGS
		: [...FORBIDDEN_PROJECT_TAGS, "script"];
	const { shielded, bodies } = scripts
		? shieldScriptBodies(html ?? "")
		: { shielded: html ?? "", bodies: new Map<string, string>() };
	const sanitised = DOMPurify.sanitize(shielded, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		FORBID_TAGS: forbiddenTags,
		ALLOW_DATA_ATTR: true,
		// DOM clobbering protection removes an `id` or `name` that shadows a
		// document or form property (`title`, `submit`, `action`, …). The page
		// runs in an opaque-origin sandbox, so a clobbered name can only reach
		// the page's own script, and stripping it broke exactly that script:
		// `getElementById('title')` came back null and its save handler threw.
		SANITIZE_DOM: false,
		WHOLE_DOCUMENT: true,
		RETURN_DOM: true,
	}) as unknown as Element;

	// Belt-and-braces: FORBID_TAGS already dropped these; make sure nothing
	// with a nested browsing context survived under a different parser path.
	for (const node of Array.from(
		sanitised.querySelectorAll(forbiddenTags.join(",")),
	)) {
		node.remove();
	}

	for (const script of Array.from(sanitised.querySelectorAll("script"))) {
		const text = script.textContent ?? "";
		const safe = neutraliseScriptText(bodies.get(text) ?? text);
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
		scripts ? `<script>${FABRIC_RUNTIME_SCRIPT}</script>` : "",
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
