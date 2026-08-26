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
	/** Side-by-side left ("before"): additions dropped, deletions kept (marked). */
	originalHtml: string;
	/** Side-by-side right ("after"): deletions dropped, additions kept (marked). */
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

function removeAll(root: ParentNode, selector: string): void {
	for (const el of Array.from(root.querySelectorAll(selector))) {
		el.remove();
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
		removeAll(original.body, ADDITION_SELECTOR);

		const proposed = parser.parseFromString(safe, "text/html");
		removeAll(proposed.body, DELETION_SELECTOR);

		const clean = parser.parseFromString(safe, "text/html");
		removeAll(clean.body, DELETION_SELECTOR);
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
