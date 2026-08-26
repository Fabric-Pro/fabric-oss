"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import type { DerivedDiffViews } from "../lib/diff-view-modes";
import { advancedExtensions } from "../lib/tiptap-extensions-advanced";

interface DiffPreviewPanesProps {
	mode: "sideBySide" | "fullPreview";
	derived: DerivedDiffViews;
	className?: string;
}

/**
 * Read-only preview renderings of the proposed document change.
 *
 * - `sideBySide`: two panes — Original (before, removals kept marked) on the
 *   left and Proposed (after, additions kept marked) on the right — laid out
 *   side by side on wide viewports and stacked (Original above Proposed) on
 *   narrow ones.
 * - `fullPreview`: a single pane of the clean proposed document, with no diff
 *   markup (what the document looks like after accepting every change).
 *
 * Each pane renders through a read-only Tiptap editor (the same
 * `advancedExtensions` the live editor uses, mirroring `VersionDiffViewer`),
 * NOT a raw `innerHTML` injection — so NodeView-backed content (Mermaid /
 * Excalidraw diagrams, images, syntax-highlighted code, tables) renders exactly
 * as it does in the editor, instead of leaking its serialized source as text.
 * The panes are read-only and never mutate the pending diff.
 */
export function DiffPreviewPanes({
	mode,
	derived,
	className,
}: DiffPreviewPanesProps) {
	const t = useTranslations("tooltips.documentEditor");

	if (mode === "fullPreview") {
		return (
			<div className={cn("p-4", className)}>
				<DiffPane
					key="clean"
					label={t("diffPaneProposed")}
					html={derived.cleanProposedHtml}
				/>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"grid grid-cols-1 gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-2",
				className,
			)}
		>
			{/* gap-px over a bg-border parent draws a single hairline divider
			    between the panes (and only between rows when stacked). */}
			<DiffPane
				key="original"
				label={t("diffPaneOriginal")}
				html={derived.originalHtml}
				showHeader
			/>
			<DiffPane
				key="proposed"
				label={t("diffPaneProposed")}
				html={derived.proposedHtml}
				showHeader
			/>
		</div>
	);
}

interface DiffPaneProps {
	label: string;
	html: string;
	/** Render the visible muted column header (side-by-side only). */
	showHeader?: boolean;
}

/**
 * A single read-only document pane.
 *
 * Rendered via a read-only Tiptap editor seeded with the derived HTML (the
 * editor's own `getHTML()` output run through `deriveDiffViews`). Using a real
 * editor with the same `advancedExtensions` as the live document editor means
 * NodeView-backed content (Mermaid / Excalidraw diagrams, images, code blocks)
 * renders identically here, rather than showing its serialized
 * `<div data-type="mermaid">…</div>` source as plain text (which a raw
 * `innerHTML` injection would). The `streaming-diff-active > .tiptap` ancestry
 * reproduces the editor's diff-CSS gating so kept `<ins>`/`<del>` marks and
 * `table[data-diff]` tables pick up their highlight styling.
 * `immediatelyRender: false` keeps it SSR-safe.
 */
function DiffPane({ label, html, showHeader }: DiffPaneProps) {
	const editor = useEditor(
		{
			extensions: advancedExtensions,
			content: html,
			editable: false,
			immediatelyRender: false,
			editorProps: {
				attributes: { class: "tiptap p-4" },
			},
		},
		[html],
	);

	return (
		<section aria-label={label} className="min-w-0 bg-card">
			{showHeader ? (
				<div className="border-b border-border px-3 py-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.1em]">
					{label}
				</div>
			) : null}
			<div className="streaming-diff-active">
				<div className="prose prose-sm dark:prose-invert max-w-none">
					<EditorContent editor={editor} />
				</div>
			</div>
		</section>
	);
}
