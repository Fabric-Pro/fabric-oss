"use client";

import { Node } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef } from "react";
import { INSTRUCTIONS_ROOT_BLOCK_ID } from "@repo/ai/sidekick/constants";
import { BlockIdExtension } from "./BlockIdExtension";
import { InstructionSuggestionExtension } from "./InstructionSuggestionExtension";
import { InstructionsRootExtension } from "./InstructionsRootExtension";

/**
 * Custom Document node that overrides the default `doc` content spec
 * to require an `instructionsRoot` wrapper node instead of raw `block+`.
 * This ensures all block content lives inside the InstructionsRoot
 * container, giving the Sidekick LLM a stable target for full rewrites.
 */
const InstructionsDocument = Node.create({
	name: "doc",
	topNode: true,
	content: "instructionsRoot",
});

/**
 * Build the editor extension set:
 * - StarterKit with `document: false` so we can substitute our own doc node
 * - InstructionsDocument overrides the doc content spec
 * - InstructionsRootExtension provides the wrapper node
 * - BlockIdExtension adds stable `data-block-id` attributes
 */
const extensions = [
	StarterKit.configure({ document: false }),
	InstructionsDocument,
	InstructionsRootExtension,
	BlockIdExtension,
	InstructionSuggestionExtension,
];

// ---------------------------------------------------------------------------

interface InstructionsEditorProps {
	/** Initial HTML content for the editor. */
	content: string;
	/** Called on every content change with plain text and HTML-with-block-ids. */
	onChange: (plainText: string, html: string) => void;
	/** Optional additional CSS classes on the wrapper. */
	className?: string;
}

/**
 * Wrap raw HTML content in the `instructionsRoot` wrapper if it doesn't
 * already contain one. This ensures content round-trips correctly through
 * the custom document schema.
 */
function wrapInRoot(html: string): string {
	if (html.includes('data-type="instructions-root"')) {
		return html;
	}
	// If blank or plain text, wrap it in a paragraph inside the root
	const inner = html.trim() || "<p></p>";
	return `<div data-type="instructions-root" data-block-id="${INSTRUCTIONS_ROOT_BLOCK_ID}">${inner}</div>`;
}

/**
 * InstructionsEditor — a TipTap rich-text editor for the agent instructions
 * field. Adds stable `data-block-id` attributes to every block-level node
 * so the Sidekick LLM can suggest targeted prompt edits.
 *
 * Usage:
 * ```tsx
 * <InstructionsEditor
 *   content={htmlContent}
 *   onChange={(text, html) => {
 *     setSystemPromptMarkdown(text);
 *     setSystemPromptHtml(html);
 *   }}
 * />
 * ```
 */
export function InstructionsEditor({
	content,
	onChange,
	className,
}: InstructionsEditorProps) {
	// Debounce ref to avoid excessive onChange calls during fast typing
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleUpdate = useCallback(
		({ editor }: { editor: ReturnType<typeof useEditor> }) => {
			if (!editor) {
				return;
			}

			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}

			debounceTimerRef.current = setTimeout(() => {
				const plainText = editor.getText();
				const html = editor.getHTML();
				onChange(plainText, html);
			}, 150);
		},
		[onChange],
	);

	const editor = useEditor({
		extensions,
		content: wrapInRoot(content),
		immediatelyRender: false,
		onUpdate: handleUpdate,
		editorProps: {
			attributes: {
				class: "focus:outline-none min-h-[200px] p-4",
			},
		},
	});

	// Track whether we've already seeded the editor with real content.
	// When editing an existing agent, the data loads async via useQuery
	// after the editor has already mounted with empty content. This
	// effect re-seeds the editor once real content arrives.
	const hasSeededRef = useRef(false);
	useEffect(() => {
		if (!editor || hasSeededRef.current) {
			return;
		}
		// Only seed when non-empty content arrives (skip the initial empty state)
		if (!content.trim()) {
			return;
		}

		hasSeededRef.current = true;
		// Check if the editor is currently empty (still showing initial blank state)
		const currentText = editor.getText().trim();
		if (!currentText) {
			editor.commands.setContent(wrapInRoot(content));
		}
	}, [editor, content]);

	return (
		<div
			className={[
				"rounded-md border border-input bg-background text-sm",
				"prose prose-sm max-w-none dark:prose-invert",
				"font-mono",
				className,
			]
				.filter(Boolean)
				.join(" ")}
		>
			<EditorContent editor={editor} />
		</div>
	);
}
