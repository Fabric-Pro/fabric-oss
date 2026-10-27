/**
 * `whenEditorEditable` (Fizzy #2946): work that finishes while an editor
 * takes no input waits for it, and is dropped when the editor goes first.
 */

import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { whenEditorEditable } from "../when-editor-editable";

let editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors) {
		if (!editor.isDestroyed) {
			editor.destroy();
		}
	}
	editors = [];
});

function makeEditor(editable: boolean) {
	const editor = new Editor({
		extensions: [StarterKit],
		content: "<p>Body</p>",
		editable,
	});
	editors.push(editor);
	return editor;
}

describe("whenEditorEditable", () => {
	it("answers at once for an editor that takes input", async () => {
		await expect(whenEditorEditable(makeEditor(true))).resolves.toBe(true);
	});

	it("waits until the editor takes input again", async () => {
		const editor = makeEditor(false);
		let settled: boolean | null = null;
		void whenEditorEditable(editor).then((editable) => {
			settled = editable;
		});
		await Promise.resolve();
		editor.setEditable(false);
		await Promise.resolve();
		expect(settled).toBeNull();

		editor.setEditable(true);
		await Promise.resolve();
		expect(settled).toBe(true);
	});

	it("answers false when the editor is destroyed first, or already was", async () => {
		const editor = makeEditor(false);
		const waiting = whenEditorEditable(editor);
		editor.destroy();
		await expect(waiting).resolves.toBe(false);
		await expect(whenEditorEditable(editor)).resolves.toBe(false);
	});
});
