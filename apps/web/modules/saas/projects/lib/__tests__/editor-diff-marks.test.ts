/**
 * Whether an editor's body holds an assistant proposal still waiting for its
 * answer (Fizzy #2946): the shapes a proposal leaves in the editor — marked
 * text, a marked diagram source, a table proposed for addition or deletion —
 * and nothing else, ordinary strikethrough included; and the whole proposal
 * rejected in place, leaving everything else in the body.
 */

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { diffPartialText, fromMarkdown } from "../diff-utils";
import { editorHoldsDiffMarks, rejectAllChanges } from "../editor-diff-marks";
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
