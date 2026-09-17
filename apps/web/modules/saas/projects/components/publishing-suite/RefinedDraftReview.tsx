"use client";

/**
 * The review surface for a REFINED draft — the result of "Refine with AI"
 * shown as a diff against the text it was built from.
 *
 * A refinement and a regeneration arrive through the same channel and used to
 * render the same way: a new candidate in a column beside the working draft,
 * two blocks of plain prose with nothing saying what moved. For a regeneration
 * that is honest — it is a different draft, written from the planning analysis,
 * and there is no "before" to compare it against. A refinement is the opposite:
 * it IS the saved draft, with the changes the author asked for, and the only
 * thing worth reading is the difference. Asking someone to find it by eye in
 * nine hundred words is not a comparison.
 *
 * ONE component for all seven content types rather than seven copies. The seven
 * panels already differ in everything around the draft — safety fields, option
 * lists, the feed-fold preview — and agree on exactly this: a refinement of a
 * body of text, reviewed against that text. A copy per panel would be seven
 * chances for the accept path to drift, and the accept path is the one that
 * writes.
 *
 * ## What it reuses, and why none of it is reinvented here
 *
 * The document editors already had this surface. `diffPartialText` emits marker
 * tokens (not HTML) so the surrounding markdown still parses; `fromMarkdown`
 * turns them into the `<ins class="diff-ins">` / `<del class="diff-del">` that
 * `advancedExtensions` binds as `diffInsert` / `diffDelete` marks; and
 * `DiffReviewBar` walks those marks with per-change accept/reject plus the two
 * bulk actions. `PlanningAnalysisEditor` wires the same three parts the same
 * way — this is that wiring over a plain saved body instead of a TipTap
 * document.
 *
 * `isComplete: true` on the diff, as `VersionDiffViewer` passes it: the refined
 * draft arrives whole, and the streaming branch would truncate the baseline to
 * the proposal's length and skip the markdown normalization that keeps
 * formatting artifacts from reading as changes.
 *
 * ## What accepting does
 *
 * It writes the WORKING DRAFT, through the panel's own save mutation, and that
 * is deliberate rather than incidental: per-change accept/reject produces a
 * document that is neither the saved text nor the candidate, and exists only in
 * this editor. `adopt` cannot express it — it names a candidate id for the
 * server to read the text from — so the merged document has to travel as a
 * body, which is what `save…Body` takes.
 *
 * Rejecting writes NOTHING. The candidate is still there afterwards, rendered
 * the ordinary way, so a reader who changes their mind can still adopt it
 * wholesale from the version list.
 */

import { DiffPreviewPanes } from "@saas/projects/components/DiffPreviewPanes";
import { DiffReviewBar } from "@saas/projects/components/DiffReviewBar";
import { DiffViewModeToggle } from "@saas/projects/components/DiffViewModeToggle";
import { useDiffPreview } from "@saas/projects/hooks/use-diff-view-mode";
import { diffPartialText, fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { advancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { EditorContent, useEditor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect } from "react";
// Every diff rule in this stylesheet is scoped under `.streaming-diff-active`,
// so without the import the marks are in the document and invisible — a review
// nobody can see.
import "../DocumentEditor.css";

interface RefinedDraftReviewProps {
	/**
	 * The candidate under review. Not rendered — it is the identity the editor
	 * is keyed on, so a second refinement landing while the first is open
	 * reseeds the document instead of leaving the old diff on screen.
	 */
	draftId: string;
	/** The saved text the refinement was built from, and is diffed against. */
	baseline: string;
	/** The refined text, as the candidate holds it. */
	proposed: string;
	/** The candidate's version, for the heading. `null` when unknown. */
	version: number | null;
	/** What the author asked for on this run, when the row recorded it. */
	instruction: string | null;
	/** The content type in prose — "blog post", "LinkedIn post". */
	label: string;
	/**
	 * The merged document, or `null` when serialization failed — the same
	 * null-not-empty contract every save path in this repo treats as refusal.
	 * Writing `null` as a body would destroy the draft.
	 */
	onConfirm: (merged: string | null) => void;
	/** Leave the saved draft exactly as it is and close the review. */
	onReject: () => void;
	/** A save is in flight: the document is about to be replaced. */
	isSaving: boolean;
}

export function RefinedDraftReview(props: RefinedDraftReviewProps) {
	// Keyed HERE rather than at each of the seven call sites. `useEditor` seeds
	// its document on mount and never re-syncs, so a review whose candidate
	// changed without a remount shows the previous diff over the previous text
	// — and a key forgotten on one panel of seven is exactly the kind of bug
	// that ships. One place to get it right.
	return <RefinementEditor key={props.draftId} {...props} />;
}

function RefinementEditor({
	baseline,
	proposed,
	version,
	instruction,
	label,
	onConfirm,
	onReject,
	isSaving,
}: RefinedDraftReviewProps) {
	const editor = useEditor({
		extensions: advancedExtensions,
		content: fromMarkdown(diffPartialText(baseline, proposed, true)),
		editable: !isSaving,
		immediatelyRender: false,
		editorProps: {
			attributes: { class: "min-h-full tiptap" },
		},
	});

	// A save in flight is about to replace this document, so the keyboard is
	// closed for its duration — the same split the analysis editor draws
	// between "may edit" and "a write is happening to this text right now".
	useEffect(() => {
		editor?.setEditable(!isSaving);
	}, [editor, isSaving]);

	const {
		diffViewMode,
		setDiffViewMode,
		diffViews,
		effectiveDiffViewMode,
		showDiffPreviewPanes,
	} = useDiffPreview(editor, true);

	// Reads the editor at the moment of the press, never a captured value: the
	// document has been mutated in place by every per-change accept and reject
	// since it was seeded, and by anything typed into it.
	const confirm = () => onConfirm(getEditorMarkdownForSave(editor));

	return (
		<section className="space-y-2" data-testid="refined-draft-review">
			<div className="space-y-1">
				<h3 className="publishing-label">
					Refined draft
					{version !== null ? ` (version ${version})` : ""}
				</h3>
				<p className="text-muted-foreground text-xs leading-relaxed">
					{instruction ? `You asked for: “${instruction}”. ` : null}
					{`Shown against the ${label} you have saved — struck-through text goes, underlined text arrives. Accept the changes you want, then save. Nothing is saved until you do.`}
				</p>
			</div>

			<div
				className={cn(
					"overflow-hidden rounded-xl border border-border bg-card",
					// Every diff rule in `DocumentEditor.css` is scoped under
					// this class. Without it the marks are in the document and
					// render as unstyled <ins>/<del>.
					"streaming-diff-active",
				)}
			>
				<div className="flex items-center justify-end border-border border-b px-2 py-1">
					<DiffViewModeToggle
						value={diffViewMode}
						onChange={setDiffViewMode}
						className="shrink-0"
					/>
				</div>

				{/* Above the document and sticky within the scroller below, so
				    per-change navigation scrolls the text under a bar that
				    stays put. Its Accept All / Reject All are the same two
				    decisions the footer offers — a reader who has been working
				    change by change should not have to travel to the end of a
				    long draft to finish. */}
				<DiffReviewBar
					editor={editor}
					mode={effectiveDiffViewMode}
					onAcceptAll={confirm}
					onRejectAll={onReject}
				/>

				<div className="max-h-[32rem] overflow-y-auto">
					{/* HIDDEN, not unmounted, while the panes are up: the
					    pending diff lives in this editor's document, and
					    unmounting it would throw away every per-change
					    decision made so far on a mere view change. */}
					<div
						className={cn("p-4", showDiffPreviewPanes && "hidden")}
					>
						<EditorContent
							editor={editor}
							className="prose prose-sm max-w-none dark:prose-invert"
						/>
					</div>
					{showDiffPreviewPanes && diffViews ? (
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

				{/* The decision, said in the words of what it does to the saved
				    draft. `DiffReviewBar`'s own bulk pair is labelled for
				    resolving marks ("Accept All"), which is the right wording
				    inside a document editor and the wrong one here, where the
				    same press also writes. It is also the only control left
				    once every change has been resolved one by one — at that
				    point the bar has no ranges and collapses to a dismiss. */}
				<div className="flex flex-wrap items-center gap-2 border-border border-t px-4 py-3">
					<Button
						type="button"
						size="sm"
						onClick={confirm}
						disabled={isSaving}
					>
						{isSaving ? (
							<Loader2Icon
								className="mr-2 size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<CheckIcon
								className="mr-2 size-4"
								aria-hidden="true"
							/>
						)}
						{`Save as the working ${label}`}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onReject}
						disabled={isSaving}
					>
						<XIcon className="mr-2 size-4" aria-hidden="true" />
						Discard refinement
					</Button>
				</div>
			</div>
		</section>
	);
}
