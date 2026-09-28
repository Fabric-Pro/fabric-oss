/**
 * Brand candidates from a website's `<head>` and web app manifest: icon
 * links, `og:image`, and `theme-color`.
 *
 * The page is untrusted, so this is a bounded scan rather than a parser:
 * only the first `HEAD_SCAN_MAX_CHARS` characters are read, the scan stops at
 * `</head>` or `<body>`, every tag pattern has a length ceiling so no input
 * can make a regex backtrack across the whole page, and comments, scripts and
 * styles are skipped so a `<link>` quoted inside them is not mistaken for a
 * real one. Nothing here fetches; URLs are resolved and returned as data.
 */
import { normalizeHexColor } from "@repo/utils/brand-colors";

/** How much of the decoded page is scanned for the head. */
export const HEAD_SCAN_MAX_CHARS = 256 * 1024;

/** A tag longer than this is skipped rather than scanned. */
const MAX_TAG_CHARS = 4096;

type LogoCandidateSource =
	| "apple-touch-icon"
	| "icon"
	| "manifest"
	| "og:image";

export interface LogoCandidate {
	url: string;
	source: LogoCandidateSource;
	/** Largest declared edge in pixels, or 0 when undeclared. */
	size: number;
}

export interface HeadCandidates {
	/** The largest raster apple-touch-icon. */
	appleTouchIcon: LogoCandidate | null;
	/** The largest raster `rel="icon"`. */
	icon: LogoCandidate | null;
	ogImage: LogoCandidate | null;
	manifestUrl: string | null;
	/** Every valid `theme-color`, normalized to `#rrggbb`, in page order. */
	themeColors: string[];
}

export interface ManifestCandidates {
	/** The largest raster manifest icon. */
	icon: LogoCandidate | null;
	themeColors: string[];
}

/** SVG can carry script and ICO is a container sharp cannot decode. */
const SKIPPED_TYPES = new Set([
	"image/svg+xml",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"image/ico",
	"image/icon",
]);
const SKIPPED_EXTENSION = /\.(svgz?|ico)$/i;

// One alternation per token the scan cares about. The attribute runs are
// capped, so a tag with no closing `>` costs at most MAX_TAG_CHARS per
// attempt instead of a scan to the end of the page.
const TOKEN = new RegExp(
	`<!--|<\\/head\\b|<body\\b|<(script|style|noscript|template)\\b[^>]{0,${MAX_TAG_CHARS}}>|<(link|meta)\\b([^>]{0,${MAX_TAG_CHARS}})>`,
	"gi",
);
const ATTRIBUTE =
	/([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENTITY = /&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|quot|apos|lt|gt);/gi;
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	quot: '"',
	apos: "'",
	lt: "<",
	gt: ">",
};

function decodeEntities(value: string): string {
	return value.replace(ENTITY, (match, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower.startsWith("#")) {
			const codePoint = lower.startsWith("#x")
				? Number.parseInt(lower.slice(2), 16)
				: Number.parseInt(lower.slice(1), 10);
			return codePoint > 0 && codePoint <= 0x10ffff
				? String.fromCodePoint(codePoint)
				: match;
		}
		return NAMED_ENTITIES[lower] ?? match;
	});
}

function parseAttributes(source: string): Map<string, string> {
	const attributes = new Map<string, string>();
	for (const match of source.matchAll(ATTRIBUTE)) {
		const name = match[1]?.toLowerCase();
		// HTML keeps the first of duplicated attributes.
		if (!name || attributes.has(name)) {
			continue;
		}
		const raw = match[2] ?? match[3] ?? match[4] ?? "";
		attributes.set(name, decodeEntities(raw).trim());
	}
	return attributes;
}

function resolveHttpUrl(href: string, base: URL): string | null {
	if (!href) {
		return null;
	}
	try {
		const url = new URL(href, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return null;
		}
		url.hash = "";
		return url.toString();
	} catch {
		return null;
	}
}

/** Largest declared edge in a `sizes` value, 0 when none; `any` marks a vector. */
function parseSizes(value: string | undefined): {
	size: number;
	vector: boolean;
} {
	let size = 0;
	let vector = false;
	for (const token of (value ?? "").toLowerCase().split(/\s+/)) {
		if (token === "any") {
			vector = true;
			continue;
		}
		const match = /^(\d{1,5})x(\d{1,5})$/.exec(token);
		if (match) {
			size = Math.max(size, Number(match[1]), Number(match[2]));
		}
	}
	return { size, vector };
}

function toRasterCandidate(
	href: string | undefined,
	base: URL,
	source: LogoCandidateSource,
	type: string | undefined,
	sizes: string | undefined,
): LogoCandidate | null {
	const url = resolveHttpUrl(href ?? "", base);
	if (!url) {
		return null;
	}
	const declared = parseSizes(sizes);
	if (
		declared.vector ||
		SKIPPED_TYPES.has((type ?? "").toLowerCase().trim()) ||
		SKIPPED_EXTENSION.test(new URL(url).pathname)
	) {
		return null;
	}
	return { url, source, size: declared.size };
}

/** The largest candidate; the earliest wins a tie. */
function largest(candidates: LogoCandidate[]): LogoCandidate | null {
	let best: LogoCandidate | null = null;
	for (const candidate of candidates) {
		if (!best || candidate.size > best.size) {
			best = candidate;
		}
	}
	return best;
}

function pushUnique(list: string[], value: string | null): void {
	if (value && !list.includes(value)) {
		list.push(value);
	}
}

/**
 * Scan a page's head. `baseUrl` is the URL the page was finally served from,
 * after redirects, so relative references resolve the way a browser would.
 */
export function extractHeadCandidates(
	html: string,
	baseUrl: string | URL,
): HeadCandidates {
	const base = new URL(baseUrl);
	const source = html.slice(0, HEAD_SCAN_MAX_CHARS);
	const appleTouchIcons: LogoCandidate[] = [];
	const icons: LogoCandidate[] = [];
	const themeColors: string[] = [];
	let ogImage: LogoCandidate | null = null;
	let manifestUrl: string | null = null;

	const token = new RegExp(TOKEN.source, TOKEN.flags);
	let match = token.exec(source);
	while (match) {
		const [whole, skippedElement, tagName, rawAttributes] = match;
		const lowerWhole = whole.toLowerCase();
		if (lowerWhole.startsWith("</head") || lowerWhole.startsWith("<body")) {
			break;
		}
		if (whole === "<!--") {
			const end = source.indexOf("-->", token.lastIndex);
			if (end === -1) {
				break;
			}
			token.lastIndex = end + 3;
		} else if (skippedElement) {
			const closer = new RegExp(`</${skippedElement}\\b`, "gi");
			closer.lastIndex = token.lastIndex;
			const close = closer.exec(source);
			if (!close) {
				break;
			}
			const end = source.indexOf(">", closer.lastIndex);
			if (end === -1) {
				break;
			}
			token.lastIndex = end + 1;
		} else if (tagName) {
			const attributes = parseAttributes(rawAttributes ?? "");
			if (tagName.toLowerCase() === "link") {
				const rel = (attributes.get("rel") ?? "")
					.toLowerCase()
					.split(/\s+/);
				const href = attributes.get("href");
				const type = attributes.get("type");
				const sizes = attributes.get("sizes");
				if (
					rel.includes("apple-touch-icon") ||
					rel.includes("apple-touch-icon-precomposed")
				) {
					const candidate = toRasterCandidate(
						href,
						base,
						"apple-touch-icon",
						type,
						sizes,
					);
					if (candidate) {
						appleTouchIcons.push(candidate);
					}
				} else if (rel.includes("icon")) {
					const candidate = toRasterCandidate(
						href,
						base,
						"icon",
						type,
						sizes,
					);
					if (candidate) {
						icons.push(candidate);
					}
				}
				if (rel.includes("manifest") && !manifestUrl) {
					manifestUrl = resolveHttpUrl(href ?? "", base);
				}
			} else {
				const name = (
					attributes.get("name") ??
					attributes.get("property") ??
					""
				).toLowerCase();
				const content = attributes.get("content");
				if (name === "theme-color") {
					pushUnique(themeColors, normalizeHexColor(content));
				} else if (name === "og:image" && !ogImage) {
					ogImage = toRasterCandidate(
						content,
						base,
						"og:image",
						undefined,
						undefined,
					);
				}
			}
		}
		match = token.exec(source);
	}

	return {
		appleTouchIcon: largest(appleTouchIcons),
		icon: largest(icons),
		ogImage,
		manifestUrl,
		themeColors,
	};
}

/**
 * Read a parsed web app manifest. Icon `src` values resolve against the
 * manifest's own URL, as the manifest specification requires.
 */
export function extractManifestCandidates(
	manifest: unknown,
	manifestUrl: string | URL,
): ManifestCandidates {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		return { icon: null, themeColors: [] };
	}
	const base = new URL(manifestUrl);
	const record = manifest as Record<string, unknown>;
	const themeColors: string[] = [];
	pushUnique(themeColors, normalizeHexColor(record.theme_color));

	const icons: LogoCandidate[] = [];
	const declared = Array.isArray(record.icons) ? record.icons : [];
	// A manifest is capped in bytes by the fetch; this caps the work per entry.
	for (const entry of declared.slice(0, 64)) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const icon = entry as Record<string, unknown>;
		const purposes =
			typeof icon.purpose === "string"
				? icon.purpose.trim().toLowerCase().split(/\s+/)
				: [];
		// A monochrome-only icon is a silhouette meant for tinting, not a logo.
		if (purposes.length > 0 && purposes.every((p) => p === "monochrome")) {
			continue;
		}
		const candidate = toRasterCandidate(
			typeof icon.src === "string" ? icon.src : undefined,
			base,
			"manifest",
			typeof icon.type === "string" ? icon.type : undefined,
			typeof icon.sizes === "string" ? icon.sizes : undefined,
		);
		if (candidate) {
			icons.push(candidate);
		}
	}
	return { icon: largest(icons), themeColors };
}

/**
 * The logo candidates to try, in order: the apple-touch-icon, the largest
 * sized icon, the largest manifest icon, then `og:image`. Each source offers
 * its single best entry so one source cannot use up the whole budget.
 */
export function orderLogoCandidates(
	sources: {
		appleTouchIcon: LogoCandidate | null;
		icon: LogoCandidate | null;
		manifestIcon: LogoCandidate | null;
		ogImage: LogoCandidate | null;
	},
	max: number,
): LogoCandidate[] {
	const ordered: LogoCandidate[] = [];
	for (const candidate of [
		sources.appleTouchIcon,
		sources.icon,
		sources.manifestIcon,
		sources.ogImage,
	]) {
		if (candidate && !ordered.some((c) => c.url === candidate.url)) {
			ordered.push(candidate);
		}
	}
	return ordered.slice(0, max);
}
