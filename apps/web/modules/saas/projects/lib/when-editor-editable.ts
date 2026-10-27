import type { Editor } from "@tiptap/core";

/** The part of an editor `whenEditorEditable` reads and listens to. */
type EditableEditor = Pick<Editor, "isEditable" | "isDestroyed" | "on" | "off">;

/**
 * Resolves `true` once `editor` takes input — at once when it does now — or
 * `false` when it is destroyed first (Fizzy #2946).
 *
 * Commands write an editor whether or not it takes input, so work that
 * finishes while it takes none — an image upload, say, while a run writes
 * the document or another editor reviews an assistant proposal — waits for
 * it rather than writing then. `setEditable` emits an update.
 */
export function whenEditorEditable(editor: EditableEditor): Promise<boolean> {
	if (editor.isDestroyed) {
		return Promise.resolve(false);
	}
	if (editor.isEditable) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const settle = (editable: boolean) => {
			editor.off("update", onUpdate);
			editor.off("destroy", onDestroy);
			resolve(editable);
		};
		const onUpdate = () => {
			if (editor.isEditable) {
				settle(true);
			}
		};
		const onDestroy = () => settle(false);
		editor.on("update", onUpdate);
		editor.on("destroy", onDestroy);
	});
}
