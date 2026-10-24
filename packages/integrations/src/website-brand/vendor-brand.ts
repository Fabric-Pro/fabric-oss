/**
 * The organization's own website as a brand source (Fizzy #2946): the
 * colours the vendor declares, and nothing it merely uses.
 *
 * Declared means one of three places, in order: six-digit hex values written
 * in the visible text of the site's brand page, the home page's
 * `theme-color`, and the web app manifest's theme colour. A stylesheet
 * palette, an inline style, an SVG fill, a script constant or a logo's
 * dominant colour is never one, because an applied value should be a colour
 * the vendor published.
 *
 * The brand page is at most two candidates: `/brand`, then one link from
 * `/llms.txt` whose text or path names the brand. A candidate counts only
 * when its title or first heading names the brand or its colours, so a
 * single-page app answering `/brand` with its home page yields nothing.
 *
 * Every hop is HTTPS on the website's own host, redirects included, through
 * the same pinned fetch, caps and single deadline as `fetchWebsiteBrand`.
 * Nothing here calls a model, and no fetched text leaves this module: the
 * result is colours and a fixed code.
 */
import { normalizeHexColor, relativeLuminance } from "@repo/utils/brand-colors";
import type { BrandFetchFailureCode } from "@repo/utils/proposal-artifact/brand-sources";
import { decodeEntities, extractHeadCandidates } from "./extract-candidates";
import {
	createExtractionContext,
	type ExtractionContext,
	type FetchWebsiteBrandOptions,
	fetchFollowingRedirects,
	isPinnedSiteHost,
	parseWebsite,
	readManifest,
} from "./fetch-website-brand";

export type VendorBrandFailureCode = Extract<
	BrandFetchFailureCode,
	"unreachable" | "blocked" | "too_large" | "unsupported" | "no_colors"
>;

/** Where the applied colours were declared. */
export type VendorBrandSource = "brand_page" | "theme_color" | "manifest";

export type VendorBrandResult =
	| {
			ok: true;
			/** Lowercase `#rrggbb`. */
			primaryColor: string;
			/** Up to three lowercase `#rrggbb`, distinct from the primary. */
			accentColors: string[];
			source: VendorBrandSource;
	  }
	| { ok: false; code: VendorBrandFailureCode };

export type FetchVendorBrandOptions = FetchWebsiteBrandOptions;

const MAX_ACCENTS = 3;
const MAX_BRAND_PAGE_CANDIDATES = 2;

/** How much of a page is decoded; head and brand page alike. */
const PAGE_SCAN_MAX_BYTES = 512 * 1024;
/** A tag that does not close within this many characters ends the scan. */
const MAX_TAG_CHARS = 4096;
/** How much of a title or heading the brand-page check reads. */
const MAX_LABEL_CHARS = 1024;
/** Hex matches looked at on one page; a brand page lists a handful. */
const MAX_HEX_MATCHES = 512;
/** Links looked at in one `llms.txt`. */
const MAX_LLMS_LINKS = 256;

/** At or above this a colour cannot carry a heading on a white page. */
const NEAR_WHITE_MIN_LUMINANCE = 0.9;
/**
 * At or below this a colour reads as black text. Low enough that a deep
 * navy such as `#0a2540` (0.0176) stays a brand colour.
 */
const NEAR_BLACK_MAX_LUMINANCE = 0.01;
/** Below this spread between channels a colour is a grey. */
const GREY_MAX_CHROMA = 0.1;

/** A title or first heading that makes a page a brand page. */
const BRAND_PAGE_LABEL = /\bbrand|\bcolou?rs?\b|\bstyle[\s-]*guides?\b/i;
/** An `llms.txt` link that names the brand, by its text or its path. */
const BRAND_LINK = /\bbrand/i;

/**
 * Elements the browser ends at their first closing tag, skipped with their
 * content. `title` is read for the brand-page check but is not page text.
 */
const RAW_TEXT_ELEMENTS = new Set([
	"script",
	"style",
	"noscript",
	"title",
	"iframe",
	"noembed",
	"noframes",
	"xmp",
]);
/** Elements that may nest, skipped with everything inside them. */
const NESTED_HIDDEN_ELEMENTS = new Set(["svg", "math", "template", "object"]);
/** Foreign elements, where `/>` closes the element at once. */
const FOREIGN_ELEMENTS = new Set(["svg", "math"]);

const TAG_START = /^<(\/?)([A-Za-z][A-Za-z0-9:-]{0,63})/;
const HEADING = /^h[1-6]$/;
// Six digits only: a three-digit `#abc` in prose is too weak a declaration
// to apply (an issue number reads the same). Non-hex boundaries on both
// sides, so `#abcd`, `#0a2540ff` and `page#0a2540` are not read as colours.
const HEX_IN_TEXT = /(?<![0-9A-Za-z_&#])#([0-9A-Fa-f]{6})(?![0-9A-Za-z_])/g;
const MARKDOWN_LINK =
	/\[([^\]\n]{0,300})\]\(\s*<?([^\s()<>]{1,2048})>?(?:\s+"[^"\n]{0,300}")?\s*\)/g;
const BARE_URL = /\bhttps:\/\/[^\s<>()[\]"'`]{1,2048}/g;

function chroma(hex: string): number {
	const channels = [1, 3, 5].map((offset) =>
		Number.parseInt(hex.slice(offset, offset + 2), 16),
	);
	return (Math.max(...channels) - Math.min(...channels)) / 255;
}

/** A colour that can carry a brand: not near-white, near-black or grey. */
function isBrandColor(hex: string): boolean {
	const luminance = relativeLuminance(hex);
	return (
		luminance < NEAR_WHITE_MIN_LUMINANCE &&
		luminance > NEAR_BLACK_MAX_LUMINANCE &&
		chroma(hex) >= GREY_MAX_CHROMA
	);
}

function decodePage(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes.subarray(0, PAGE_SCAN_MAX_BYTES));
}

interface PageText {
	/** Visible text: no markup, attribute, comment or hidden element. */
	text: string;
	title: string | null;
	heading: string | null;
}

/** Index of the `>` that ends a tag, honouring quotes; -1 when none. */
function tagEnd(html: string, from: number): number {
	const limit = Math.min(html.length, from + MAX_TAG_CHARS);
	let quote: string | null = null;
	for (let index = from; index < limit; index++) {
		const character = html[index];
		if (quote) {
			if (character === quote) {
				quote = null;
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return index;
		}
	}
	return -1;
}

/** Where the element opened before `from` closes, counting nesting if asked. */
function findCloser(
	html: string,
	name: string,
	from: number,
	nested: boolean,
): { start: number; end: number } | null {
	const pattern = new RegExp(`<(/?)${name}\\b`, "gi");
	pattern.lastIndex = from;
	let depth = 1;
	for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
		if (match[1]) {
			depth--;
		} else if (nested) {
			depth++;
		}
		if (depth === 0) {
			const end = html.indexOf(">", pattern.lastIndex);
			return end === -1 ? null : { start: match.index, end: end + 1 };
		}
	}
	return null;
}

/**
 * A page's visible text, title and first heading. A bounded, linear scan
 * rather than a parser: whole tags are dropped (names and every attribute
 * value), comments and hidden elements are dropped with their content, and
 * anything malformed (an unclosed comment, tag or element) ends the scan, so
 * a page can only lose text this way, never gain it.
 */
function scanPage(html: string): PageText {
	const parts: string[] = [];
	let headingParts: string[] | null = null;
	let headingTag: string | null = null;
	let heading: string | null = null;
	let title: string | null = null;
	const emit = (raw: string) => {
		if (!raw) {
			return;
		}
		const text = decodeEntities(raw);
		parts.push(text);
		headingParts?.push(text);
	};

	let index = 0;
	while (index < html.length) {
		const open = html.indexOf("<", index);
		if (open === -1) {
			emit(html.slice(index));
			break;
		}
		emit(html.slice(index, open));
		if (html.startsWith("<!--", open)) {
			const end = html.indexOf("-->", open + 4);
			if (end === -1) {
				break;
			}
			index = end + 3;
			continue;
		}
		if (html[open + 1] === "!" || html[open + 1] === "?") {
			const end = html.indexOf(">", open);
			if (end === -1) {
				break;
			}
			index = end + 1;
			continue;
		}
		const tag = TAG_START.exec(html.slice(open, open + 66));
		if (!tag) {
			emit("<");
			index = open + 1;
			continue;
		}
		const end = tagEnd(html, open + tag[0].length);
		if (end === -1) {
			break;
		}
		const closing = tag[1] === "/";
		const name = (tag[2] ?? "").toLowerCase();
		index = end + 1;
		// A tag separates words, so `#0a2540<b>x</b>` cannot run together.
		parts.push(" ");
		headingParts?.push(" ");

		if (closing) {
			if (name === headingTag && headingParts) {
				heading = headingParts.join("").slice(0, MAX_LABEL_CHARS);
				headingParts = null;
				headingTag = null;
			}
			continue;
		}
		const selfClosingForeign =
			FOREIGN_ELEMENTS.has(name) && html[end - 1] === "/";
		if (
			RAW_TEXT_ELEMENTS.has(name) ||
			(NESTED_HIDDEN_ELEMENTS.has(name) && !selfClosingForeign)
		) {
			const closer = findCloser(
				html,
				name,
				index,
				NESTED_HIDDEN_ELEMENTS.has(name),
			);
			if (!closer) {
				break;
			}
			if (name === "title" && title === null) {
				title = decodeEntities(
					html.slice(
						index,
						Math.min(closer.start, index + MAX_LABEL_CHARS),
					),
				);
			}
			index = closer.end;
			continue;
		}
		if (heading === null && headingTag === null && HEADING.test(name)) {
			headingTag = name;
			headingParts = [];
		}
	}
	if (heading === null && headingParts) {
		heading = headingParts.join("").slice(0, MAX_LABEL_CHARS);
	}
	return { text: parts.join(""), title, heading };
}

/** The first chromatic hex values in visible text: a primary, then accents. */
function declaredColors(text: string): string[] {
	const colors: string[] = [];
	let seen = 0;
	for (const match of text.matchAll(HEX_IN_TEXT)) {
		if (++seen > MAX_HEX_MATCHES || colors.length > MAX_ACCENTS) {
			break;
		}
		const hex = normalizeHexColor(match[0]);
		if (hex && isBrandColor(hex) && !colors.includes(hex)) {
			colors.push(hex);
		}
	}
	return colors;
}

function isBrandPage(page: PageText): boolean {
	return [page.title, page.heading].some(
		(label) => label !== null && BRAND_PAGE_LABEL.test(label),
	);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

/**
 * The declared colours of one brand-page candidate, or none. The page must
 * be served from the website's host (every hop is pinned to it), must not be
 * the home page itself, and must name the brand in its title or first
 * heading.
 */
async function readBrandPage(
	url: string,
	home: { bytes: Uint8Array; finalUrl: URL },
	context: ExtractionContext,
): Promise<string[]> {
	const fetched = await fetchFollowingRedirects(url, "page", context);
	if (
		!fetched.ok ||
		!isPinnedSiteHost(
			fetched.finalUrl.hostname,
			context.pinnedHost ?? "",
		) ||
		fetched.finalUrl.pathname === "/" ||
		sameBytes(fetched.bytes, home.bytes)
	) {
		return [];
	}
	const page = scanPage(decodePage(fetched.bytes));
	return isBrandPage(page) ? declaredColors(page.text) : [];
}

function safeDecodePath(pathname: string): string {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return pathname;
	}
}

/**
 * One link from the site's `/llms.txt` whose text or path names the brand,
 * on the website's host. A file that is missing, refused, of another type or
 * over its cap counts as absent.
 */
async function readLlmsBrandLink(
	origin: string,
	skip: ReadonlySet<string>,
	context: ExtractionContext,
): Promise<string | null> {
	const fetched = await fetchFollowingRedirects(
		`${origin}/llms.txt`,
		"llms",
		context,
	);
	if (!fetched.ok) {
		return null;
	}
	const text = new TextDecoder().decode(fetched.bytes);
	const links: Array<{ label: string; href: string }> = [];
	for (const match of text.matchAll(MARKDOWN_LINK)) {
		links.push({ label: match[1] ?? "", href: match[2] ?? "" });
		if (links.length >= MAX_LLMS_LINKS) {
			break;
		}
	}
	for (const match of text.matchAll(BARE_URL)) {
		if (links.length >= MAX_LLMS_LINKS) {
			break;
		}
		links.push({ label: "", href: match[0] });
	}
	for (const link of links) {
		let url: URL;
		try {
			url = new URL(link.href, fetched.finalUrl);
		} catch {
			continue;
		}
		if (
			url.protocol !== "https:" ||
			!isPinnedSiteHost(url.hostname, context.pinnedHost ?? "") ||
			url.port !== "" ||
			url.username !== "" ||
			url.password !== ""
		) {
			continue;
		}
		url.hash = "";
		const href = url.toString();
		if (skip.has(href)) {
			continue;
		}
		if (
			BRAND_LINK.test(link.label) ||
			BRAND_LINK.test(safeDecodePath(url.pathname))
		) {
			return href;
		}
	}
	return null;
}

/**
 * Fetch the colours a vendor's website declares for its brand: the brand
 * page's visible six-digit hex values (the first as primary, the next three
 * as accents), else the home page's `theme-color`, else the manifest's theme
 * colour. Near-white, near-black and grey values are dropped at every tier.
 * `no_colors` when the site was read and declares none.
 */
export async function fetchVendorBrand(
	website: string,
	options: FetchVendorBrandOptions = {},
): Promise<VendorBrandResult> {
	const parsed = parseWebsite(website);
	if (!parsed.ok) {
		return { ok: false, code: parsed.code };
	}
	const origin = parsed.url;
	const context = createExtractionContext(
		options,
		new URL(origin).hostname.toLowerCase(),
	);

	const home = await fetchFollowingRedirects(origin, "page", context);
	if (!home.ok) {
		return { ok: false, code: home.code };
	}
	const head = extractHeadCandidates(decodePage(home.bytes), home.finalUrl);
	const manifest = head.manifestUrl
		? await readManifest(head.manifestUrl, context)
		: { icon: null, themeColors: [] };

	const brandPath = `${origin}/brand`;
	const llmsLink = await readLlmsBrandLink(
		origin,
		new Set([brandPath, `${brandPath}/`]),
		context,
	);
	const candidates = [brandPath, llmsLink]
		.filter((url): url is string => url !== null)
		.slice(0, MAX_BRAND_PAGE_CANDIDATES);
	for (const candidate of candidates) {
		const colors = await readBrandPage(candidate, home, context);
		const [primaryColor, ...accentColors] = colors;
		if (primaryColor) {
			return {
				ok: true,
				primaryColor,
				accentColors: accentColors.slice(0, MAX_ACCENTS),
				source: "brand_page",
			};
		}
	}

	const themeColor = head.themeColors.find(isBrandColor);
	if (themeColor) {
		return {
			ok: true,
			primaryColor: themeColor,
			accentColors: [],
			source: "theme_color",
		};
	}
	const manifestColor = manifest.themeColors.find(isBrandColor);
	if (manifestColor) {
		return {
			ok: true,
			primaryColor: manifestColor,
			accentColors: [],
			source: "manifest",
		};
	}
	return { ok: false, code: "no_colors" };
}
