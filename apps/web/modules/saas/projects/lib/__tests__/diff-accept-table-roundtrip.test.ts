/**
 * End-to-end regression for the AI-edit accept flow with tables.
 *
 * The accept handler does NOT persist the agent's markdown — it renders
 * `diffPartialText(baseline, proposed)` into the editor and then saves whatever
 * `getEditorMarkdownForSave` serializes back out of the DOM. So any table that
 * fails to become a real table node during the diff render is written to the
 * database as literal pipe text, permanently. These tests drive that exact
 * sequence: diff → fromMarkdown → TipTap → save.
 */

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { diffPartialText, fromMarkdown } from "../diff-utils";
import { getEditorMarkdownForSave } from "../editor-markdown-save";
import { advancedExtensions } from "../tiptap-extensions-advanced";

const BASELINE = `# Delivery Plan

## Owners

| Role | Owner | Status |
|------|-------|--------|
| PM | Alice | Active |
| Eng | Bob | Pending |

Some trailing prose.`;

/** Runs the accept path: diff-render into an editor, then serialize for save. */
function acceptEdit(baseline: string, proposed: string): string {
	const diff = diffPartialText(baseline, proposed, true);
	const editor = new Editor({
		extensions: advancedExtensions,
		content: fromMarkdown(diff),
	});
	try {
		return getEditorMarkdownForSave(editor);
	} finally {
		editor.destroy();
	}
}

function expectHealthyTable(saved: string) {
	// No diff-marker debris (ZWSP / NBSP) survived into stored content.
	expect(saved).not.toMatch(/[​ ]/);
	expect(saved).not.toContain("ADD_START");
	expect(saved).not.toContain("DEL_START");
	// Rows are on their own lines, not collapsed into one pipe blob.
	expect(saved).toMatch(/^\|[\s\-:|]+\|\s*$/m);
	// And it still parses as a table.
	expect(fromMarkdown(saved)).toContain("<table>");
}

describe("AI-edit accept flow preserves GFM tables", () => {
	it("keeps the table intact when a cell value is edited", () => {
		const proposed = BASELINE.replace("Pending", "Blocked");

		const saved = acceptEdit(BASELINE, proposed);

		expectHealthyTable(saved);
		expect(saved).toContain("Blocked");
		expect(saved).not.toContain("Pending");
		expect(saved).toContain("Alice");
	});

	it("keeps the table intact when a row is added", () => {
		const proposed = BASELINE.replace(
			"| Eng | Bob | Pending |",
			"| Eng | Bob | Pending |\n| QA | Carol | Active |",
		);

		const saved = acceptEdit(BASELINE, proposed);

		expectHealthyTable(saved);
		expect(saved).toContain("Carol");
		expect(saved).toContain("Alice");
	});

	it("leaves the table untouched when only surrounding prose changes", () => {
		const proposed = BASELINE.replace(
			"Some trailing prose.",
			"Some trailing prose, revised.",
		);

		const saved = acceptEdit(BASELINE, proposed);

		expectHealthyTable(saved);
		expect(saved).toContain("revised");
		// Every original row still present.
		expect(saved).toContain("Alice");
		expect(saved).toContain("Bob");
		expect(saved).toMatch(/\|\s*Role\s*\|/);
	});
});
