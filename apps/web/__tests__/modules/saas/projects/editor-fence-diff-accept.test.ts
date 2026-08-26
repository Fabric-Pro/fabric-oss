/**
 * Accepting an AI edit that lands inside a fenced code block.
 *
 * `stripDiffTags` removes deleted text by finding a matched
 * `<del class="diff-del">…</del>` pair in the editor's HTML. That only works if
 * the pair is still there to find. `DiffDelete` is a ProseMirror **mark**, and a
 * code block whose schema forbids marks drops the tag on parse while keeping the
 * text it wrapped — so by save time there is nothing left to strip and the old
 * value is written to the database concatenated with the new one.
 *
 * The bug is silent and the corruption is permanent: a spec whose fenced
 * requirement read `const timeout = 30` and was edited to `90` saved as `3090`.
 * Fabric Full Specifications routinely carry gherkin, JSON and schema fences, so
 * the same run could replace prose correctly and corrupt a fence — which is what
 * made this look intermittent rather than deterministic.
 *
 * These drive the real editor and the real save path rather than asserting on
 * `stripDiffTags` in isolation, because the defect lives in the parse step
 * between them and a unit test either side of it would have stayed green.
 */
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { getEditorMarkdownForSave } from "../../../../modules/saas/projects/lib/editor-markdown-save";
import { advancedExtensions } from "../../../../modules/saas/projects/lib/tiptap-extensions-advanced";

function acceptedMarkdown(html: string): string {
	const editor = new Editor({
		extensions: advancedExtensions,
		content: html,
	});
	const saved = getEditorMarkdownForSave(editor) ?? "";
	editor.destroy();
	return saved;
}

describe("accepting a diff that falls inside a fenced code block", () => {
	it("replaces the value in a ts fence instead of concatenating it", () => {
		const saved = acceptedMarkdown(
			`<pre><code class="language-ts">const timeout = <del class="diff-del">30</del><ins class="diff-ins">90</ins>;</code></pre>`,
		);

		expect(saved).toBe("```ts\nconst timeout = 90;\n```");
		// The concatenation this exists to prevent. Asserted explicitly because
		// `toContain("90")` passes on "3090" — the shape of the bug hides from
		// the obvious assertion.
		expect(saved).not.toContain("3090");
	});

	it("replaces the value in a gherkin fence", () => {
		const saved = acceptedMarkdown(
			`<pre><code class="language-gherkin">Given the cart has <del class="diff-del">3</del><ins class="diff-ins">7</ins> items</code></pre>`,
		);

		expect(saved).toBe("```gherkin\nGiven the cart has 7 items\n```");
		expect(saved).not.toContain("37");
	});

	it("still strips a deletion in ordinary prose", () => {
		// The control. Prose always worked; this pins that the schema change did
		// not disturb it.
		const saved = acceptedMarkdown(
			`<p>The timeout is <del class="diff-del">30</del><ins class="diff-ins">90</ins> seconds.</p>`,
		);

		expect(saved).toBe("The timeout is 90 seconds.");
	});

	it("replaces a label inside a mermaid diagram", () => {
		// A mermaid fence is a code block that `MermaidBlock` claims first, via
		// its lower `priority`. It had the identical `marks: ""` problem, so
		// fixing only the code-block node left every diagram in the product
		// still concatenating. Diagrams are common in these specs, so this is
		// not an edge case.
		const saved = acceptedMarkdown(
			`<pre><code class="language-mermaid">flowchart TD\n  A --> <del class="diff-del">B</del><ins class="diff-ins">C</ins></code></pre>`,
		);

		expect(saved).toContain("A --> C");
		expect(saved).not.toContain("BC");
	});

	it("keeps a fence that carries no diff markers byte-for-byte", () => {
		const saved = acceptedMarkdown(
			`<pre><code class="language-json">{ "retries": 3 }</code></pre>`,
		);

		expect(saved).toBe('```json\n{ "retries": 3 }\n```');
	});
});
