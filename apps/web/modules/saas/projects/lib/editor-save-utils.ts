/**
 * Utility functions for saving editor content
 *
 * These functions handle the transformation of editor HTML content
 * for saving to the database, including stripping diff markers.
 */

import type TurndownService from "turndown";

/**
 * Override Turndown's default `escape` function to NOT escape `*` and `_`
 * in text nodes.
 *
 * Turndown's default escape unconditionally rewrites every `*` to `\*`
 * and every `_` to `\_`, applied to any text node it serializes. That's
 * defensive against user-typed literals being misread as emphasis on a
 * round-trip — but it's the wrong default for our pipeline:
 *
 * - `<strong>` and `<em>` HTML elements produce `**`/`*` via Turndown's
 *   tag handlers, NOT via this escape function. Those are unaffected.
 * - When literal `**` characters leak into editor text nodes — typically
 *   from `fromMarkdown` skipping bold/emphasis inside diff annotations,
 *   or from a partially-applied diff — they were ALWAYS the model's
 *   intended emphasis markers, not user-typed literals.
 * - Escaping these turns `**Key Constraints & Dependencies:**` into
 *   `\*\*Key Constraints & Dependencies:\*\*` in the saved markdown.
 *   Renderers then show the literal asterisks. This is exactly the bug
 *   reported in production where a single bold span (out of 14 in a
 *   feature doc) rendered as literal `**` text.
 *
 * Other escape rules — backslash, brackets, leading hash/hyphen/plus,
 * inline backticks, etc. — are preserved verbatim from Turndown's
 * defaults since those characters DO need protection in our text
 * content.
 *
 * Call this AFTER constructing the TurndownService (and after any
 * `service.use(gfm)` plugins, defensively, in case they swap escape).
 */
export function disableEmphasisEscape(service: TurndownService): void {
	// Source: turndown's defaults at
	// https://github.com/mixmark-io/turndown/blob/master/src/turndown.js
	// We drop only the `*` and `_` rules.
	service.escape = (str: string): string => {
		return str
			.replace(/\\/g, "\\\\")
			.replace(/^-/g, "\\-")
			.replace(/^\+ /g, "\\+ ")
			.replace(/^(=+)/g, "\\$1")
			.replace(/^(#{1,6}) /g, "\\$1 ")
			.replace(/`/g, "\\`")
			.replace(/^~~~/g, "\\~~~")
			.replace(/\[/g, "\\[")
			.replace(/\]/g, "\\]")
			.replace(/^>/g, "\\>")
			.replace(/^(\d+)\. /g, "$1\\. ");
	};
}

/**
 * Collapse `**X****Y**` patterns in post-Turndown markdown into `**XY**`.
 *
 * When a bold span gets split across a diff annotation
 * (`<strong>A<ins class="diff-ins">B</ins></strong>`), TipTap's mark
 * priority pushes the diff mark OUTSIDE of bold:
 * `<ins class="diff-ins"><strong>A</strong></ins><strong>B</strong>`.
 * After `stripDiffTags` unwraps the `<ins>`, we're left with two adjacent
 * `<strong>` tags: `<strong>A</strong><strong>B</strong>`. The
 * `mergeAdjacentMarks` HTML pass handles strictly-adjacent tags via
 * regex `</strong><strong>`, but misses cases where TipTap emits
 * whitespace, comments, or other artifacts between them. Turndown then
 * serializes the surviving adjacent tags as `**A****B**` — four
 * consecutive asterisks, valid markdown but visibly broken because the
 * `**` between them fails CommonMark flanking rules and renders as
 * literal text.
 *
 * Production example: `**Workflows affected****:**` rendered with the
 * literal `**:**` showing as visible asterisks around the colon.
 *
 * This pass runs on the post-Turndown markdown string and collapses
 * `**X****Y**` into `**XY**`. The replacement is idempotent — repeated
 * application is a no-op once no `****` runs remain. We loop until
 * stable to handle longer chains (`**A****B****C**` → `**ABC**`).
 *
 * Conservative: only matches when the four asterisks are STRICTLY
 * consecutive (no whitespace between the close and reopen), which is
 * exactly the Turndown adjacent-tag output. Legitimate adjacent bold
 * spans separated by space (`**foo** **bar**`) are preserved.
 */
export function collapseAdjacentBoldSpans(markdown: string): string {
	let result = markdown;
	let previous: string;
	do {
		previous = result;
		result = result.replace(
			/\*\*([^*\n]+?)\*\*\*\*([^*\n]+?)\*\*/g,
			"**$1$2**",
		);
	} while (result !== previous);
	return result;
}

/**
 * Patch a Turndown service to replace turndown-plugin-gfm@1.0.2's buggy
 * strikethrough rule with a correct one.
 *
 * The installed plugin emits single-tilde `~X~` for `<del>`/`<s>`/`<strike>`,
 * which is NOT valid GFM (GFM uses `~~X~~`). Single tildes round-trip as
 * literal text and corrupt saved documents. We split the fix by tag semantics:
 * `<del class="diff-del">` is our diff-deletion marker and must be dropped
 * entirely (defense in depth — `stripDiffTags` normally removes these first);
 * bare `<del>`, `<s>`, and `<strike>` are user-authored strikethrough and must
 * serialize as valid `~~...~~` so pasted content round-trips correctly.
 *
 * Call this AFTER `service.use(gfm)` so the override wins.
 */
export function applyGfmStrikethroughFix(service: TurndownService): void {
	service.addRule("diffDelDrop", {
		filter: (node: HTMLElement) =>
			node.nodeName === "DEL" && node.classList.contains("diff-del"),
		replacement: () => "",
	});
	service.addRule("gfmStrikethroughFix", {
		// Function filter — `<strike>` is not in HTMLElementTagNameMap so a
		// string-array filter can't reference it. Bare `<del>` (no diff-del
		// class) is user strikethrough from paste and must also serialize
		// as GFM double-tilde.
		filter: (node: HTMLElement) => {
			if (node.nodeName === "S" || node.nodeName === "STRIKE") {
				return true;
			}
			return (
				node.nodeName === "DEL" && !node.classList.contains("diff-del")
			);
		},
		replacement: (content: string) => `~~${content}~~`,
	});
}

/**
 * Turndown `blankReplacement` override that preserves `<excalidraw-embed>`
 * nodes through the HTML→Markdown save pass.
 *
 * Why this is a `blankReplacement` and NOT an `addRule` (the way the
 * `mentionSpan` rule works): the `excalidrawEmbed` TipTap node is
 * `atom: true` with no text content, so Turndown classifies it as blank
 * (`node.isBlank`). `Rules.forNode` returns the blank rule BEFORE it
 * consults any `addRule` filters, so a normal `addRule("excalidrawEmbed", …)`
 * never fires for the empty embed — the tag is silently serialized to "" and
 * dropped on every save. (This was the bug where an accepted Excalidraw
 * diagram vanished from the document after the Confirm-Changes step: the
 * surrounding prose persisted, the embed did not.) Mentions survive via
 * `addRule` only because they carry visible text and are therefore not blank.
 *
 * Overriding `blankReplacement` is the single hook that runs for blank nodes.
 * We intercept the embed here and emit its `outerHTML` verbatim on its own
 * line (blank line before/after) so the MarkdownIt `html: true` load path
 * re-parses it as an HTML block and the `ExcalidrawEmbed` node's `parseHTML`
 * rematches the tag. Every other blank node falls back to Turndown's
 * documented default (`node.isBlock ? "\n\n" : ""`).
 */
export function excalidrawAwareBlankReplacement(
	_content: string,
	node: Node,
): string {
	if (node.nodeName?.toLowerCase() === "excalidraw-embed") {
		return `\n\n${(node as HTMLElement).outerHTML}\n\n`;
	}
	// On load, MarkdownIt wraps a lone inline `<excalidraw-embed>` in a
	// paragraph (`<p><excalidraw-embed …></excalidraw-embed></p>`). That
	// wrapper is itself blank — the embed carries no text — so Turndown would
	// drop the whole paragraph and take the embed with it. Dig any embed(s)
	// out of a blank wrapper and preserve them. (TipTap normally re-hoists the
	// block-level embed out of the paragraph on parse, so the editor's own
	// `getHTML()` emits a bare embed that the branch above handles; this guards
	// the wrapped shape too, e.g. a markdown→HTML→markdown pass with no editor.)
	const embeds = (
		node as unknown as {
			querySelectorAll?: (s: string) => ArrayLike<{ outerHTML: string }>;
		}
	).querySelectorAll?.("excalidraw-embed");
	if (embeds && embeds.length > 0) {
		return `\n\n${Array.from(embeds)
			.map((embed) => embed.outerHTML)
			.join("\n\n")}\n\n`;
	}
	return (node as unknown as { isBlock?: boolean }).isBlock ? "\n\n" : "";
}

// Diff tags carry class markers so we can tell them apart from pasted bare
// <ins>/<del>. stripDiffTags only touches the class-marked variants so user
// strikethrough (which parses as Strike → <s>) is preserved.
const DIFF_DEL_PAIR_RE =
	/<del\b[^>]*\bclass=(?:"[^"]*\bdiff-del\b[^"]*"|'[^']*\bdiff-del\b[^']*')[^>]*>[\s\S]*?<\/del>/gi;
const DIFF_INS_PAIR_RE =
	/<ins\b[^>]*\bclass=(?:"[^"]*\bdiff-ins\b[^"]*"|'[^']*\bdiff-ins\b[^']*')[^>]*>([\s\S]*?)<\/ins>/gi;

// After stripping diff tags, we sometimes end up with two adjacent same-type
// formatting tags where there used to be ONE continuous mark broken by a diff
// region. TipTap pushes DiffInsert/DiffDelete (priority 1000) OUTSIDE of
// Bold/Italic/Strike (priority 100), so `<strong><ins>A</ins>B</strong>`
// becomes `<ins><strong>A</strong></ins><strong>B</strong>` after parse.
// Removing the <ins> wrapper leaves `<strong>A</strong><strong>B</strong>`,
// which turndown then serializes as `**A****B**` (or `**A** **B**` if there
// was trailing whitespace inside the first mark) — valid markdown, but visibly
// broken because the bold was meant to be continuous.
//
// Merge strictly-adjacent same-tag pairs so the downstream turndown pass sees
// a single run. We only merge bare open tags (no attributes) to avoid
// conflating marks that meaningfully differ (e.g. <strong class="foo"> and
// <strong>); the tags emitted by TipTap for these marks are attribute-free.
// `<mark>` is NOT attribute-free and is handled separately below.
const ADJACENT_MARK_RE = /<\/(strong|em|s|u)><\1>/gi;
function mergeAdjacentMarks(html: string): string {
	// Iterate until stable — `<strong></strong><strong></strong><strong>`
	// chains can produce new adjacencies after the first pass.
	let previous: string;
	let current = html;
	do {
		previous = current;
		current = current.replace(ADJACENT_MARK_RE, "");
	} while (current !== previous);
	// `<mark>` needs a different predicate — see mergeAdjacentHighlights.
	return mergeAdjacentHighlights(current);
}

// Matches an opening or closing `<mark>` tag and nothing else. The lookahead is
// what keeps `<marker>`, `<markdown>` and `Map<markerId, string>` out; `[^>]*`
// is a negated class with a literal terminator, so it is deterministic — there
// is exactly one way to match it and the scan is linear.
//
// This is deliberately NOT `<mark([^>]*)>([\s\S]*?)</mark><mark\1>`: a
// backreference plus a lazy quantifier over untrusted document text, run inside
// a fixpoint loop on the client main thread, is the ReDoS family documented in
// docs/solutions/security-issues/redos-in-preview-markdown-strip.md.
const MARK_TAG_RE = /<(\/?)mark(?=[\s/>])([^>]*)>/gi;

/**
 * Merge strictly-adjacent `</mark><mark …>` seams whose OPEN tags are
 * byte-identical, attributes included.
 *
 * `ADJACENT_MARK_RE` cannot express this. Its `<\1>` half only matches a *bare*
 * open tag, which is right for `strong|em|s|u` (TipTap always emits those
 * attribute-free) and wrong for `<mark>` in both directions, because
 * `Highlight.configure({ multicolor: true })` puts `data-color` plus a `style`
 * attribute on every toolbar highlight:
 *
 * - `<mark data-color="#a">A</mark><mark>B</mark>` would merge (the closing tag
 *   carries no attributes), silently recolouring B to #a.
 * - `<mark data-color="#a">A</mark><mark data-color="#a">B</mark>` — one
 *   coloured highlight split by an accepted AI diff, the case this exists for —
 *   would be refused.
 *
 * Comparing full open tags fixes both. Implemented as a bounded single pass:
 * the tag scan advances monotonically and each seam is decided in O(1), so no
 * fixpoint loop is needed — a chain like `<mark>A</mark><mark>B</mark><mark>C</mark>`
 * collapses in that one pass because the open tag pushed for each surviving
 * seam is the one the next `</mark>` pops.
 */
function mergeAdjacentHighlights(html: string): string {
	MARK_TAG_RE.lastIndex = 0;
	// Open tags of the currently-open `<mark>` elements, innermost last.
	const openTags: string[] = [];
	// The `</mark>` that ends exactly at the current position, if any: where it
	// started, and the open tag it closed.
	let pendingClose: { start: number; end: number; openTag: string } | null =
		null;
	// Half-open [start, end) ranges to elide, in increasing order.
	const seams: Array<[number, number]> = [];

	let match: RegExpExecArray | null = MARK_TAG_RE.exec(html);
	while (match !== null) {
		const tag = match[0];
		const start = match.index;
		const end = start + tag.length;

		if (match[1] === "/") {
			pendingClose = { start, end, openTag: openTags.pop() ?? "" };
		} else {
			if (
				pendingClose !== null &&
				pendingClose.end === start &&
				pendingClose.openTag === tag
			) {
				// Same highlight, split. Drop the seam; the open tag pushed
				// below stands in for the one the elided `</mark>` closed.
				seams.push([pendingClose.start, end]);
			}
			// A self-closing `<mark/>` opens nothing, so it must not be pushed.
			if (!(match[2] ?? "").endsWith("/")) {
				openTags.push(tag);
			}
			pendingClose = null;
		}

		match = MARK_TAG_RE.exec(html);
	}

	if (seams.length === 0) {
		return html;
	}

	let result = "";
	let cursor = 0;
	for (const [start, end] of seams) {
		result += html.slice(cursor, start);
		cursor = end;
	}
	return result + html.slice(cursor);
}

/**
 * Strip diff tags from HTML content for saving.
 *
 * Diff markers live on `<ins class="diff-ins">` / `<del class="diff-del">`
 * (emitted by `fromMarkdown`, bound to TipTap's DiffInsert / DiffDelete marks):
 * - additions: unwrap tags, keep content
 * - deletions: remove tags AND content
 * - `<div class="diff-table-added">` wraps added tables — unwrap, keep table
 * - `<div class="diff-table-deleted">` wraps deleted tables — remove entirely
 * - `<table data-diff="deleted">` — remove entirely; `"added"` — keep, drop attr
 *
 * The `data-diff` attribute exists because ProseMirror drops the wrapper div
 * (no schema node matches a bare div), so by the time the editor serializes
 * its content the class is gone and a deleted table would survive alongside
 * its replacement. The attribute lives on the Table node and round-trips.
 *
 * Bare `<ins>`/`<del>` from pasted HTML are NOT touched here; they round-trip
 * as normal user content (bare `<del>` → Strike mark → `<s>` → `~~...~~`).
 */
export function stripDiffTags(html: string): string {
	if (!html) {
		return "";
	}

	let result = html;

	// First, remove deleted block wrappers entirely (tables and code fences).
	// Covers both `<div class="diff-table-deleted">` (tables) and
	// `<div class="diff-block-deleted">` (fenced code blocks).
	result = result.replace(
		/<div\s+class=["'](?:diff-table-deleted|diff-block-deleted)["'][^>]*>[\s\S]*?<\/div>/gi,
		"",
	);

	// Then, unwrap added block wrappers — remove the wrapper div but keep
	// the table/code-block inside.
	result = result.replace(
		/<div\s+class=["'](?:diff-table-added|diff-block-added)["'][^>]*>([\s\S]*?)<\/div>/gi,
		"$1",
	);

	// Tables carry the diff state as an attribute too, because the wrapper div
	// above does not survive the editor's ProseMirror round trip. Drop deleted
	// tables wholesale (tables cannot nest, so the lazy match is safe), then
	// clear the marker off the tables that stay.
	result = result.replace(
		/<table\b[^>]*\bdata-diff=["']deleted["'][^>]*>[\s\S]*?<\/table>/gi,
		"",
	);
	result = result.replace(/\s*data-diff=["'](?:added|deleted)["']/gi, "");

	// Remove class-marked diff deletions entirely. Bare <del> from pasted
	// HTML is left alone so it can round-trip as user strikethrough.
	result = result.replace(DIFF_DEL_PAIR_RE, "");

	// Unwrap class-marked diff additions, keeping their content.
	result = result.replace(DIFF_INS_PAIR_RE, "$1");

	// Re-join formatting marks that got split by the now-removed diff tags.
	result = mergeAdjacentMarks(result);

	return result;
}
