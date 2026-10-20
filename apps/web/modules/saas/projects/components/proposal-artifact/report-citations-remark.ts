import {
	REPORT_CITATION_MARKER_SOURCE,
	REPORT_CITATION_SCAN_MAX_MARKERS,
} from "@repo/utils/proposal-artifact/report-text";

/**
 * The parts of a Markdown syntax-tree node this plugin reads or writes,
 * typed structurally: the tree's own type packages are not dependencies of
 * the web app.
 */
type MarkdownNode = {
	type: string;
	value?: string;
	children?: MarkdownNode[];
	data?: Record<string, unknown>;
};

/**
 * Nodes whose text never turns into a citation:
 *
 *  - a link or link reference the model wrote — its text renders as plain
 *    text, and a marker there must not become a chip that looks like the
 *    server's;
 *  - inline and fenced code and raw HTML, which carry `value`, not text
 *    children, and stay as written.
 */
const SKIPPED_NODE_TYPES: ReadonlySet<string> = new Set([
	"link",
	"linkReference",
	"inlineCode",
	"code",
	"html",
]);

/** The marker the server scans for; `matchAll` clones it, so sharing it is safe. */
const CITATION_MARKER = new RegExp(REPORT_CITATION_MARKER_SOURCE, "g");

/** The node type this plugin adds; the renderer sees it as `span[data-citation]`. */
const CITATION_NODE_TYPE = "proposalReportCitation";

type ReportCitationsOptions = {
	/** The source numbers the server resolved for this report. */
	sources: ReadonlySet<number>;
};

/** What one document's walk has done so far. */
type WalkState = {
	/** The sources already cited, so only a source's first chip is marked. */
	seen: Set<number>;
	/** How many more chips this document may have. */
	remaining: number;
};

/**
 * Turn the `[S<N>]` markers in a Proposal analysis report's text nodes into
 * citation nodes (Fizzy #2946), for the numbers the server lists only. Each
 * becomes `<span data-citation="N">` — with `data-first` on the first marker
 * of a source, in document order — for the renderer to show as a chip.
 *
 * Only text nodes are read, and never those of a link the model wrote, so a
 * chip comes from this plugin and the server's list alone: neither
 * `[x](#ref-S2)` nor `[S2](https://…)`, a reference definition, a footnote
 * label, code or raw HTML can produce one. A marker whose number is not
 * listed stays text.
 *
 * A document gets at most `REPORT_CITATION_SCAN_MAX_MARKERS` chips, the
 * first ones in document order; every marker after them stays text. The
 * server reads no further than that many markers when it resolves the
 * sources, so a report repeating one listed marker thousands of times
 * cannot render thousands of interactive chips.
 */
export function remarkReportCitations(options: ReportCitationsOptions) {
	const { sources } = options;
	return (tree: unknown) => {
		if (sources.size === 0) {
			return;
		}
		const state: WalkState = {
			seen: new Set<number>(),
			remaining: REPORT_CITATION_SCAN_MAX_MARKERS,
		};
		splitMarkers(tree as MarkdownNode, sources, state);
	};
}

/**
 * Walk `node`'s children in document order, splitting each text child,
 * until the document's chips run out.
 */
function splitMarkers(
	node: MarkdownNode,
	sources: ReadonlySet<number>,
	state: WalkState,
): void {
	const children = node.children;
	if (!children || SKIPPED_NODE_TYPES.has(node.type)) {
		return;
	}
	const next: MarkdownNode[] = [];
	let changed = false;
	for (const child of children) {
		if (state.remaining <= 0) {
			next.push(child);
			continue;
		}
		if (child.type === "text" && typeof child.value === "string") {
			const parts = splitText(child.value, sources, state);
			if (parts) {
				next.push(...parts);
				changed = true;
				continue;
			}
		} else {
			splitMarkers(child, sources, state);
		}
		next.push(child);
	}
	if (changed) {
		node.children = next;
	}
}

/**
 * `value` as text and citation nodes, or null when it holds no listed
 * marker. `state.seen` collects the sources already cited, so only a
 * source's first marker carries `data-first`; once `state.remaining` reaches
 * zero, the rest of `value` stays text.
 */
function splitText(
	value: string,
	sources: ReadonlySet<number>,
	state: WalkState,
): MarkdownNode[] | null {
	const parts: MarkdownNode[] = [];
	let last = 0;
	for (const match of value.matchAll(CITATION_MARKER)) {
		if (state.remaining <= 0) {
			break;
		}
		const source = Number(match[1]);
		if (!sources.has(source)) {
			continue;
		}
		const start = match.index ?? 0;
		if (start > last) {
			parts.push({ type: "text", value: value.slice(last, start) });
		}
		const first = !state.seen.has(source);
		state.seen.add(source);
		state.remaining--;
		parts.push({
			type: CITATION_NODE_TYPE,
			value: match[0],
			data: {
				hName: "span",
				hProperties: first
					? { dataCitation: String(source), dataFirst: "true" }
					: { dataCitation: String(source) },
				hChildren: [{ type: "text", value: match[0] }],
			},
		});
		last = start + match[0].length;
	}
	if (parts.length === 0) {
		return null;
	}
	if (last < value.length) {
		parts.push({ type: "text", value: value.slice(last) });
	}
	return parts;
}
