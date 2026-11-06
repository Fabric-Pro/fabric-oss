/**
 * Whether an editor's body holds an assistant proposal still waiting for its
 * answer (Fizzy #2946): the shapes a proposal leaves in the editor — marked
 * text, a marked diagram source, a table proposed for addition or deletion —
 * and nothing else, ordinary strikethrough included; and the whole proposal
 * rejected in place, leaving everything else in the body. A block the
 * proposal added whole goes with its rejected text, and one it deleted
 * whole with its accepted deletion, rather than staying as an empty
 * paragraph; a block a change covers only part of is never removed.
 */

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { diffPartialText, fromMarkdown } from "../diff-utils";
import {
	acceptChange,
	editorHoldsDiffMarks,
	findDiffRanges,
	rejectAllChanges,
	rejectChange,
} from "../editor-diff-marks";
import { getEditorMarkdownForSave } from "../editor-markdown-save";
import { advancedExtensions } from "../tiptap-extensions-advanced";

const BODY = "## Scope\n\nPhase one, then two.";

const editors: Editor[] = [];

function editorWith(html: string): Editor {
	const editor = new Editor({
		extensions: advancedExtensions,
		content: html,
	});
	editors.push(editor);
	return editor;
}

/** The editor showing the review of `proposed` over `BODY`. */
function reviewOf(proposed: string): Editor {
	return editorWith(fromMarkdown(diffPartialText(BODY, proposed, true)));
}

afterEach(() => {
	for (const editor of editors.splice(0)) {
		editor.destroy();
	}
});

describe("editorHoldsDiffMarks", () => {
	it("finds proposed text, added or deleted", () => {
		expect(
			editorHoldsDiffMarks(
				reviewOf(`${BODY}\n\nA paragraph the assistant proposes.`).state
					.doc,
			),
		).toBe(true);
		expect(
			editorHoldsDiffMarks(reviewOf("## Scope\n\nPhase one.").state.doc),
		).toBe(true);
	});

	it("finds a proposed diagram, whose source carries the marks", () => {
		const editor = reviewOf(
			`${BODY}\n\n\`\`\`mermaid\nflowchart LR\n  Kickoff --> Design\n\`\`\``,
		);
		let diagram = false;
		editor.state.doc.descendants((node) => {
			if (node.type.name === "mermaidBlock") {
				diagram = true;
			}
		});
		expect(diagram).toBe(true);
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(true);
	});

	it("finds a table proposed for addition or deletion, which carries no marks", () => {
		const table =
			"<table><tbody><tr><td><p>Phase</p></td><td><p>Fee</p></td></tr></tbody></table>";
		for (const diff of ["added", "deleted"]) {
			const editor = editorWith(
				`<p>Phase one.</p>${table.replace("<table>", `<table data-diff="${diff}">`)}`,
			);
			expect(editorHoldsDiffMarks(editor.state.doc)).toBe(true);
		}
		expect(
			editorHoldsDiffMarks(
				editorWith(`<p>Phase one.</p>${table}`).state.doc,
			),
		).toBe(false);
	});

	it("finds nothing in a body without a proposal, strikethrough included", () => {
		expect(
			editorHoldsDiffMarks(editorWith(fromMarkdown(BODY)).state.doc),
		).toBe(false);
		expect(
			editorHoldsDiffMarks(
				editorWith("<p>Keep <del>struck</del> and <em>this</em>.</p>")
					.state.doc,
			),
		).toBe(false);
		expect(editorHoldsDiffMarks(null)).toBe(false);
	});
});

describe("rejectAllChanges", () => {
	it("takes every change back in one transaction and keeps the rest of the body", () => {
		const editor = reviewOf(
			"## Scope\n\nPhase one.\n\nA paragraph the assistant proposes.",
		);
		let transactions = 0;
		editor.on("transaction", () => {
			transactions += 1;
		});

		expect(rejectAllChanges(editor)).toBe(true);
		expect(transactions).toBe(1);
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(false);
		const body = getEditorMarkdownForSave(editor) ?? "";
		expect(body).toContain("## Scope");
		expect(body).toContain("Phase one, then two.");
		expect(body).not.toContain("A paragraph the assistant proposes.");
		expect(rejectAllChanges(editor)).toBe(false);
	});

	it("drops a proposed diagram, block and all", () => {
		const editor = reviewOf(
			`${BODY}\n\n\`\`\`mermaid\nflowchart LR\n  Kickoff --> Design\n\`\`\``,
		);
		expect(rejectAllChanges(editor)).toBe(true);
		const diagrams: string[] = [];
		editor.state.doc.descendants((node) => {
			if (node.type.name === "mermaidBlock") {
				diagrams.push(node.textContent);
			}
		});
		expect(diagrams).toEqual([]);
		expect(getEditorMarkdownForSave(editor)).toContain(
			"Phase one, then two.",
		);
	});

	it("drops a table proposed for addition and keeps one proposed for deletion, unmarked", () => {
		const table = (diff: string) =>
			`<table data-diff="${diff}"><tbody><tr><td><p>${diff}</p></td></tr></tbody></table>`;
		const editor = editorWith(
			`<p>Phase one.</p>${table("added")}${table("deleted")}`,
		);
		expect(rejectAllChanges(editor)).toBe(true);
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(false);
		const tables: string[] = [];
		editor.state.doc.descendants((node) => {
			if (node.type.name === "table") {
				tables.push(node.textContent);
			}
		});
		expect(tables).toEqual(["deleted"]);
	});
});

/**
 * A body with a heading, prose, a list and a quote. It ends on a paragraph:
 * after any edit the editor adds an empty one behind a body that does not.
 */
const BLOCKS_BODY = [
	"## Scope",
	"",
	"Phase one, then two.",
	"",
	"- First item",
	"",
	"> Quoted.",
	"",
	"Closing line.",
].join("\n");

/** The textblocks left with no content: an emptied paragraph or heading. */
function emptyTextblocks(editor: Editor): number {
	let count = 0;
	editor.state.doc.descendants((node) => {
		if (node.isTextblock && node.content.size === 0) {
			count += 1;
		}
	});
	return count;
}

/** The editor showing the review of `proposed` over `baseline`. */
function reviewOver(baseline: string, proposed: string): Editor {
	return editorWith(fromMarkdown(diffPartialText(baseline, proposed, true)));
}

describe("rejecting a block the proposal added whole", () => {
	it.each([
		[
			"a paragraph",
			`${BLOCKS_BODY}\n\nA paragraph the assistant proposes.`,
		],
		[
			"a heading",
			BLOCKS_BODY.replace("## Scope", "## Scope\n\n## Timeline"),
		],
		[
			"a list item",
			BLOCKS_BODY.replace("- First item", "- First item\n- Second item"),
		],
		[
			"a quoted paragraph",
			BLOCKS_BODY.replace("> Quoted.", "> Quoted.\n\n> Another quote."),
		],
	])(
		"removes %s, leaving the body as it was before the proposal",
		(_label, proposed) => {
			const before = editorWith(fromMarkdown(BLOCKS_BODY)).getJSON();
			const editor = reviewOver(BLOCKS_BODY, proposed);

			expect(rejectAllChanges(editor)).toBe(true);

			expect(emptyTextblocks(editor)).toBe(0);
			expect(editor.getJSON()).toEqual(before);
		},
	);

	it("removes it when its one change is rejected on its own, too", () => {
		const before = editorWith(fromMarkdown(BLOCKS_BODY)).getJSON();
		const editor = reviewOver(
			BLOCKS_BODY,
			`${BLOCKS_BODY}\n\nA paragraph the assistant proposes.`,
		);
		const [range] = findDiffRanges(editor.state.doc);
		if (!range) {
			throw new Error("no change to reject");
		}

		rejectChange(editor, range);

		expect(emptyTextblocks(editor)).toBe(0);
		expect(editor.getJSON()).toEqual(before);
	});

	it("removes a list the proposal added whole, item by item, then the list itself", () => {
		const before = editorWith(fromMarkdown(BLOCKS_BODY)).getJSON();
		const editor = reviewOver(
			BLOCKS_BODY,
			`${BLOCKS_BODY}\n\n- New step\n- Another step`,
		);

		expect(rejectAllChanges(editor)).toBe(true);

		expect(emptyTextblocks(editor)).toBe(0);
		expect(editor.getJSON()).toEqual(before);
	});

	it("keeps a paragraph whose text the proposal replaced, with its own text", () => {
		const before = editorWith(fromMarkdown(BLOCKS_BODY)).getJSON();
		const editor = reviewOver(
			BLOCKS_BODY,
			BLOCKS_BODY.replace("Phase one, then two.", "Phase three."),
		);

		expect(rejectAllChanges(editor)).toBe(true);

		expect(editor.getJSON()).toEqual(before);
	});

	it("keeps a paragraph the proposal added text to, with its own text", () => {
		const before = editorWith(fromMarkdown(BLOCKS_BODY)).getJSON();
		const editor = reviewOver(
			BLOCKS_BODY,
			BLOCKS_BODY.replace(
				"Phase one, then two.",
				"Phase one, then two, then three.",
			),
		);

		expect(rejectAllChanges(editor)).toBe(true);

		expect(editor.getJSON()).toEqual(before);
	});

	it("keeps a table cell, emptied, in its place in the table", () => {
		const editor = editorWith(
			'<table><tbody><tr><td><p>Phase</p></td><td><p><ins class="diff-ins">Fee</ins></p></td></tr></tbody></table><p>After.</p>',
		);

		expect(rejectAllChanges(editor)).toBe(true);

		const cells: string[] = [];
		editor.state.doc.descendants((node) => {
			if (node.type.name === "tableCell") {
				cells.push(node.textContent);
			}
		});
		expect(cells).toEqual(["Phase", ""]);
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(false);
	});

	it("keeps a list item whose nested list held text before, emptying only its own line", () => {
		const editor = editorWith(
			'<ul><li><p><ins class="diff-ins">New lead-in</ins></p><ul><li><p>Kept detail</p></li></ul></li></ul>',
		);

		expect(rejectAllChanges(editor)).toBe(true);

		expect(editor.state.doc.textContent).toBe("Kept detail");
		let items = 0;
		editor.state.doc.descendants((node) => {
			if (node.type.name === "listItem") {
				items += 1;
			}
		});
		expect(items).toBe(2);
	});

	it("keeps the document's one block, emptied, since a document is never without one", () => {
		const editor = editorWith(
			'<p><ins class="diff-ins">Only line.</ins></p>',
		);

		expect(rejectAllChanges(editor)).toBe(true);

		expect(editor.state.doc.childCount).toBe(1);
		expect(editor.state.doc.textContent).toBe("");
	});
});

/** Accept every change one at a time, as the review bar's Accept does. */
function acceptEachChange(editor: Editor) {
	for (;;) {
		const [range] = findDiffRanges(editor.state.doc);
		if (!range) {
			return;
		}
		acceptChange(editor, range);
	}
}

describe("accepting the deletion of a whole block", () => {
	const TWO_ITEMS = BLOCKS_BODY.replace(
		"- First item",
		"- First item\n- Second item",
	);
	it.each([
		[
			"a paragraph",
			BLOCKS_BODY,
			BLOCKS_BODY.replace("Phase one, then two.\n\n", ""),
		],
		["a heading", BLOCKS_BODY, BLOCKS_BODY.replace("## Scope\n\n", "")],
		["a list item", TWO_ITEMS, BLOCKS_BODY],
		["a list", BLOCKS_BODY, BLOCKS_BODY.replace("- First item\n\n", "")],
		["a quote", BLOCKS_BODY, BLOCKS_BODY.replace("> Quoted.\n\n", "")],
	])(
		"removes %s, leaving the body the proposal proposed",
		(_label, baseline, proposed) => {
			const expected = editorWith(fromMarkdown(proposed)).getJSON();
			const editor = reviewOver(baseline, proposed);
			expect(editorHoldsDiffMarks(editor.state.doc)).toBe(true);

			acceptEachChange(editor);

			expect(emptyTextblocks(editor)).toBe(0);
			expect(editor.getJSON()).toEqual(expected);
		},
	);

	it("keeps a paragraph the proposal rewrote, with the new text", () => {
		const proposed = BLOCKS_BODY.replace(
			"Phase one, then two.",
			"Phase three.",
		);
		const editor = reviewOver(BLOCKS_BODY, proposed);

		acceptEachChange(editor);

		expect(editor.getJSON()).toEqual(
			editorWith(fromMarkdown(proposed)).getJSON(),
		);
	});

	it("keeps a paragraph the proposal deleted part of, with the rest", () => {
		const proposed = BLOCKS_BODY.replace(
			"Phase one, then two.",
			"Phase one.",
		);
		const editor = reviewOver(BLOCKS_BODY, proposed);

		acceptEachChange(editor);

		expect(editor.getJSON()).toEqual(
			editorWith(fromMarkdown(proposed)).getJSON(),
		);
	});

	it("keeps a table cell, emptied, in its place in the table", () => {
		const editor = editorWith(
			'<table><tbody><tr><td><p>Phase</p></td><td><p><del class="diff-del">Fee</del></p></td></tr></tbody></table><p>After.</p>',
		);

		acceptEachChange(editor);

		const cells: string[] = [];
		editor.state.doc.descendants((node) => {
			if (node.type.name === "tableCell") {
				cells.push(node.textContent);
			}
		});
		expect(cells).toEqual(["Phase", ""]);
	});

	it("keeps the document's one block, emptied, since a document is never without one", () => {
		const editor = editorWith(
			'<p><del class="diff-del">Only line.</del></p>',
		);

		acceptEachChange(editor);

		expect(editor.state.doc.childCount).toBe(1);
		expect(editor.state.doc.textContent).toBe("");
	});

	it("Accept all, which loads the body as it saves, leaves no emptied block either", () => {
		const proposed = BLOCKS_BODY.replace("Phase one, then two.\n\n", "");
		const review = reviewOver(BLOCKS_BODY, proposed);

		const accepted = editorWith(
			fromMarkdown(getEditorMarkdownForSave(review) ?? ""),
		);

		expect(emptyTextblocks(accepted)).toBe(0);
		expect(accepted.getJSON()).toEqual(
			editorWith(fromMarkdown(proposed)).getJSON(),
		);
	});
});
