import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { advancedExtensions } from "../tiptap-extensions-advanced";

/**
 * An `<img>` whose `src` never resolves — an expired story-media signed URL, a
 * storage blip, a legacy description carrying a PM-tool attachment URL the
 * browser cannot authenticate — otherwise paints the browser's native
 * broken-image icon with no explanation (Fizzy card 2027).
 *
 * The fallback message is presented as a ProseMirror WIDGET DECORATION rather
 * than a node spliced into the editable DOM. The earlier DOM-mutation approach
 * put a real `<span>` inside the contenteditable; ProseMirror's DOM observer
 * read it back as document content, so "Image unavailable…" was saved into the
 * body and grew on every open/save cycle. A decoration lives outside the
 * document, so it cannot be serialised into a save or pushed to a PM tool.
 */

const BROKEN = "https://example.invalid/shot.png";

function createEditor(html: string): Editor {
	return new Editor({ extensions: advancedExtensions, content: html });
}

function brokenImage(editor: Editor): HTMLImageElement {
	const img = editor.view.dom.querySelector(
		"img:not(.ProseMirror-separator)",
	);
	if (!img) {
		throw new Error("no content image rendered");
	}
	return img as HTMLImageElement;
}

function fallbacks(editor: Editor): Element[] {
	return Array.from(
		editor.view.dom.querySelectorAll("[data-image-load-error]"),
	);
}

describe("image load fallback", () => {
	it("shows a readable message when an image fails to load", () => {
		const editor = createEditor(`<img src="${BROKEN}" alt="shot.png">`);

		brokenImage(editor).dispatchEvent(new Event("error"));

		expect(fallbacks(editor)).toHaveLength(1);
		expect(fallbacks(editor)[0]?.textContent).toContain("shot.png");

		editor.destroy();
	});

	it("leaves an image that loads successfully untouched", () => {
		const editor = createEditor(`<img src="${BROKEN}" alt="shot.png">`);

		brokenImage(editor).dispatchEvent(new Event("load"));

		expect(fallbacks(editor)).toHaveLength(0);

		editor.destroy();
	});

	it("does not write the message into the document when ProseMirror re-reads the DOM", () => {
		// The regression that shipped: the message was a real element inside the
		// contenteditable, so ProseMirror's DOM observer parsed it into the
		// document and the next autosave persisted it — growing by one copy per
		// open/save cycle, and pushed to the PM tool in place of the image.
		//
		// Honest limitation: jsdom's MutationObserver records nothing for that
		// insertion, so this assertion also holds for the broken implementation
		// — it guards the invariant but did not, on its own, catch the bug. The
		// leak was reproduced against the real browser on staging; the guards
		// that DO fail against the DOM-mutation version are the duplicate-after-
		// edit and separator cases below, which share its root cause.
		const editor = createEditor(`<img src="${BROKEN}" alt="shot.png">`);
		const htmlBefore = editor.getHTML();

		brokenImage(editor).dispatchEvent(new Event("error"));
		editor.view.domObserver.flush();

		expect(editor.getText()).not.toContain("Image unavailable");
		expect(editor.getHTML()).toBe(htmlBefore);

		editor.destroy();
	});

	it("keeps exactly one message after an edit elsewhere in the document", () => {
		// Re-rendering the image from doc state used to strand the old inserted
		// node and add a second one beside the fresh <img>.
		const editor = createEditor(
			`<p>Intro.</p><img src="${BROKEN}" alt="shot.png">`,
		);
		brokenImage(editor).dispatchEvent(new Event("error"));

		editor.commands.focus("start");
		editor.commands.insertContent("edited ");

		expect(fallbacks(editor)).toHaveLength(1);

		editor.destroy();
	});

	it("ignores ProseMirror's own separator image", () => {
		// ProseMirror emits <img class="ProseMirror-separator"> beside inline
		// leaf nodes. It carries no `src`, so it reports complete === true and
		// naturalWidth === 0 — exactly the state a broken image reports — and a
		// naive sweep labelled it "Image unavailable" next to a healthy picture.
		const editor = createEditor(
			`<p>x</p><img src="${BROKEN}" alt="a.png">`,
		);

		const separator = editor.view.dom.querySelector(
			"img.ProseMirror-separator",
		);
		expect(separator).not.toBeNull();
		separator?.dispatchEvent(new Event("error"));

		expect(fallbacks(editor)).toHaveLength(0);

		editor.destroy();
	});

	it("names the file from a fileName query parameter", () => {
		// Azure DevOps attachment URLs put the filename in the query string and
		// a bare GUID in the path, so the path segment alone is meaningless.
		const editor = createEditor(
			'<img src="https://dev.azure.com/org/_apis/wit/attachments/00000000-0000-0000-0000-000000000000?fileName=screenshot.png">',
		);

		brokenImage(editor).dispatchEvent(new Event("error"));

		expect(fallbacks(editor)[0]?.textContent).toContain("screenshot.png");

		editor.destroy();
	});

	it("clears the message when a refreshed src loads", () => {
		// Both editors re-resolve expired story-media signed URLs shortly after
		// mount, so error → fresh src → load is the common sequence.
		const editor = createEditor(`<img src="${BROKEN}" alt="shot.png">`);
		const img = brokenImage(editor);

		img.dispatchEvent(new Event("error"));
		expect(fallbacks(editor)).toHaveLength(1);
		img.dispatchEvent(new Event("load"));

		expect(fallbacks(editor)).toHaveLength(0);

		editor.destroy();
	});

	it("does not spell out a data: URI payload as the file name", () => {
		const editor = createEditor(
			`<img src="data:image/png;base64,${"A".repeat(4000)}">`,
		);

		brokenImage(editor).dispatchEvent(new Event("error"));

		expect(fallbacks(editor)[0]?.textContent).toBe("Image unavailable");

		editor.destroy();
	});

	it("truncates an absurdly long derived name", () => {
		const editor = createEditor(
			`<img src="https://example.invalid/${"n".repeat(500)}.png">`,
		);

		brokenImage(editor).dispatchEvent(new Event("error"));

		expect(
			fallbacks(editor)[0]?.textContent?.length ?? 0,
		).toBeLessThanOrEqual(100);

		editor.destroy();
	});

	describe("presentation", () => {
		it("draws its icon with an svg that inherits the text colour", () => {
			// Was an emoji, which renders per-platform, ignores `currentColor`,
			// and never matches the lucide icons used elsewhere in Fabric.
			const editor = createEditor(`<img src="${BROKEN}" alt="shot.png">`);
			brokenImage(editor).dispatchEvent(new Event("error"));

			const icon = fallbacks(editor)[0]?.querySelector("svg");

			expect(icon?.getAttribute("stroke")).toBe("currentColor");
			expect(icon?.getAttribute("aria-hidden")).toBe("true");

			editor.destroy();
		});

		it("shares one presentation with the failed-import placeholder", () => {
			const editor = createEditor(`<img src="${BROKEN}" alt="shot.png">`);
			brokenImage(editor).dispatchEvent(new Event("error"));

			expect(fallbacks(editor)[0]?.classList).toContain(
				"media-unavailable",
			);

			editor.destroy();
		});
	});
});
