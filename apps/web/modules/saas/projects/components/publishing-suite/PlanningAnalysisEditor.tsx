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

import { DiffPreviewPanes } from "@saas/projects/components/DiffPreviewPanes";
import { DiffReviewBar } from "@saas/projects/components/DiffReviewBar";
import { DiffViewModeToggle } from "@saas/projects/components/DiffViewModeToggle";
import { DocumentTocRail } from "@saas/projects/components/DocumentTocRail";
import { EditorToolbar } from "@saas/projects/components/EditorToolbar";
import { ConfirmChangeSummaryCard } from "@saas/projects/components/stories/maturation/ConfirmChangeSummaryCard";
import { useDiffPreview } from "@saas/projects/hooks/use-diff-view-mode";
import {
	fromMarkdown,
	repairMarkdownDocument,
} from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import {
	isEditorDirty,
	shouldWarnBeforeUnload,
} from "@saas/projects/lib/stories/unsaved-changes-guard";
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
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
// Every diff rule in this stylesheet is scoped under `.streaming-diff-active`,
// so without the import the `diffInsert` / `diffDelete` marks are in the
// document and invisible — a review nobody can see.
import "../DocumentEditor.css";

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
 * The prose column: the full width the region gives it.
 *
 * This used to cap at `max-w-3xl` as a reading measure. The cap is gone
 * deliberately, for parity with the Full Specification editor, which caps
 * nothing — the two surfaces are the same editor over the same kind of
 * document, and one of them reading half as wide as the other is the single
 * most visible difference between them.
 *
 * The cap was NOT arbitrary and the reasoning is worth keeping: uncapped prose
 * runs to line lengths that are uncomfortable to read on a wide monitor. What
 * changed is where the bound comes from. `DocumentTocRail` on the left and the
 * assistant rail on the right already bracket this column, which is exactly how
 * `DocumentEditor` and `StoryWorkspace` — the rail's two other consumers, both
 * uncapped — stay readable without a cap of their own.
 *
 * LEFT-ALIGNED, and that part still matters: `mx-auto` here put a wide blank
 * gutter between the contents rail and the text, because the rail is
 * `shrink-0` and the auto margins split whatever it left over, pushing the
 * document away from the very thing it is meant to sit beside.
 */
const PROSE_MEASURE_CLASS = "w-full";

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
	/**
	 * Rendered at the end of the editor's own column, inside its surface.
	 *
	 * The analysis's data sections — supporting assets, source signals — used
	 * to render as a sibling below the whole tab, which put them past the end
	 * of a clamped editor region and outside the contents rail's scope. They
	 * are part of the document a reader is reading, so they belong inside it.
	 */
	footer?: React.ReactNode;
	canEdit: boolean;
	/**
	 * A run is in flight, so the document is about to be superseded.
	 *
	 * Separate from `canEdit`, which is a PERMISSION and also drives the
	 * toolbar, the raw/rich toggle and the editor region's height clamp —
	 * folding the lock into it would drop the clamp mid-run and make the page
	 * jump. This only stops the keyboard, the same split Feature Maturation
	 * draws between `canEdit` and `isAiLoading`.
	 *
	 * Why lock at all: a regeneration replaces this document. Typing into it
	 * while one runs produces edits with nowhere to land, which is the conflict
	 * that made the stale-analysis banner necessary in the first place.
	 */
	isLocked?: boolean;
	/**
	 * WHY the editor is locked, which decides what the notice promises.
	 *
	 * `regenerating` is a server run whose output replaces this text outright.
	 * `assistant` is a chat rewrite the reader can still reject at the confirm
	 * card, so it must not claim their work is about to be replaced.
	 *
	 * Defaults to `regenerating`: every caller that predates the assistant
	 * lock means exactly that, and a default of `assistant` would quietly
	 * reword the regeneration notice everywhere.
	 */
	lockReason?: "regenerating" | "assistant";
	/**
	 * A proposed rewrite is painted into the document as diff marks and is
	 * waiting for the author's decision. Absent when nothing is under review.
	 *
	 * The editor is handed the DIFF as its `prose` seed, not the proposal —
	 * `diffPartialText` emits marker tokens that `fromMarkdown` turns into
	 * `<ins class="diff-ins">` / `<del class="diff-del">`, which the
	 * `advancedExtensions` schema already binds. So a review needs no new
	 * effect here: it is an ordinary seed that happens to carry marks.
	 *
	 * NEITHER CALLBACK SAVES. `onAcceptAll` receives the document with the
	 * marks resolved — insertions kept, deletions dropped — and the caller
	 * re-seeds the editor with it, unsaved. The author's own Save stays the
	 * only writer, which is the rule Fizzy #1929 bought and the promise the
	 * assistant's own card already makes.
	 */
	diffReview?: {
		/**
		 * The merged document, or `null` when serialization failed — the same
		 * `null`-not-`""` contract `handleSave` treats as refusal.
		 */
		onAcceptAll: (merged: string | null) => void;
		onRejectAll: () => void;
	} | null;
	/**
	 * The advisory "what changed" digest for the review above, or `null` when
	 * there is nothing to show.
	 *
	 * Rendered here rather than by the tab because the bullets are CLICKABLE
	 * and clicking one scrolls this editor's document — the handler needs the
	 * TipTap instance, which lives in this component and nowhere else. The tab
	 * owns the request (it holds the before/after pair); this owns the
	 * document it points into.
	 *
	 * ADVISORY, NEVER BLOCKING: the card renders nothing while it has nothing,
	 * and Accept / Reject on the bar below are never gated on it.
	 */
	changeSummary?: {
		/** `null` before it resolves or if it failed; `[]` if nothing changed. */
		bullets: string[] | null;
		isLoading: boolean;
	} | null;
	onSaved?: (version: number) => void;
}

export function PlanningAnalysisEditor({
	projectId,
	topicId,
	organizationId,
	prose,
	revisionVersion,
	sourceAnalysisVersion,
	footer,
	canEdit,
	isLocked = false,
	lockReason = "regenerating",
	diffReview = null,
	changeSummary = null,
	onSaved,
}: PlanningAnalysisEditorProps) {
	const [viewMode, setViewMode] = useState<"rich" | "raw">("rich");
	const [rawContent, setRawContent] = useState(prose);
	const [saveError, setSaveError] = useState<string | null>(null);
	/**
	 * What the server holds, as text this editor can be compared against.
	 *
	 * Seeded from `prose` and advanced only by a save this component confirmed.
	 * Derived rather than a blind boolean for the reason `isEditorDirty`'s own
	 * docblock gives: a flag set on keystroke and cleared whenever any save
	 * resolves goes false while the author kept typing through an in-flight
	 * save, which is easy to hit because the editor stays editable during one.
	 */
	const [lastSavedProse, setLastSavedProse] = useState(prose);
	/** The body of the save currently in flight, promoted on confirmation. */
	const pendingSaveBodyRef = useRef<string | null>(null);

	const editor = useEditor({
		extensions: advancedExtensions,
		content: fromMarkdown(prose),
		editable: canEdit && !isLocked,
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
		editor?.setEditable(canEdit && !isLocked);
	}, [editor, canEdit, isLocked]);

	const isDiffReviewActive = diffReview !== null;
	const {
		diffViewMode,
		setDiffViewMode,
		diffViews,
		effectiveDiffViewMode,
		showDiffPreviewPanes,
	} = useDiffPreview(editor, isDiffReviewActive);

	// Rich mode is the only one that can show a review: raw mode renders
	// `rawContent`, which is seeded from the plain prose and carries none of
	// the marks. Forcing it also removes the question of what the Markdown
	// toggle should do to a half-reviewed document.
	const effectiveViewMode = isDiffReviewActive ? "rich" : viewMode;

	const saveMutation = useMutation(
		orpc.projects.publishingSuite.saveAnalysisRevision.mutationOptions({
			onSuccess: (result: SaveAnalysisRevisionResult) => {
				setSaveError(null);
				// Promote only what the server actually took. Reading the
				// editor here instead would mark clean any keystroke made
				// while this save was in flight.
				if (pendingSaveBodyRef.current !== null) {
					setLastSavedProse(pendingSaveBodyRef.current);
					pendingSaveBodyRef.current = null;
				}
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
			pendingSaveBodyRef.current = rawContent;
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
		pendingSaveBodyRef.current = markdown;
		saveMutation.mutate({
			projectId,
			topicId,
			organizationId,
			body: markdown,
			expectedVersion: revisionVersion,
			sourceAnalysisVersion,
		});
	};

	// Locked too: a save landing while a regeneration is in flight writes a
	// revision against a source version that is already being superseded.
	const saveDisabled =
		sourceAnalysisVersion === null || saveMutation.isPending || isLocked;

	/**
	 * Warn before a tab close that would discard an unsaved edit.
	 *
	 * THIS SURFACE DOES NOT AUTOSAVE, and that is deliberate — Fizzy #1929's
	 * worst defect was an autosave racing an in-flight agent and overwriting
	 * the server with pre-answer text, so an explicit Save is the only writer
	 * here. The assistant's accept path leans on that: `onAcceptAll` re-seeds
	 * this editor with the merged document and saves nothing.
	 *
	 * The consequence was that a rewrite somebody had just accepted — a few
	 * hundred changes, in the case that prompted this — sat in the editor with
	 * nothing between it and the next navigation. Feature Maturation has both
	 * halves of the guard; this surface had neither, which left the deliberate
	 * no-autosave decision resting on the author remembering.
	 *
	 * FMv2's OTHER half is not copied. It flushes a silent save on unmount to
	 * cover App Router navigation, which it can afford because it autosaves
	 * anyway. Doing that here would reintroduce exactly the write #1929
	 * removed. So a client-side navigation away still loses the edit — the
	 * dirty marker beside Save is what makes that visible beforehand, and
	 * closing that gap properly needs a navigation guard rather than a write.
	 */
	const isDirty = isEditorDirty(
		viewMode === "raw" ? rawContent : getEditorMarkdownForSave(editor),
		lastSavedProse,
	);
	const isDirtyRef = useRef(isDirty);
	isDirtyRef.current = isDirty;
	const isSavingRef = useRef(saveMutation.isPending);
	isSavingRef.current = saveMutation.isPending;

	useEffect(() => {
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			if (
				!shouldWarnBeforeUnload({
					hasUnsavedChanges: isDirtyRef.current,
					isSaving: isSavingRef.current,
				})
			) {
				return;
			}
			// Browsers ignore custom text and show their own copy; both the
			// assignment and preventDefault are required for cross-browser
			// support.
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, []);

	/**
	 * Scroll the document to the section a summary bullet names, and flash it.
	 *
	 * The bullet's contract is `<Section heading> — <one sentence>`, so the
	 * prefix before the em-dash is the heading to find. Best-effort by design:
	 * a bullet that matches nothing does nothing, because a summary is
	 * advisory and a thrown error over a failed scroll would be worse than a
	 * dead click.
	 *
	 * THIS DIVERGES FROM `StoryWorkspace.tsx`'s `scrollDiffToSection`, which
	 * matches on `heading.textContent` alone — and that is a latent bug there,
	 * not a simplification here. Under review the document IS the diff, so a
	 * RENAMED section parses to
	 * `<h2><del class="diff-del">Risks</del><ins class="diff-ins">Risk
	 * register</ins></h2>` and its `textContent` is the concatenation
	 * `"RisksRisk register"` — which starts with neither the old heading nor
	 * the new one, so every bullet naming a renamed section is a silent no-op.
	 * Measured, not assumed.
	 *
	 * So each heading offers three candidates: the text as rendered, the text
	 * with deletions removed (the AFTER heading), and the text with insertions
	 * removed (the BEFORE heading). The server's prompt may cite either
	 * document, and an unchanged heading gives the same string all three ways.
	 */
	const scrollToSection = useCallback(
		(bullet: string) => {
			if (!editor) {
				return;
			}
			const section = bullet.split(" — ")[0]?.trim().toLowerCase();
			if (!section) {
				return;
			}
			const headings = Array.from(
				(editor.view.dom as HTMLElement).querySelectorAll<HTMLElement>(
					"h1, h2, h3, h4, h5, h6",
				),
			);
			const without = (heading: HTMLElement, selector: string) => {
				const copy = heading.cloneNode(true) as HTMLElement;
				for (const node of Array.from(
					copy.querySelectorAll(selector),
				)) {
					node.remove();
				}
				return copy.textContent ?? "";
			};
			const target = headings.find((heading) =>
				[
					heading.textContent ?? "",
					without(heading, "del, .diff-del"),
					without(heading, "ins, .diff-ins"),
				].some((candidate) =>
					candidate.trim().toLowerCase().startsWith(section),
				),
			);
			if (!target) {
				return;
			}
			target.scrollIntoView({ behavior: "smooth", block: "center" });
			// The keyframes are already global (`app/globals.css`), shared with
			// Feature Maturation, and already honour `prefers-reduced-motion`.
			target.classList.add("maturation-section-flash");
			window.setTimeout(
				() => target.classList.remove("maturation-section-flash"),
				1600,
			);
		},
		[editor],
	);

	return (
		<div className="flex flex-col gap-3">
			{/* Two locks, two promises, and the difference is not cosmetic. A
			    regeneration WILL replace this text, so "nothing you type is
			    lost to the version that replaces this one" is true. An
			    assistant rewrite may be rejected at the card, so telling
			    somebody their work is about to be replaced would be a lie
			    half the time. */}
			{isLocked ? (
				<p
					className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-xs leading-relaxed"
					role="status"
					data-testid="planning-analysis-locked"
				>
					{lockReason === "assistant"
						? "The assistant is rewriting this analysis. Editing is paused until it finishes — you'll be able to accept or discard what it proposes."
						: "A new analysis is being written. Editing is paused until it finishes, so nothing you type is lost to the version that replaces this one."}
				</p>
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
					// Every diff rule in `DocumentEditor.css` is scoped under
					// this class. Without it the marks are in the document and
					// render as unstyled <ins>/<del>.
					isDiffReviewActive && "streaming-diff-active",
				)}
				// The height is the contract, and jsdom has no layout engine
				// to measure it with — only the rule that produces one. This
				// handle is how the toggle-stability test reads that rule off
				// the same element in both modes.
				data-testid="planning-analysis-editor-region"
			>
				{/* The raw/rich toggle rides the toolbar line rather than
				    claiming a full-width row of its own above the document.
				    It is a control ON the editor, so it belongs beside the
				    editor's other controls; as a separate row it was one more
				    line of chrome between the reader and the text, which is
				    the complaint this tab collected most often.

				    Rendered for both modes — raw mode has no `EditorToolbar`,
				    and the toggle is the only way back out of it. */}
				{canEdit ? (
					<div className="flex items-center gap-2 border-border border-b px-2 py-1">
						<div className="min-w-0 flex-1">
							{viewMode === "rich" ? (
								<EditorToolbar editor={editor} />
							) : null}
						</div>
						{/* Inline / Side by side / Full preview replaces the
						    raw/rich toggle for the length of a review: raw
						    mode cannot render the marks, and two toggles
						    competing for the same corner is how a reader
						    loses track of which view they are in. */}
						{isDiffReviewActive ? (
							<DiffViewModeToggle
								value={diffViewMode}
								onChange={setDiffViewMode}
								className="shrink-0"
							/>
						) : (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="shrink-0"
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
						)}
					</div>
				) : null}

				{/* Directly above the review bar, and gated the same way: the
				    digest describes the review, so it has no meaning outside
				    one. It caps its own height and carries its own scroll, so
				    a long summary can never push the diff off screen. */}
				{diffReview !== null && canEdit && changeSummary !== null ? (
					<ConfirmChangeSummaryCard
						bullets={changeSummary.bullets}
						isLoading={changeSummary.isLoading}
						onBulletClick={scrollToSection}
					/>
				) : null}

				{/* The review bar sits between the toolbar and the document,
				    inside the height-owning region, so per-change navigation
				    scrolls the document under a bar that stays put. */}
				{diffReview !== null && canEdit ? (
					<DiffReviewBar
						editor={editor}
						mode={effectiveDiffViewMode}
						onAcceptAll={() =>
							diffReview.onAcceptAll(
								getEditorMarkdownForSave(editor),
							)
						}
						onRejectAll={diffReview.onRejectAll}
					/>
				) : null}

				<div className="flex min-h-0 flex-1 overflow-hidden">
					{/* Hidden in raw mode, exactly as `StoryWorkspace` hides
					    it: the Textarea has no heading DOM to navigate. */}
					{effectiveViewMode === "rich" ? (
						<DocumentTocRail editor={editor} />
					) : null}

					{effectiveViewMode === "rich" ? (
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
							{/* HIDDEN, not unmounted, while the panes are
							    up: the pending diff lives in this editor's
							    document, and unmounting it would throw the
							    review away on a view change. */}
							<div
								className={cn(
									PROSE_MEASURE_CLASS,
									"h-full",
									showDiffPreviewPanes && "hidden",
								)}
								data-testid="planning-analysis-prose-measure"
							>
								<EditorContent
									editor={editor}
									className="prose prose-sm h-full max-w-none dark:prose-invert"
								/>
							</div>
							{showDiffPreviewPanes && diffViews ? (
								// `DiffPreviewPanes` renders two modes, never
								// "inline" — `showDiffPreviewPanes` already
								// excludes it, but only at runtime. Narrowed
								// the way `StoryWorkspace` and `DocumentEditor`
								// narrow it, so the three call sites agree.
								<DiffPreviewPanes
									mode={
										effectiveDiffViewMode === "fullPreview"
											? "fullPreview"
											: "sideBySide"
									}
									derived={diffViews}
								/>
							) : null}
						</div>
					) : (
						<div className="min-h-0 flex-1 overflow-hidden p-4">
							<div
								className={`${PROSE_MEASURE_CLASS} h-full`}
								data-testid="planning-analysis-prose-measure"
							>
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
					{/* The only thing standing between an accepted rewrite and
					    a navigation that discards it. `beforeunload` covers a
					    tab close; nothing covers an in-app link, and this
					    surface must not autosave (see the guard above), so the
					    remaining defence is saying plainly that the work is
					    not on the server yet. */}
					{/* Plain text, deliberately: this region already contains a
					    polite live region, and a second one announcing on
					    every keystroke would talk over it. The marker is a
					    standing label on the state, not an event — the Save
					    button beside it is what a keyboard user acts on. */}
					{isDirty && !saveMutation.isPending ? (
						<span
							className="text-highlight text-xs"
							data-testid="planning-analysis-unsaved"
						>
							Unsaved changes
						</span>
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
			{/* Part of the document, not a block after it.
			    "What are these things doing? These are specifications ... can't
			    this live within the content?" They rendered as a sibling BELOW
			    this whole surface, after a clamped editor region, so on any real
			    analysis they were a scroll past the end of what looked like the
			    end.

			    Rendered here rather than written INTO the prose: they are
			    structured data the generator produces, and folding them into
			    the markdown would put generated content inside the text a
			    person edits and saves — the next regeneration would then have
			    to tell their words from its own. */}
			{footer}
		</div>
	);
}
