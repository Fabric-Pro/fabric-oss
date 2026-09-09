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
 *
 * For someone who can edit, the region owns its own height
 * (`EDITOR_REGION_HEIGHT_CLASS`), which is what makes the two view modes
 * interchangeable rather than merely alternative. They render structurally
 * different children — a content-driven `EditorContent` and a fixed-minimum
 * `Textarea` — and the toolbar exists in only one of them, so a wrapper that
 * took its height from its children resized the whole tab on every toggle: a
 * short analysis grew, a long one collapsed into an internal scroller. Owning
 * the height is also what gives `DocumentTocRail` something to stick to; the
 * rail is `h-full` against a scroll container, and this surface has no
 * page-level one (the same shape `StoryWorkspace` and `DocumentEditor` dock
 * their rails inside).
 *
 * A read-only viewer gets neither the toggle nor the toolbar, so it gets
 * neither the jump nor the height — see `EDITOR_REGION_HEIGHT_CLASS` for why
 * the rail is fine without it.
 */

import { DocumentTocRail } from "@saas/projects/components/DocumentTocRail";
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
import { cn } from "@ui/lib";
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

const EDITOR_REGION_CLASS =
	"flex flex-col overflow-hidden rounded-lg border border-border bg-card";

/**
 * The height the region holds in both view modes — FOR AN EDITOR ONLY.
 *
 * A definite length rather than a min/max pair: `DocumentTocRail` resolves
 * `h-full` against this box, and a percentage against an auto height is not a
 * height. Clamped rather than fixed so the region tracks the viewport without
 * becoming unusable on a short one (24rem floor) or absurd on a tall one.
 *
 * Both reasons for the floor are an editor's: it stops the box jumping as the
 * rich/raw toggle swaps a toolbar and a content-driven `EditorContent` for a
 * `Textarea`, and it gives the rail a definite height to dock against. A
 * read-only viewer has neither toggle nor toolbar, so there is no jump to
 * prevent — the floor only buys them a tall, mostly-empty box for a problem
 * they cannot trigger. They size to content instead.
 *
 * The rail SURVIVES that, and keeps working, for three reasons worth stating
 * because "a rail with nothing to stick to" is exactly what the floor was
 * protecting. `DocumentTocPanel` renders nothing at all when the document has
 * no headings, so the degenerate case cannot arise; when it does render it is
 * a stretch-aligned flex item, so it takes the row's height rather than
 * asking for one; and its own min-content height (icon, caption, chevron)
 * sets a floor under the row instead of needing one above it — the spine is
 * already built to clip its caption on a short rail rather than break.
 */
const EDITOR_REGION_HEIGHT_CLASS = "h-[clamp(24rem,60vh,44rem)]";

/**
 * The reading measure. 3xl is the cap the topic page already uses for prose
 * (`TopicItemPage`'s pitch paragraph); the analysis rendered full-bleed before
 * this, at line lengths no one reads comfortably.
 *
 * LEFT-ALIGNED, not centred, and that is the whole point of this comment.
 * `mx-auto` here put a wide blank gutter between the contents rail and the
 * text: the rail is `shrink-0` and the measure caps at 768px, so the auto
 * margins split whatever the rail left over and pushed the document away from
 * the very thing it is meant to sit beside. The pattern this cites —
 * `TopicItemPage`'s pitch paragraph — is `max-w-3xl` with NO `mx-auto`, and
 * the two other consumers of `DocumentTocRail` (`DocumentEditor`,
 * `StoryWorkspace`) cap nothing at all, so neither had ever exercised a capped
 * column against the rail's asymmetric layout.
 */
const PROSE_MEASURE_CLASS = "w-full max-w-3xl";

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
			// `min-h-full` is what keeps the contenteditable as tall as the
			// region now that the region owns a height instead of hugging its
			// content. Without it a three-line analysis leaves most of the box
			// as dead space — a click there lands on the scroll container, not
			// the editor, so there is no caret. Measured in a browser: 82px of
			// editable inside a 488px box before, the full 488px after. The
			// percentage resolves only because every ancestor up to the region
			// carries a height (see the wrapper and `EditorContent` below);
			// `StoryWorkspace` solves the same problem with a pixel floor,
			// which would go back to being wrong at the top of the clamp.
			attributes: { class: "min-h-full p-4 tiptap" },
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

			{/* The toolbar lives INSIDE the height-owning region, not above
			    it. Raw mode has no toolbar, and while it sat outside, its
			    disappearance moved everything below it — the third
			    contributor to the toggle jump. Inside, its presence only
			    changes how the region's fixed height is divided. */}
			<div
				className={cn(
					EDITOR_REGION_CLASS,
					canEdit && EDITOR_REGION_HEIGHT_CLASS,
				)}
				// The height is the contract, and jsdom has no layout engine
				// to measure it with — only the rule that produces one. This
				// handle is how the toggle-stability test reads that rule off
				// the same element in both modes.
				data-testid="planning-analysis-editor-region"
			>
				{viewMode === "rich" && canEdit ? (
					<EditorToolbar editor={editor} />
				) : null}

				<div className="flex min-h-0 flex-1 overflow-hidden">
					{/* Hidden in raw mode, exactly as `StoryWorkspace` hides
					    it: the Textarea has no heading DOM to navigate. */}
					{viewMode === "rich" ? (
						<DocumentTocRail editor={editor} />
					) : null}

					{viewMode === "rich" ? (
						<div className="min-h-0 flex-1 overflow-y-auto">
							{/* The measure is a wrapper rather than a class on
							    `EditorContent`: `prose` carries its own
							    max-width, and `max-w-none` beside a cap on the
							    same element is a coin toss over which wins.
							    Both links carry `h-full` so the editor's own
							    `min-h-full` has a definite height to resolve
							    against — break either one and the click target
							    shrinks back to the text. Content taller than
							    the box overflows them and the scroll container
							    above scrolls it, as before. */}
							<div className={`${PROSE_MEASURE_CLASS} h-full`}>
								<EditorContent
									editor={editor}
									className="prose prose-sm h-full max-w-none dark:prose-invert"
								/>
							</div>
						</div>
					) : (
						<div className="min-h-0 flex-1 overflow-hidden p-4">
							<div className={`${PROSE_MEASURE_CLASS} h-full`}>
								<Textarea
									value={rawContent}
									onChange={(e) =>
										setRawContent(e.target.value)
									}
									disabled={!canEdit}
									className="h-full w-full resize-none border-0 bg-transparent font-mono text-sm"
									placeholder="Planning analysis in markdown format..."
								/>
							</div>
						</div>
					)}
				</div>
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
