/**
 * The prose hash and the editor agree on which fences are diagrams
 * (Fizzy #2946).
 *
 * A Proposal section's prose hash counts a diagram fence for nothing, and
 * knows one by `DIAGRAM_LANGUAGES`: a restatement of the editor's
 * `MERMAID_LANGUAGES`, the fence languages it renders as a diagram and saves
 * as `mermaid`, since the shared package cannot import the editor. A
 * language on one list only would let a save that changes no text change a
 * section's hash, so the two lists must stay equal.
 *
 * The editor's first-line diagram keywords are a local list inside its
 * parse rule, not an export, so they are not compared here. What is
 * compared is the other side of that sniff: a stat tiles, cards or columns
 * fence is never a diagram for the hash, whatever its first line holds, so
 * an editor without the nodes that draw them must keep it a code block of
 * its own language too.
 */

import {
	CARDS_LANGUAGE,
	COLUMNS_LANGUAGE,
} from "@repo/utils/proposal-artifact/proposal-blocks";
import {
	DIAGRAM_LANGUAGES,
	isDiagramFence,
} from "@repo/utils/proposal-artifact/section-hash";
import { STAT_TILES_LANGUAGE } from "@repo/utils/proposal-artifact/stat-tiles";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { advancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { MERMAID_LANGUAGES } from "@saas/projects/lib/tiptap-mermaid-extension";
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

describe("diagram fence languages", () => {
	it("are the same for the prose hash as for the editor", () => {
		expect([...DIAGRAM_LANGUAGES].sort()).toEqual(
			[...new Set(MERMAID_LANGUAGES)].sort(),
		);
	});

	it.each([
		{ language: STAT_TILES_LANGUAGE, body: "Timeline savings: 12 weeks" },
		{
			language: CARDS_LANGUAGE,
			body: "Timeline risks\n**Vendor delays**",
		},
		{ language: COLUMNS_LANGUAGE, body: "graph notes\n---\nText" },
	])(
		"leave a $language fence opening with a diagram keyword a code block for both",
		({ language, body }) => {
			const block = `\`\`\`${language}\n${body}\n\`\`\``;
			const editor = new Editor({
				extensions: advancedExtensions,
				content: fromMarkdown(block),
			});
			const first = editor.state.doc.child(0);
			const saved = getEditorMarkdownForSave(editor);
			editor.destroy();

			expect(isDiagramFence(language, body)).toBe(false);
			expect(first.type.name).toBe("codeBlock");
			expect(first.attrs.language).toBe(language);
			expect(saved).toBe(block);
		},
	);
});
