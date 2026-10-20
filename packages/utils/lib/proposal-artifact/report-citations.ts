/**
 * The citation scan for a Proposal analysis report rendered as Markdown
 * (Fizzy #2946).
 *
 * A report cites its sources as `[S<N>]`. Read from the parsed tree, a
 * marker counts only where the report view turns it into a citation: in a
 * text node outside any link or link reference the model wrote, so not in
 * inline or fenced code, raw HTML, a link's text or destination, a reference
 * definition or a footnote label. The view's remark plugin skips the same
 * nodes, so a source is listed only for a marker the view shows as a chip.
 *
 * Precondition: callers parse only a report that
 * `reportTextNeedsPlainText` let through, since the parser overflows the
 * stack or runs for seconds on hostile text, and still wrap the call in
 * try/catch, falling back to `scanReportCitationsLinear`.
 */

import type { Nodes } from "mdast";
import { parseMarkdownAst } from "./markdown-ast";
import {
	REPORT_CITATION_MARKER_SOURCE,
	REPORT_CITATION_SCAN_MAX_MARKERS,
} from "./report-text";

const CITATION_MARKER = new RegExp(REPORT_CITATION_MARKER_SOURCE, "g");

/**
 * Nodes whose subtree is not read: a link or link reference the model wrote,
 * whose text the view renders without chips. Code, inline code and raw HTML
 * carry `value`, not children, and a definition or footnote reference has
 * neither, so the walk never reads them anyway.
 */
const SKIPPED_NODE_TYPES: ReadonlySet<string> = new Set([
	"link",
	"linkReference",
]);

/**
 * The source numbers cited as `[S<N>]` in the text nodes of `text`'s
 * Markdown tree, unique and ascending. Text nodes are read in document
 * order, and the scan stops after `maxMarkers` markers, repeats included.
 */
export function scanReportCitations(
	text: string,
	maxMarkers = REPORT_CITATION_SCAN_MAX_MARKERS,
): number[] {
	const found = new Set<number>();
	if (maxMarkers <= 0) {
		return [];
	}
	let seen = 0;
	// Pre-order walk with an explicit stack; children are pushed in reverse
	// so they come off it in document order.
	const stack: Nodes[] = [parseMarkdownAst(text)];
	while (stack.length > 0) {
		const node = stack.pop() as Nodes;
		if (node.type === "text") {
			for (const match of node.value.matchAll(CITATION_MARKER)) {
				found.add(Number(match[1]));
				seen++;
				if (seen >= maxMarkers) {
					return ascending(found);
				}
			}
			continue;
		}
		if ("children" in node && !SKIPPED_NODE_TYPES.has(node.type)) {
			for (let i = node.children.length - 1; i >= 0; i--) {
				stack.push(node.children[i]);
			}
		}
	}
	return ascending(found);
}

/** Unique numbers in ascending order. */
function ascending(found: ReadonlySet<number>): number[] {
	return [...found].sort((a, b) => a - b);
}
