import type { Editor } from "@tiptap/core";
import { useCallback, useSyncExternalStore } from "react";

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

/** The part of an editor `useEditorEditable` reads and listens to. */
interface EditableSource {
	isEditable: boolean;
	on: (event: "update", listener: () => void) => unknown;
	off: (event: "update", listener: () => void) => unknown;
}

/**
 * Whether `editor` takes input, read again on every update (Fizzy #2946).
 *
 * A node view that reads `isEditable` while it renders draws its controls
 * for the editor as it was then, and ProseMirror does not draw a node view
 * again for `setEditable`, whose node did not change. A diagram drawn anew
 * while a collaborative editor waited for its room, read-only, kept no menu
 * once the editor took input again. `setEditable` emits an update.
 */
export function useEditorEditable(editor: EditableSource): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			editor.on("update", onChange);
			return () => {
				editor.off("update", onChange);
			};
		},
		[editor],
	);
	const read = () => editor.isEditable;
	return useSyncExternalStore(subscribe, read, read);
}
