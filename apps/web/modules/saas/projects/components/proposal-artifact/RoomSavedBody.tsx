"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useMemo } from "react";
import { fromMarkdown } from "../../lib/diff-utils";
import { createAdvancedExtensions } from "../../lib/tiptap-extensions-advanced";

/**
 * The saved body, read-only, outside the room (Fizzy #2946): what a client
 * shows while its room is behind the saved document — a client that may not
 * edit, which never writes the room, or any editor while the room is brought
 * up to date.
 */
export function RoomSavedBody({
	markdown,
	statTiles,
}: {
	markdown: string;
	statTiles: boolean;
}) {
	const extensions = useMemo(
		() =>
			createAdvancedExtensions({
				projectId: null,
				documentId: null,
				statTiles,
			}),
		[statTiles],
	);
	const savedBodyEditor = useEditor(
		{
			extensions,
			editable: false,
			immediatelyRender: false,
			content: markdown ? fromMarkdown(markdown) : "",
		},
		[extensions, markdown],
	);
	return (
		<div data-testid="room-saved-body">
			<EditorContent
				editor={savedBodyEditor}
				className="prose prose-sm max-w-none dark:prose-invert"
			/>
		</div>
	);
}
