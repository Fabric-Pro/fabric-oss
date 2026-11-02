/**
 * A content fence whose language is not in lower case (Fizzy #2946).
 *
 * The markdown load lowercases a fence's language before the editor sees it,
 * so a stored ```` ```Cards ```` fence arrives as the canonical `cards`. The
 * class keeps its case where HTML reaches the editor without that step: an
 * AI edit under review, which writes an added fence's language as the model
 * wrote it, or HTML loaded or pasted as it is.
 *
 * The prose hash and the print read a ```` ```Cards ````, ```` ```Columns ````,
 * ```` ```Stat-Tiles ```` or ```` ```Cover ```` fence as content, whatever its
 * first line holds, because they compare the language in any case. Without a
 * guard, the editor's mermaid sniff takes such a fence opening "Timeline
 * risks" as a diagram. The code block's content fence guard matches the language class
 * in any case, so the fence stays a code block of its own language and saves
 * byte for byte. The nodes that draw the forms claim only the lower-case
 * language, so the fence is a code block whether the editor registers them
 * or not.
 */

import { isDiagramFence } from "@repo/utils/proposal-artifact/section-hash";
import { diffPartialText, fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import {
	advancedExtensions,
	createAdvancedExtensions,
} from "@saas/projects/lib/tiptap-extensions-advanced";
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

const lines = (...parts: string[]) => parts.join("\n");

const fence = (language: string, body: string) =>
	lines(`\`\`\`${language}`, body, "```");

/** Bodies opening with a diagram keyword, in a language not in lower case. */
const MIXED_CASE_FENCES = [
	{
		language: "Cards",
		body: lines(
			"Timeline risks",
			"**Vendor delays**",
			"Two suppliers share one port.",
		),
	},
	{ language: "CARDS", body: lines("Timeline risks", "**Vendor delays**") },
	{
		language: "Columns",
		body: lines("graph notes", "---", "### Right", "Text"),
	},
	{
		language: "Stat-Tiles",
		body: lines("Timeline savings: 12 weeks", "Pilot sites: 3"),
	},
	{
		language: "Cover",
		body: lines("block partners: Example Harbor Co", "version: 2"),
	},
] as const;

const EDITOR_SETS = [
	{ set: "the feature editor's set", extensions: () => advancedExtensions },
	{
		set: "the document editor's set",
		extensions: () =>
			createAdvancedExtensions({
				projectId: null,
				documentId: null,
				statTiles: true,
			}),
	},
] as const;

const CASES = EDITOR_SETS.flatMap(({ set, extensions }) =>
	MIXED_CASE_FENCES.map(({ language, body }) => ({
		set,
		extensions,
		language,
		body,
	})),
);

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function topLevelTypes(editor: Editor): string[] {
	const types: string[] = [];
	editor.state.doc.forEach((node) => {
		types.push(node.type.name);
	});
	return types;
}

function saveOf(editor: Editor): string {
	const saved = getEditorMarkdownForSave(editor);
	editor.destroy();
	if (saved === null) {
		throw new Error("serialization failed");
	}
	return saved;
}

describe("a content fence in a language not in lower case", () => {
	it.each(CASES)(
		"$set keeps a $language fence opening with a diagram keyword a code block of that language",
		({ extensions, language, body }) => {
			const editor = new Editor({
				extensions: extensions(),
				content: `<pre><code class="language-${language}">${escapeHtml(body)}</code></pre>`,
			});
			const first = editor.state.doc.child(0);

			// Neither a diagram nor a drawn form: the print reads the same
			// fence as content, and the nodes claim only the lower case.
			expect(isDiagramFence(language, body)).toBe(false);
			expect(topLevelTypes(editor)).toEqual(["codeBlock"]);
			expect(first.attrs.language).toBe(language);
			expect(saveOf(editor)).toBe(fence(language, body));
		},
	);

	it.each(EDITOR_SETS)(
		"$set keeps a Cards fence an AI edit adds a code block under review, and saves it byte for byte",
		({ extensions }) => {
			const baseline = lines("## Risks", "", "The pilot follows.");
			const body = MIXED_CASE_FENCES[0].body;
			const proposed = lines(
				"## Risks",
				"",
				fence("Cards", body),
				"",
				"The pilot follows.",
			);
			const editor = new Editor({
				extensions: extensions(),
				content: fromMarkdown(
					diffPartialText(baseline, proposed, true),
				),
			});
			const added = editor.state.doc.child(1);
			const marks = new Set<string>();
			added.forEach((child) => {
				for (const mark of child.marks) {
					marks.add(mark.type.name);
				}
			});

			expect(topLevelTypes(editor)).toEqual([
				"heading",
				"codeBlock",
				"paragraph",
			]);
			expect(added.attrs.language).toBe("Cards");
			expect(marks).toEqual(new Set(["diffInsert"]));
			expect(saveOf(editor)).toBe(proposed);
		},
	);

	it.each(CASES)(
		"$set never reads a $language markdown fence as a diagram",
		({ extensions, language, body }) => {
			const markdown = lines(
				"## Risks",
				"",
				fence(language, body),
				"",
				"The pilot follows.",
			);
			const editor = new Editor({
				extensions: extensions(),
				content: fromMarkdown(markdown),
			});

			expect(topLevelTypes(editor)).not.toContain("mermaidBlock");
			expect(saveOf(editor)).not.toContain("```mermaid");
		},
	);
});
