import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { advancedExtensions } from "../tiptap-extensions-advanced";

/**
 * The pull ingester substitutes a bracketed text token when a PM-tool image or
 * file cannot be downloaded (`placeholderHtml` / `filePlaceholderHtml` in
 * `@repo/integrations/pm/pull-image-ingest`). Styling it must not rewrite the
 * text: the push pipeline strips those tokens by exact wording, and a
 * placeholder that survives a push overwrites the real attachment reference in
 * the PM tool.
 *
 * Styling therefore rides on a ProseMirror decoration, which is recomputed
 * from doc state on every transaction. An earlier DOM-mutation approach was
 * silently reverted the moment the user typed — these tests pin that it isn't.
 */

const PLACEHOLDER = "[Image could not be imported from Azure DevOps: shot.png]";

function createEditor(html: string): Editor {
	return new Editor({ extensions: advancedExtensions, content: html });
}

function markedCount(editor: Editor): number {
	return editor.view.dom.querySelectorAll(".media-unavailable-raw").length;
}

/** The rendered stand-in messages, in document order. */
function messages(editor: Editor): Element[] {
	return Array.from(
		editor.view.dom.querySelectorAll("[data-media-import-error]"),
	);
}

describe("media import placeholder decoration", () => {
	it("styles a failed image-import placeholder", () => {
		const editor = createEditor(`<p><em>${PLACEHOLDER}</em></p>`);

		expect(markedCount(editor)).toBe(1);

		editor.destroy();
	});

	it("styles a failed file-attachment placeholder", () => {
		const editor = createEditor(
			"<p><em>[Attachment could not be imported from Fizzy: spec.pdf]</em></p>",
		);

		expect(markedCount(editor)).toBe(1);

		editor.destroy();
	});

	it("keeps the styling after an edit elsewhere in the document", () => {
		// The regression: a class written straight onto the paragraph DOM is
		// dropped when ProseMirror re-renders that paragraph from doc state.
		const editor = createEditor(
			`<p>Intro paragraph.</p><p><em>${PLACEHOLDER}</em></p>`,
		);
		expect(markedCount(editor)).toBe(1);

		editor.commands.focus("start");
		editor.commands.insertContent("edited ");

		expect(markedCount(editor)).toBe(1);

		editor.destroy();
	});

	it("leaves the placeholder text byte-for-byte intact", () => {
		const editor = createEditor(`<p><em>${PLACEHOLDER}</em></p>`);

		expect(editor.getText().trim()).toBe(PLACEHOLDER);

		editor.destroy();
	});

	it("does not persist the styling into saved HTML", () => {
		// Decorations live outside the document, so a save must not carry the
		// presentation class back to the PM tool.
		const editor = createEditor(`<p><em>${PLACEHOLDER}</em></p>`);

		expect(editor.getHTML()).not.toContain("media-unavailable");

		editor.destroy();
	});

	it("ignores ordinary prose that merely contains brackets", () => {
		const editor = createEditor(
			"<p>See [the spec] for the import rules.</p>",
		);

		expect(markedCount(editor)).toBe(0);

		editor.destroy();
	});

	describe("presentation", () => {
		// The stored token is machine text: bracketed because the push pipeline
		// strips it by exact wording. Showing those brackets to a reader leaks an
		// implementation constraint into the UI, so the raw paragraph is hidden
		// and a widget carrying clean wording stands in for it. The document is
		// still never rewritten — see the byte-for-byte case above.
		it("shows clean wording with no brackets", () => {
			const editor = createEditor(`<p><em>${PLACEHOLDER}</em></p>`);

			const message = messages(editor)[0]?.textContent ?? "";
			expect(message).toBe(
				"Image unavailable — could not be imported from Azure DevOps: shot.png",
			);
			expect(message).not.toContain("[");

			editor.destroy();
		});

		it("names an attachment as an attachment", () => {
			const editor = createEditor(
				"<p><em>[Attachment could not be imported from Fizzy: spec.pdf]</em></p>",
			);

			expect(messages(editor)[0]?.textContent).toBe(
				"Attachment unavailable — could not be imported from Fizzy: spec.pdf",
			);

			editor.destroy();
		});

		it("reads without a provider or a file name", () => {
			const editor = createEditor(
				"<p><em>[Image could not be imported]</em></p>",
			);

			expect(messages(editor)[0]?.textContent).toBe(
				"Image unavailable — could not be imported",
			);

			editor.destroy();
		});

		it("hides the raw token so only the clean message is read", () => {
			const editor = createEditor(`<p><em>${PLACEHOLDER}</em></p>`);

			expect(
				editor.view.dom.querySelectorAll(".media-unavailable-raw"),
			).toHaveLength(1);

			editor.destroy();
		});

		it("shares one presentation with the broken-image fallback", () => {
			const editor = createEditor(`<p><em>${PLACEHOLDER}</em></p>`);

			expect(messages(editor)[0]?.classList).toContain(
				"media-unavailable",
			);

			editor.destroy();
		});

		it("draws its icon with an svg that inherits the text colour", () => {
			// An emoji renders per-platform and ignores `currentColor`, so it can
			// never match the lucide icons used everywhere else in Fabric.
			const editor = createEditor(`<p><em>${PLACEHOLDER}</em></p>`);

			const icon = messages(editor)[0]?.querySelector("svg");

			expect(icon?.getAttribute("stroke")).toBe("currentColor");
			expect(icon?.getAttribute("aria-hidden")).toBe("true");

			editor.destroy();
		});

		it("keeps the presentation out of saved HTML", () => {
			const editor = createEditor(`<p><em>${PLACEHOLDER}</em></p>`);

			expect(editor.getHTML()).not.toContain("media-unavailable");
			expect(editor.getHTML()).not.toContain("svg");

			editor.destroy();
		});
	});
});
