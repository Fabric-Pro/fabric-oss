/**
 * Pure, framework-free helpers for the document diff review-mode toggle.
 *
 * No React / editor / `window` dependency at module load, so this is safe to
 * import anywhere and to unit-test in isolation.
 *
 * The live AI diff is carried on the editor as inline marks
 * `<ins class="diff-ins">` (additions) / `<del class="diff-del">` (deletions),
 * plus whole-block / table wrappers (`diff-table-added` / `diff-table-deleted`
 * and their `diff-block-*` equivalents). The three review presentations are all
 * derived from that single marked HTML — no second fetch, no re-diff.
 */

export type DiffViewMode = "inline" | "sideBySide" | "fullPreview";

/** Single shared key — the choice is one preference across both editors. */
export const DIFF_VIEW_MODE_STORAGE_KEY = "fabric:diff-view-mode";
export const DEFAULT_DIFF_VIEW_MODE: DiffViewMode = "inline";

/** Map any stored / unknown value to a valid mode, defaulting to inline. */
export function normalizeDiffViewMode(value: unknown): DiffViewMode {
	return value === "inline" ||
		value === "sideBySide" ||
		value === "fullPreview"
		? value
		: DEFAULT_DIFF_VIEW_MODE;
}

export interface DerivedDiffViews {
	/**
	 * Side-by-side left ("before"): additions dropped, deletions kept (marked;
	 * inside a diagram, unmarked so it draws the old version).
	 */
	originalHtml: string;
	/**
	 * Side-by-side right ("after"): deletions dropped, additions kept (marked;
	 * inside a diagram, unmarked so it draws the new version).
	 */
	proposedHtml: string;
	/** Full preview: deletions dropped, additions unwrapped — no diff markup. */
	cleanProposedHtml: string;
}

// Addition / deletion node selectors, covering both inline marks and the
// block / table diff wrappers emitted by the markdown→HTML diff pipeline. The
// `diff-block-*` classes mirror the accept-time strip (`stripDiffTags`) wrapper
// set; the renderer currently only emits the `diff-table-*` variants, but the
// `diff-block-*` selectors are kept for parity and forward-compatibility.
//
// Tables need their own selectors: ProseMirror drops the wrapper divs on
// parse, so in `editor.getHTML()` output an added/deleted table is carried as
// a `data-diff` attribute on the `<table>` itself. Removal works the same for
// both shapes, but the clean view must NOT unwrap a `<table>` (that would
// orphan its rows) — added tables are kept by clearing the attribute instead.
const ADDITION_WRAPPER_SELECTOR =
	"ins.diff-ins, .diff-table-added, .diff-block-added";
const ADDITION_TABLE_SELECTOR = 'table[data-diff="added"]';
const ADDITION_SELECTOR = `${ADDITION_WRAPPER_SELECTOR}, ${ADDITION_TABLE_SELECTOR}`;
const DELETION_SELECTOR =
	'del.diff-del, .diff-table-deleted, .diff-block-deleted, table[data-diff="deleted"]';

/**
 * Remove the matched marks, then drop any code block that only held them: a
 * whole fence added or deleted by the edit is one marked run inside its
 * `<pre>`, so the pane that hides that run would otherwise show an empty box.
 */
function removeMarks(root: ParentNode, selector: string): void {
	const touched = new Set<Element>();
	for (const el of Array.from(root.querySelectorAll(selector))) {
		const pre = el.closest("pre");
		if (pre) {
			touched.add(pre);
		}
		el.remove();
	}
	for (const pre of touched) {
		if (!pre.textContent?.trim()) {
			pre.remove();
		}
	}
}

/** Replace each matched element with its child nodes (drop wrapper, keep content). */
function unwrapAll(root: ParentNode, selector: string): void {
	for (const el of Array.from(root.querySelectorAll(selector))) {
		const parent = el.parentNode;
		if (!parent) {
			continue;
		}
		while (el.firstChild) {
			parent.insertBefore(el.firstChild, el);
		}
		parent.removeChild(el);
	}
}

/**
 * A diagram fence as the editor (`data-language`) or `fromMarkdown` (the
 * `<code>` class) writes it.
 */
function isDiagramPre(pre: Element): boolean {
	return (
		pre.getAttribute("data-language") === "mermaid" ||
		pre.querySelector("code")?.classList.contains("language-mermaid") ===
			true
	);
}

/**
 * Keep the text of the diff marks inside every diagram fence and drop the
 * marks. A pane that shows one side of an edit holds only that side's marks,
 * and a diagram whose text is marked is drawn as an edit under review: its
 * source with the marks, and the diagram without the deleted text — in the
 * original pane, neither version. Unmarked, each pane draws its own version.
 */
function unwrapDiagramMarks(root: ParentNode): void {
	for (const pre of Array.from(root.querySelectorAll("pre"))) {
		if (isDiagramPre(pre)) {
			unwrapAll(pre, "ins.diff-ins, del.diff-del");
		}
	}
}

/**
 * `html` with the diff marks inside its diagram fences dropped and their text
 * kept, for a pane that shows one side of an edit (see `unwrapDiagramMarks`).
 * Never throws: on a parse failure the input comes back as it was.
 */
export function withoutDiagramDiffMarks(html: string): string {
	try {
		const parsed = new DOMParser().parseFromString(html, "text/html");
		unwrapDiagramMarks(parsed.body);
		return parsed.body.innerHTML;
	} catch {
		return html;
	}
}

/**
 * Derive the three preview renderings from the live diff-marked editor HTML.
 *
 * Uses `DOMParser` (never regex) so nested tables/lists are handled safely.
 * Best-effort and total: never throws — on any parse failure every field falls
 * back to the input HTML so the caller can degrade to inline rendering.
 */
export function deriveDiffViews(html: string): DerivedDiffViews {
	const safe = html ?? "";
	try {
		const parser = new DOMParser();

		const original = parser.parseFromString(safe, "text/html");
		removeMarks(original.body, ADDITION_SELECTOR);
		unwrapDiagramMarks(original.body);

		const proposed = parser.parseFromString(safe, "text/html");
		removeMarks(proposed.body, DELETION_SELECTOR);
		unwrapDiagramMarks(proposed.body);

		const clean = parser.parseFromString(safe, "text/html");
		removeMarks(clean.body, DELETION_SELECTOR);
		for (const table of Array.from(
			clean.body.querySelectorAll(ADDITION_TABLE_SELECTOR),
		)) {
			table.removeAttribute("data-diff");
		}
		unwrapAll(clean.body, ADDITION_WRAPPER_SELECTOR);

		return {
			originalHtml: original.body.innerHTML,
			proposedHtml: proposed.body.innerHTML,
			cleanProposedHtml: clean.body.innerHTML,
		};
	} catch {
		return {
			originalHtml: safe,
			proposedHtml: safe,
			cleanProposedHtml: safe,
		};
	}
}
