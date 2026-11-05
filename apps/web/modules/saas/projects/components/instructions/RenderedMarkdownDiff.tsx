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
 * so additions are what the proposal brings. The `streaming-diff-active`
 * ancestor is what the editor's diff CSS is gated on: without it additions and
 * removals are in the DOM with no visible highlight. `prose` draws the lists.
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
			<div className="streaming-diff-active">
				<div className="prose prose-sm dark:prose-invert max-w-none">
					<EditorContent editor={editor} />
				</div>
			</div>
		</section>
	);
}
