/**
 * Link destinations in scraped Markdown, for path-prefix crawl discovery.
 *
 * A crawl that has no page listing (Cloudflare Browser Rendering) finds
 * its pages by following links in each scraped page. Providers return
 * those links as the page wrote them, often relative (`/docs/a`, `../b`),
 * so this reads the Markdown with a CommonMark + GFM parser and resolves
 * every destination against the page's own URL. The scraped Markdown is
 * only read here, never rewritten.
 *
 * Read from the syntax tree, so:
 *  - inline links, reference definitions (`[id]: dest`), `<…>` autolinks
 *    and GFM autolink literals (`https://…`, `www.…`) count;
 *  - text inside code spans, fenced or indented code, raw HTML and link
 *    titles does not;
 *  - titles, `<…>` destinations, backslash escapes and balanced
 *    parentheses are handled by the parser, not by pattern matching.
 *
 * GFM resolves a bare `www.` literal with `http:`. When its host is the
 * page's own host, it takes the page's scheme instead, so a crawl of an
 * https site does not drop it as cross-origin.
 *
 * Images are not pages and are skipped, including reference definitions
 * that only images use. Only http(s) destinations are
 * kept, fragments are stripped, and fragment-only or empty destinations
 * (the page itself) are dropped. Output is deduplicated in document
 * order.
 *
 * Not re-exported from any activities barrel: every export reachable from
 * `activities/index.ts` becomes a schedulable activity.
 */
import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Parse-only processor, built once. `parse` runs the parser (with GFM's
// syntax extensions) without any transformer.
const processor = unified().use(remarkParse).use(remarkGfm);

type Collected =
	| { kind: "link"; url: string; wwwLiteral: boolean }
	| { kind: "definition"; url: string; identifier: string };

interface Collection {
	/** Inline links and reference definitions, in document order. */
	entries: Collected[];
	/** Definition identifiers used by a normal link reference. */
	linkRefs: Set<string>;
	/** Definition identifiers used by an image reference. */
	imageRefs: Set<string>;
}

/**
 * Whether a link node is a GFM `www.` autolink literal: its source text
 * starts with `www.`, which no inline link (`[`), CommonMark autolink
 * (`<`) or scheme literal (`http`) can.
 */
function isWwwLiteral(node: Nodes, markdown: string): boolean {
	const offset = node.position?.start.offset;
	return (
		offset !== undefined &&
		markdown.slice(offset, offset + 4).toLowerCase() === "www."
	);
}

function collectDestinations(
	node: Nodes,
	markdown: string,
	out: Collection,
): void {
	switch (node.type) {
		case "link":
			out.entries.push({
				kind: "link",
				url: node.url,
				wwwLiteral: isWwwLiteral(node, markdown),
			});
			break;
		case "definition":
			out.entries.push({
				kind: "definition",
				url: node.url,
				identifier: node.identifier,
			});
			break;
		case "linkReference":
			out.linkRefs.add(node.identifier);
			break;
		case "imageReference":
			out.imageRefs.add(node.identifier);
			break;
		// Leaves whose text must never be read as a link.
		case "code":
		case "inlineCode":
		case "html":
			return;
		default:
			break;
	}
	if ("children" in node) {
		for (const child of node.children) {
			collectDestinations(child, markdown, out);
		}
	}
}

function resolveDestination(
	destination: string,
	pageUrl: URL,
	wwwLiteral: boolean,
): string | null {
	const trimmed = destination.trim();
	if (trimmed === "" || trimmed.startsWith("#")) {
		return null;
	}
	let resolved: URL;
	try {
		resolved = new URL(trimmed, pageUrl);
	} catch {
		return null;
	}
	if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
		return null;
	}
	if (wwwLiteral && resolved.host === pageUrl.host) {
		resolved.protocol = pageUrl.protocol;
	}
	resolved.hash = "";
	return resolved.toString();
}

/**
 * Every http(s) link destination in `markdown`, resolved against
 * `pageUrl`, without fragments, deduplicated in document order. Returns
 * an empty list when `pageUrl` is not an absolute URL.
 */
export function extractMarkdownLinkDestinations(
	markdown: string,
	pageUrl: string,
): string[] {
	let page: URL;
	try {
		page = new URL(pageUrl);
	} catch {
		return [];
	}

	const tree = processor.parse(markdown) as Root;
	const collection: Collection = {
		entries: [],
		linkRefs: new Set(),
		imageRefs: new Set(),
	};
	collectDestinations(tree, markdown, collection);
	// A definition used only by images (`![logo][img]`) names an image,
	// not a page. One also used by a normal link, or by nothing, is kept.
	const destinations = collection.entries
		.filter(
			(entry) =>
				entry.kind === "link" ||
				collection.linkRefs.has(entry.identifier) ||
				!collection.imageRefs.has(entry.identifier),
		)
		.map((entry) => ({
			url: entry.url,
			wwwLiteral: entry.kind === "link" && entry.wwwLiteral,
		}));

	const out: string[] = [];
	const seen = new Set<string>();
	for (const destination of destinations) {
		const resolved = resolveDestination(
			destination.url,
			page,
			destination.wwwLiteral,
		);
		if (resolved === null || seen.has(resolved)) {
			continue;
		}
		seen.add(resolved);
		out.push(resolved);
	}
	return out;
}
