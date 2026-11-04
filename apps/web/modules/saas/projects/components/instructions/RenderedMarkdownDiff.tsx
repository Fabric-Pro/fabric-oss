"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useMemo } from "react";
import { diffPartialText, fromMarkdown } from "../../lib/diff-utils";
import { advancedExtensions } from "../../lib/tiptap-extensions-advanced";
import "../DocumentEditor.css";

/**
 * A Markdown change rendered the way the document editor shows one: the
 * editor's own diff (`diffPartialText`, the pipeline `VersionDiffViewer`
 * uses) drawn by a read-only editor, so added and removed text is marked
 * inside its paragraph, heading or list item. Direction is (before, after),
 * so additions are what the proposal brings.
 *
 * Its own module, loaded lazily: the editor and its extensions are heavy,
 * and most reviews never open a Markdown change.
 */
export default function RenderedMarkdownDiff({
	before,
	after,
	label,
}: {
	before: string;
	after: string;
	/** The region's accessible name. */
	label: string;
}) {
	const html = useMemo(
		() => fromMarkdown(diffPartialText(before, after, true)),
		[before, after],
	);
	const editor = useEditor(
		{
			extensions: advancedExtensions,
			content: html,
			editable: false,
			immediatelyRender: false,
			editorProps: { attributes: { class: "tiptap p-3" } },
		},
		[html],
	);
	return (
		<section
			aria-label={label}
			className="max-h-64 overflow-auto rounded-md border bg-card text-sm"
			data-testid="proposal-rendered-diff"
		>
			<EditorContent editor={editor} />
		</section>
	);
}
