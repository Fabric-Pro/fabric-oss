"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useMemo } from "react";
import { fromMarkdown } from "../../lib/diff-utils";
import { createAdvancedExtensions } from "../../lib/tiptap-extensions-advanced";

/**
 * The saved body, read-only, outside the room (Fizzy #2946): what a client
 * shows while its room is behind the saved document — a client that may not
 * edit, which never writes the room, or any editor while the room is brought
 * up to date. Its editor is created after the first render, so it is mounted
 * hidden (`shown` false) ahead of the moment it may take over: shown then, it
 * is drawn with its text from the first frame.
 */
export function RoomSavedBody({
	markdown,
	statTiles,
	shown = true,
}: {
	markdown: string;
	statTiles: boolean;
	shown?: boolean;
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
		<div
			data-testid={shown ? "room-saved-body" : "room-saved-body-ready"}
			className={shown ? undefined : "hidden"}
		>
			<EditorContent
				editor={savedBodyEditor}
				className="prose prose-sm max-w-none dark:prose-invert"
			/>
		</div>
	);
}
