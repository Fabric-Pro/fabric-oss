"use client";

/**
 * The editor for a topic's Planning & Analysis prose (Fizzy #1851, Task 9).
 *
 * A standalone TipTap editor assembled from the same shared parts as
 * `DocumentGeneratorEditor.tsx` — `advancedExtensions`, `EditorToolbar`,
 * `getEditorMarkdownForSave` — but with none of that component's AI-streaming
 * machinery. This editor only does one thing: let an author hand-edit the
 * analysis prose and save an explicit revision. No autosave — the hardest
 * defect in the precedent this feature is built on (Fizzy #1929) came from an
 * autosave racing an in-flight agent run and overwriting the server with
 * pre-answer text. An explicit Save button removes that class of bug rather
 * than defending against it.
 *
 * Two guards carried over from `StoryWorkspace.tsx`'s save path, both paid for
 * by a past incident:
 *
 *   1. `getEditorMarkdownForSave` returns `null` — not `""` — when the
 *      Turndown serialization throws. Saving `null` would persist `body:
 *      null` and destroy the document, so a null read refuses the save and
 *      tells the author to copy their text somewhere safe instead.
 *   2. Raw (markdown) mode saves the textarea verbatim. It never runs
 *      `repairMarkdownDocument` on save — that call belongs only to the
 *      raw→rich view transition, where the user has asked to see the text
 *      rendered. Running it on save would silently rewrite a hand-edit the
 *      moment the author typed it.
 */

import { EditorToolbar } from "@saas/projects/components/EditorToolbar";
import {
	fromMarkdown,
	repairMarkdownDocument,
} from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { advancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	AlertTriangleIcon,
	Code2Icon,
	EyeIcon,
	Loader2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const SERIALIZATION_FAILURE_MESSAGE =
	"Couldn't save your changes — the editor content could not be read. Your text is still here; please copy it somewhere safe and reload the page.";
const CONFLICT_MESSAGE =
	"The analysis changed while you were editing. Refresh and try again.";
const STALE_SOURCE_MESSAGE =
	"That analysis version is no longer available. Refresh and try again.";
const GENERIC_SAVE_FAILURE_MESSAGE =
	"Could not save the planning analysis. Refresh and try again.";

interface SaveAnalysisRevisionResult {
	saved: true;
	version: number;
}

export interface PlanningAnalysisEditorProps {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	/** The prose to seed the editor with, as markdown. */
	prose: string;
	/**
	 * The revision this editor was loaded against. Becomes `expectedVersion`
	 * verbatim — `null` before the first hand-edit exists.
	 */
	revisionVersion: number | null;
	/**
	 * The READY analysis version this prose was seeded from. `null` only when
	 * no READY analysis exists at all — there is then nothing a save could
	 * name as its source, and the server would refuse it, so Save stays
	 * disabled in that state.
	 */
	sourceAnalysisVersion: number | null;
	canEdit: boolean;
	onSaved?: (version: number) => void;
}

export function PlanningAnalysisEditor({
	projectId,
	topicId,
	organizationId,
	prose,
	revisionVersion,
	sourceAnalysisVersion,
	canEdit,
	onSaved,
}: PlanningAnalysisEditorProps) {
	const [viewMode, setViewMode] = useState<"rich" | "raw">("rich");
	const [rawContent, setRawContent] = useState(prose);
	const [saveError, setSaveError] = useState<string | null>(null);

	const editor = useEditor({
		extensions: advancedExtensions,
		content: fromMarkdown(prose),
		editable: canEdit,
		immediatelyRender: false,
		editorProps: {
			attributes: { class: "p-4 tiptap" },
		},
	});

	useEffect(() => {
		editor?.setEditable(canEdit);
	}, [editor, canEdit]);

	const saveMutation = useMutation(
		orpc.projects.publishingSuite.saveAnalysisRevision.mutationOptions({
			onSuccess: (result: SaveAnalysisRevisionResult) => {
				setSaveError(null);
				toast.success("Planning analysis saved.");
				onSaved?.(result.version);
			},
			onError: (error: unknown) => {
				// Both a lost race (CONFLICT) and a stale source version
				// (BAD_REQUEST) are recoverable states, not crashes — the
				// author's edit is still on screen and a refresh resolves
				// either one.
				const code = (error as { code?: string } | null)?.code;
				const message =
					code === "CONFLICT"
						? CONFLICT_MESSAGE
						: code === "BAD_REQUEST"
							? STALE_SOURCE_MESSAGE
							: GENERIC_SAVE_FAILURE_MESSAGE;
				setSaveError(message);
				toast.error(message);
			},
		}),
	);

	const handleViewModeToggle = () => {
		if (viewMode === "raw") {
			// Leaving raw mode: the ONE place a hand-edited markdown document
			// may be repaired. The user is done editing it as text and is
			// asking to see it rendered — running repair on Save instead
			// would silently rewrite what they typed (see handleSave below).
			const normalized = repairMarkdownDocument(rawContent);
			setRawContent(normalized);
			editor?.commands.setContent(fromMarkdown(normalized));
			setViewMode("rich");
			return;
		}
		// Entering raw mode: capture the rich editor's current markdown so the
		// textarea starts from what is actually on screen. A failed read
		// keeps the last-known-good raw text rather than blanking it.
		const markdown = getEditorMarkdownForSave(editor);
		if (markdown !== null) {
			setRawContent(markdown);
		}
		setViewMode("raw");
	};

	const handleSave = () => {
		if (sourceAnalysisVersion === null) {
			return;
		}

		if (viewMode === "raw") {
			// Raw mode saves the textarea verbatim — no repairMarkdownDocument,
			// no re-serialization through the rich editor. Someone editing
			// markdown by hand gets exactly what they typed saved back, not a
			// "repaired" rewrite of it.
			setSaveError(null);
			saveMutation.mutate({
				projectId,
				topicId,
				organizationId,
				body: rawContent,
				expectedVersion: revisionVersion,
				sourceAnalysisVersion,
			});
			return;
		}

		const markdown = getEditorMarkdownForSave(editor);
		// `null` means the serializer failed — NOT that the document is
		// empty. Saving it would persist `body: null` server-side and
		// destroy the analysis, so the save is refused instead.
		if (markdown === null) {
			setSaveError(SERIALIZATION_FAILURE_MESSAGE);
			toast.error(SERIALIZATION_FAILURE_MESSAGE);
			return;
		}

		setSaveError(null);
		saveMutation.mutate({
			projectId,
			topicId,
			organizationId,
			body: markdown,
			expectedVersion: revisionVersion,
			sourceAnalysisVersion,
		});
	};

	const saveDisabled =
		sourceAnalysisVersion === null || saveMutation.isPending;

	return (
		<div className="flex flex-col gap-3">
			{canEdit ? (
				<div className="flex items-center justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={handleViewModeToggle}
					>
						{viewMode === "rich" ? (
							<>
								<Code2Icon
									className="size-4"
									aria-hidden="true"
								/>
								Markdown
							</>
						) : (
							<>
								<EyeIcon
									className="size-4"
									aria-hidden="true"
								/>
								Rich text
							</>
						)}
					</Button>
				</div>
			) : null}

			{viewMode === "rich" && canEdit ? (
				<EditorToolbar editor={editor} />
			) : null}

			<div className="rounded-lg border border-border bg-card">
				{viewMode === "rich" ? (
					<EditorContent
						editor={editor}
						className="prose prose-sm max-w-none p-4 dark:prose-invert"
					/>
				) : (
					<Textarea
						value={rawContent}
						onChange={(e) => setRawContent(e.target.value)}
						disabled={!canEdit}
						className="min-h-[300px] w-full resize-none border-0 font-mono text-sm"
						placeholder="Planning analysis in markdown format..."
					/>
				)}
			</div>

			{saveError ? (
				<p
					role="alert"
					className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm"
				>
					<AlertTriangleIcon
						className="mt-0.5 size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>{saveError}</span>
				</p>
			) : null}

			{canEdit ? (
				<div className="flex items-center justify-end gap-3">
					{sourceAnalysisVersion === null ? (
						<p className="text-muted-foreground text-xs">
							Generate a planning analysis before you can save
							edits.
						</p>
					) : null}
					<Button
						type="button"
						variant="primary"
						size="sm"
						onClick={handleSave}
						disabled={saveDisabled}
					>
						{saveMutation.isPending ? (
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : null}
						Save
					</Button>
				</div>
			) : null}
		</div>
	);
}
