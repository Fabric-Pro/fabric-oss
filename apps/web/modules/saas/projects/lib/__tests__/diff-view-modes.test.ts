import { describe, expect, it } from "vitest";
import {
	DEFAULT_DIFF_VIEW_MODE,
	deriveDiffViews,
	normalizeDiffViewMode,
} from "../diff-view-modes";

// Representative inline diff: "Hello old world" -> "Hello new world".
const INLINE_DIFF =
	'<p>Hello <ins class="diff-ins">new </ins><del class="diff-del">old </del>world</p>';

describe("normalizeDiffViewMode", () => {
	it("passes through the three known modes", () => {
		expect(normalizeDiffViewMode("inline")).toBe("inline");
		expect(normalizeDiffViewMode("sideBySide")).toBe("sideBySide");
		expect(normalizeDiffViewMode("fullPreview")).toBe("fullPreview");
	});

	it("falls back to the inline default for unknown / empty values", () => {
		expect(normalizeDiffViewMode("bogus")).toBe(DEFAULT_DIFF_VIEW_MODE);
		expect(normalizeDiffViewMode("")).toBe("inline");
		expect(normalizeDiffViewMode(null)).toBe("inline");
		expect(normalizeDiffViewMode(undefined)).toBe("inline");
		expect(normalizeDiffViewMode(42)).toBe("inline");
		expect(normalizeDiffViewMode({})).toBe("inline");
	});
});

describe("deriveDiffViews — inline marks", () => {
	it("originalHtml drops additions and keeps deletions + unchanged text", () => {
		const { originalHtml } = deriveDiffViews(INLINE_DIFF);
		expect(originalHtml).toContain("Hello");
		expect(originalHtml).toContain("world");
		expect(originalHtml).toContain("old ");
		expect(originalHtml).not.toContain("new ");
		// the deletion mark is retained so the left pane can highlight removals
		expect(originalHtml).toContain("diff-del");
		expect(originalHtml).not.toContain("diff-ins");
	});

	it("proposedHtml drops deletions and keeps additions + unchanged text", () => {
		const { proposedHtml } = deriveDiffViews(INLINE_DIFF);
		expect(proposedHtml).toContain("Hello");
		expect(proposedHtml).toContain("world");
		expect(proposedHtml).toContain("new ");
		expect(proposedHtml).not.toContain("old ");
		expect(proposedHtml).toContain("diff-ins");
		expect(proposedHtml).not.toContain("diff-del");
	});

	it("cleanProposedHtml drops deletions and unwraps additions (no diff markup)", () => {
		const { cleanProposedHtml } = deriveDiffViews(INLINE_DIFF);
		expect(cleanProposedHtml).toContain("Hello");
		expect(cleanProposedHtml).toContain("world");
		expect(cleanProposedHtml).toContain("new ");
		expect(cleanProposedHtml).not.toContain("old ");
		// no diff markup at all in the clean preview
		expect(cleanProposedHtml).not.toContain("<ins");
		expect(cleanProposedHtml).not.toContain("<del");
		expect(cleanProposedHtml).not.toContain("diff-ins");
		expect(cleanProposedHtml).not.toContain("diff-del");
	});
});

describe("deriveDiffViews — block / table wrappers", () => {
	const ADDED_TABLE =
		'<p>intro</p><div class="diff-table-added"><table><tr><td>added cell</td></tr></table></div>';
	const DELETED_TABLE =
		'<p>intro</p><div class="diff-table-deleted"><table><tr><td>removed cell</td></tr></table></div>';

	it("added table appears in proposed + clean, absent from original", () => {
		const added = deriveDiffViews(ADDED_TABLE);
		expect(added.proposedHtml).toContain("added cell");
		expect(added.cleanProposedHtml).toContain("added cell");
		expect(added.originalHtml).not.toContain("added cell");
		// clean view unwraps the wrapper but keeps the real table
		expect(added.cleanProposedHtml).toContain("<table");
		expect(added.cleanProposedHtml).not.toContain("diff-table-added");
	});

	it("deleted table appears in original, absent from proposed + clean", () => {
		const deleted = deriveDiffViews(DELETED_TABLE);
		expect(deleted.originalHtml).toContain("removed cell");
		expect(deleted.proposedHtml).not.toContain("removed cell");
		expect(deleted.cleanProposedHtml).not.toContain("removed cell");
	});
});

describe("deriveDiffViews — table[data-diff] attributes", () => {
	// ProseMirror drops the wrapper divs on parse, so `editor.getHTML()` —
	// the actual input to deriveDiffViews — carries added/deleted tables as
	// a data-diff attribute on the <table> node itself.
	const ADDED_ATTR_TABLE =
		'<p>intro</p><table data-diff="added"><tbody><tr><td>added cell</td></tr></tbody></table>';
	const DELETED_ATTR_TABLE =
		'<p>intro</p><table data-diff="deleted"><tbody><tr><td>removed cell</td></tr></tbody></table>';

	it("added table appears in proposed + clean, absent from original", () => {
		const added = deriveDiffViews(ADDED_ATTR_TABLE);
		expect(added.proposedHtml).toContain("added cell");
		expect(added.cleanProposedHtml).toContain("added cell");
		expect(added.originalHtml).not.toContain("added cell");
	});

	it("clean view keeps the table intact and only strips the attribute", () => {
		const added = deriveDiffViews(ADDED_ATTR_TABLE);
		expect(added.cleanProposedHtml).toContain("<table");
		expect(added.cleanProposedHtml).toContain("<td>added cell</td>");
		expect(added.cleanProposedHtml).not.toContain("data-diff");
	});

	it("deleted table appears in original, absent from proposed + clean", () => {
		const deleted = deriveDiffViews(DELETED_ATTR_TABLE);
		expect(deleted.originalHtml).toContain("removed cell");
		expect(deleted.proposedHtml).not.toContain("removed cell");
		expect(deleted.cleanProposedHtml).not.toContain("removed cell");
	});

	it("changed table (deleted + added pair) shows exactly one table per view", () => {
		const pair =
			'<table data-diff="deleted"><tbody><tr><td>old value</td></tr></tbody></table>' +
			'<table data-diff="added"><tbody><tr><td>new value</td></tr></tbody></table>';
		const views = deriveDiffViews(pair);
		expect(views.originalHtml).toContain("old value");
		expect(views.originalHtml).not.toContain("new value");
		expect(views.proposedHtml).toContain("new value");
		expect(views.proposedHtml).not.toContain("old value");
		expect(views.cleanProposedHtml).toContain("new value");
		expect(views.cleanProposedHtml).not.toContain("old value");
		expect(views.cleanProposedHtml).not.toContain("data-diff");
	});
});

describe("deriveDiffViews — robustness", () => {
	it("handles an empty string without throwing", () => {
		const views = deriveDiffViews("");
		expect(views.originalHtml).toBe("");
		expect(views.proposedHtml).toBe("");
		expect(views.cleanProposedHtml).toBe("");
	});

	it("returns clean content for HTML with no diff marks", () => {
		const plain = "<p>plain paragraph</p><ul><li>item</li></ul>";
		const views = deriveDiffViews(plain);
		expect(views.originalHtml).toContain("plain paragraph");
		expect(views.proposedHtml).toContain("plain paragraph");
		expect(views.cleanProposedHtml).toContain("plain paragraph");
		expect(views.cleanProposedHtml).toContain("item");
	});

	it("preserves nested structure around a kept region", () => {
		const nested =
			'<ul><li>keep <del class="diff-del">drop</del> me</li></ul>';
		const { proposedHtml, originalHtml } = deriveDiffViews(nested);
		expect(proposedHtml).toContain("<li>");
		expect(proposedHtml).toContain("keep");
		expect(proposedHtml).not.toContain("drop");
		expect(originalHtml).toContain("drop");
	});

	it("does not throw on a malformed / unbalanced fragment", () => {
		expect(() =>
			deriveDiffViews('<p>oops <ins class="diff-ins">unclosed'),
		).not.toThrow();
	});

	it("is deterministic — same input yields identical output", () => {
		const a = deriveDiffViews(INLINE_DIFF);
		const b = deriveDiffViews(INLINE_DIFF);
		expect(a).toEqual(b);
	});
});
