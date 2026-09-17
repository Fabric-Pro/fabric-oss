/**
 * Strip active content from tenant-authored frame HTML before it is
 * rendered for export.
 *
 * The PDF export renders `html` blocks verbatim in a real Chromium. That
 * page is rendered with JavaScript off, offline, with every request
 * aborted (see `generate-pdf.ts`), so nothing here can run or reach the
 * network even if it survives. This pass is the second layer: it removes
 * the constructs that would carry script or a network fetch so the
 * rendering surface stays inert even if a context option regresses.
 *
 * Deliberately small and conservative. It is not an HTML parser and does
 * not try to preserve every valid document; it removes whole elements that
 * have no place in a static export and neutralises inline handlers and
 * script URLs.
 */

/** Elements removed with their content: they carry script or fetch. */
const ELEMENTS_REMOVED_WITH_CONTENT = [
	"script",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"noscript",
	"template",
	"svg",
	"math",
];

/** Elements removed by their tags alone: they load, submit or redirect. */
const ELEMENTS_REMOVED_BY_TAG = ["link", "meta", "base", "form", "input"];

/** Attributes whose value is a URL and can therefore be `javascript:`. */
const URL_ATTRIBUTES = [
	"href",
	"src",
	"srcset",
	"action",
	"formaction",
	"xlink:href",
	"poster",
	"background",
	"data",
	"codebase",
	"cite",
	"longdesc",
	"usemap",
	"manifest",
];

function removeElementWithContent(html: string, tag: string): string {
	// Open tag through its matching close, case-insensitive, across lines.
	const paired = new RegExp(
		`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`,
		"gi",
	);
	// An unclosed opening tag would otherwise leave its body live.
	const dangling = new RegExp(`<${tag}\\b[^>]*>`, "gi");
	return html.replace(paired, "").replace(dangling, "");
}

function removeElementByTag(html: string, tag: string): string {
	return html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
}

/** `on*="..."`, `on*='...'` and bare `on*=value` handler attributes. */
function removeEventHandlers(html: string): string {
	return html.replace(
		/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
		"",
	);
}

/** Whitespace, control characters and numeric entities used to hide a scheme. */
function normalizeUrlValue(value: string): string {
	let out = "";
	for (const char of value.replace(/&#x?[0-9a-f]+;?/gi, "")) {
		// Drop every C0 control character and whitespace: browsers ignore
		// them inside a scheme, so `java\tscript:` still runs.
		if (char.charCodeAt(0) > 0x20) {
			out += char;
		}
	}
	return out.toLowerCase();
}

/** A URL attribute whose value runs script or embeds a document. */
function removeScriptUrls(html: string): string {
	const attributes = URL_ATTRIBUTES.join("|");
	return html.replace(
		new RegExp(
			`\\s+(?:${attributes})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
			"gi",
		),
		(match, dq: string | undefined, sq: string | undefined, bare) => {
			const value = normalizeUrlValue(dq ?? sq ?? bare ?? "");
			if (
				value.startsWith("javascript:") ||
				value.startsWith("vbscript:") ||
				value.startsWith("data:text/html") ||
				value.startsWith("data:image/svg")
			) {
				return "";
			}
			return match;
		},
	);
}

/** Inline styles that carry expressions or fetches. */
function removeActiveStyles(html: string): string {
	return html.replace(
		/\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
		(match, dq: string | undefined, sq: string | undefined) => {
			const value = (dq ?? sq ?? "").toLowerCase();
			if (
				value.includes("expression(") ||
				value.includes("javascript:") ||
				value.includes("url(")
			) {
				return "";
			}
			return match;
		},
	);
}

export function sanitizeFrameHtml(html: string): string {
	let out = html;
	for (const tag of ELEMENTS_REMOVED_WITH_CONTENT) {
		out = removeElementWithContent(out, tag);
	}
	for (const tag of ELEMENTS_REMOVED_BY_TAG) {
		out = removeElementByTag(out, tag);
	}
	out = removeEventHandlers(out);
	out = removeScriptUrls(out);
	out = removeActiveStyles(out);
	return out;
}
