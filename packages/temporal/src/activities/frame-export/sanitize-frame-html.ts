/**
 * Strip active markup from tenant-authored frame HTML before it is
 * rendered for export.
 *
 * The PDF export renders `html` blocks in a real Chromium. The control is
 * that render context, not this filter: JavaScript off, offline, service
 * workers blocked, and every request the page makes aborted
 * (`PDF_EXPORT_CONTEXT_OPTIONS` and the catch-all route in
 * `generate-pdf.ts`). This pass is defence in depth for markup: it removes
 * script-bearing and loading elements, event handlers, and script or
 * document URLs, so those stay out of the page even if a context option
 * regresses. It runs over the joined blocks, the fragment that reaches the
 * page, because a construct can be split across two blocks.
 *
 * CSS is not sanitised. `<style>` content is kept as written, and nothing
 * reads CSS escapes (`\75rl(`), `image-set()` or `@import`. The one style
 * check — an inline `style` whose decoded text literally contains `url(`,
 * `expression(` or `javascript:` is removed — is best effort. Whatever CSS
 * asks to fetch is stopped by the render context.
 *
 * Deliberately small and conservative. It is not an HTML parser and does
 * not try to preserve every valid document; it removes whole elements that
 * have no place in a static export and neutralises inline handlers and
 * script URLs.
 *
 * Every pattern here runs over a whole block of tenant HTML, so each is
 * linear in its length: no pattern starts with a quantifier that a failed
 * match retries from every position, and no tag scan restarts once it has
 * run off the end of the block (CodeQL js/polynomial-redos).
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

/**
 * Where an attribute name can start inside a tag: after whitespace, after
 * the `/` of `<img/onerror=…>`, or straight after a quoted value, since a
 * browser reads `<img src="x"onerror=…>` as two attributes. The whitespace
 * arm only starts at the beginning of its run, so a long run is scanned once
 * rather than once per position, and a match still removes the whole run.
 */
const ATTRIBUTE_START = String.raw`(?:(?<!\s)\s+|(?<=[/"']))`;

/** `="…"`, `='…'` or a bare value; the three captures are the value. */
const ATTRIBUTE_VALUE = String.raw`\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`;

/** `on*="..."`, `on*='...'` and bare `on*=value` handler attributes. */
const EVENT_HANDLER = new RegExp(
	`${ATTRIBUTE_START}on[a-z0-9_-]+${ATTRIBUTE_VALUE}`,
	"gi",
);

const URL_ATTRIBUTE = new RegExp(
	`${ATTRIBUTE_START}(?:${URL_ATTRIBUTES.join("|")})${ATTRIBUTE_VALUE}`,
	"gi",
);

const STYLE_ATTRIBUTE = new RegExp(
	`${ATTRIBUTE_START}style${ATTRIBUTE_VALUE}`,
	"gi",
);

/**
 * The raster image types a `data:` URL may keep. Any other `data:` URL can
 * carry a document or a script (`text/html`, `image/svg+xml`,
 * `application/xhtml+xml`, …), so it is removed like `javascript:`.
 */
const INERT_DATA_URL =
	/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)[;,]/;

/**
 * How many passes the sanitiser takes before giving up on a block. A pass
 * only removes, so another is needed only when a removal joined the text on
 * either side into something new — `<scr<script>ipt>`, or
 * `o onx="1"nerror=` becoming `onerror=`. Real frame HTML settles in two or
 * three; a block still changing after this many was built to get past the
 * filter.
 */
const MAX_SANITIZE_PASSES = 10;

/**
 * Removes every `<tag …>…</tag>` element with its content, then any opening
 * tag of it that is left.
 *
 * The pairing is scanned by hand. `/<tag\b[^>]*>[\s\S]*?<\/tag\s*>/g`
 * rescanned to the end of the block for every opening tag with no `>`, or
 * no close, after it — quadratic on a block of repeated opening tags. Once
 * one opening tag has neither, no later one can, so the scan stops there;
 * what it removes is exactly what that pattern removed.
 */
function removeElementWithContent(html: string, tag: string): string {
	const open = new RegExp(`<${tag}\\b`, "gi");
	const close = new RegExp(`<\\/${tag}\\s*>`, "gi");
	let out = "";
	let kept = 0;
	for (let start = open.exec(html); start; start = open.exec(html)) {
		const openEnd = html.indexOf(">", open.lastIndex);
		if (openEnd === -1) {
			break;
		}
		close.lastIndex = openEnd + 1;
		if (!close.exec(html)) {
			break;
		}
		out += html.slice(kept, start.index);
		kept = close.lastIndex;
		open.lastIndex = kept;
	}
	// An unclosed opening tag would otherwise leave its body live.
	return removeTags(out + html.slice(kept), `<${tag}\\b`);
}

function removeElementByTag(html: string, tag: string): string {
	return removeTags(html, `<\\/?${tag}\\b`);
}

/**
 * Removes each tag starting with `start` through its `>`. A tag with no `>`
 * runs to the end of the block and goes with it: left in place it would take
 * the markup that follows the block as its attributes.
 */
function removeTags(html: string, start: string): string {
	return html.replace(new RegExp(`${start}[^>]*(?:>|$)`, "gi"), "");
}

/**
 * Decode the character references a browser decodes in an attribute value
 * that can spell part of a URL scheme, or of the literal `url(` the style
 * check looks for: numeric ones, and the named `&colon;`, `&Tab;` and
 * `&NewLine;`. Case-insensitive on purpose — it can only make a check
 * stricter.
 */
function decodeCharacterReferences(value: string): string {
	return value.replace(
		/&#(?:x([0-9a-f]+)|(\d+));?|&(colon|tab|newline);/gi,
		(_match, hex: string | undefined, dec: string | undefined, named) => {
			if (named) {
				const lower = named.toLowerCase();
				return lower === "colon" ? ":" : lower === "tab" ? "\t" : "\n";
			}
			const code = hex ? Number.parseInt(hex, 16) : Number(dec);
			return code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: "�";
		},
	);
}

/**
 * A URL attribute's value as the browser reads its scheme: references
 * decoded, then every C0 control and space dropped — browsers ignore them
 * inside a scheme, so `java&#x09;script:` still runs — and lower-cased.
 */
function normalizeUrlValue(value: string): string {
	let out = "";
	for (const char of decodeCharacterReferences(value)) {
		if (char.charCodeAt(0) > 0x20) {
			out += char;
		}
	}
	return out.toLowerCase();
}

/** A URL that runs script or loads a document, rather than showing an image or linking out. */
function isActiveUrl(value: string): boolean {
	if (value.startsWith("javascript:") || value.startsWith("vbscript:")) {
		return true;
	}
	return value.startsWith("data:") && !INERT_DATA_URL.test(value);
}

/** One pass of everything except handler removal, which `sanitizeFrameHtml` repeats on its own. */
function sanitizeOnce(html: string): string {
	let out = html;
	for (const tag of ELEMENTS_REMOVED_WITH_CONTENT) {
		out = removeElementWithContent(out, tag);
	}
	for (const tag of ELEMENTS_REMOVED_BY_TAG) {
		out = removeElementByTag(out, tag);
	}
	out = out.replace(
		URL_ATTRIBUTE,
		(match, dq: string | undefined, sq: string | undefined, bare) =>
			isActiveUrl(normalizeUrlValue(dq ?? sq ?? bare ?? "")) ? "" : match,
	);
	// Best effort only: an inline style whose decoded text literally names
	// `url(`, `expression(` or `javascript:`. CSS escapes, `image-set()` and
	// `<style>` content get past it; the render context stops their fetches.
	out = out.replace(
		STYLE_ATTRIBUTE,
		(match, dq: string | undefined, sq: string | undefined, bare) => {
			const value = decodeCharacterReferences(
				dq ?? sq ?? bare ?? "",
			).toLowerCase();
			return value.includes("expression(") ||
				value.includes("javascript:") ||
				value.includes("url(")
				? ""
				: match;
		},
	);
	return out;
}

/**
 * Sanitise until nothing changes. Removing one construct can join its
 * neighbours into another, so a single pass is not enough; handler removal
 * is repeated on its own output before the other removals run again.
 * A block that is still changing after `MAX_SANITIZE_PASSES` is dropped
 * whole rather than exported half-sanitised.
 */
export function sanitizeFrameHtml(html: string): string {
	let out = html;
	for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass++) {
		const withoutHandlers = out.replace(EVENT_HANDLER, "");
		if (withoutHandlers !== out) {
			out = withoutHandlers;
			continue;
		}
		const next = sanitizeOnce(out);
		if (next === out) {
			return out;
		}
		out = next;
	}
	return "";
}
