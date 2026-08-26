/**
 * Round-trip test for the typed group mention node (Task 10 of #1767 Stage 5).
 *
 * Modeled on `tiptap-diff-marks.test.ts`'s `new Editor({ extensions, content })`
 * headless-editor harness: build a real editor instance (no React node view
 * rendering involved — `addNodeView` is present on the extension but jsdom
 * never mounts it here), `setContent` HTML containing a group mention span,
 * then read `editor.getHTML()` back and assert the typed attributes survived
 * the HTML → ProseMirror doc → HTML round-trip.
 */

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { MentionExtension } from "../mention-extension";

function createEditor(html: string): Editor {
	return new Editor({
		extensions: [StarterKit, MentionExtension],
		content: html,
	});
}

describe("group mention round-trip", () => {
	it("retains data-group-tag and data-mention-id through HTML -> editor -> HTML", () => {
		const html =
			'<p><span data-type="mention" data-group-tag="DEVELOPER" ' +
			'data-label="Developers" data-mention-id="m_x">@Developers</span></p>';

		const editor = createEditor(html);
		const out = editor.getHTML();
		editor.destroy();

		expect(out).toContain('data-group-tag="DEVELOPER"');
		expect(out).toContain('data-mention-id="m_x"');
		expect(out).toContain("@Developers");
	});
});
