"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon, PencilLineIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	CandidateDraft,
	DraftComparison,
	SavedDraftCaption,
} from "./DraftComparison";
import { GeneralizationNotes } from "./GeneralizationNotes";
import type { TopicDraftState, TopicWorkingDraftState } from "./GenerationTabs";

/** Mirrors the API's own bounds, so a field cannot submit what it would reject. */
const GUIDANCE_MAX = 2000;
const BODY_MAX = 40000;

/**
 * The Blog Post generation panel (Fizzy #1853, Phase 2B-3).
 *
 * FR11/FR13/FR21 and FR34/FR35: optional guidance, a generate action, the one
 * editable draft it produces, and the control that adopts a later version over
 * saved work.
 *
 * Its own component rather than a mode of `ShortPostPanel`, because the two
 * products differ where it matters most: a blog generation SEEDS the working
 * draft on the first run (DV5/FR21) and this panel's centre is an editor, where
 * the short post produces three candidates that stay candidates until a person
 * picks one (DV4). One component serving both would be a flag deciding which
 * product it is.
 */

interface BlogPostDocument {
	title: string;
	subtitle: string | null;
	body: string;
	categories: string[];
	keywords: string[];
	inputsNeeded: string[];
	safetyNote: string | null;
}

/**
 * Read a blog post out of a draft's stored `content`.
 *
 * Defensive rather than trusting: `content` is `Json?`, so a row written by an
 * older shape must degrade to "nothing to show" instead of throwing inside a
 * render. A panel that crashes takes the whole Topic Item Page with it.
 */
function readBlogPostDocument(content: unknown): BlogPostDocument | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const raw = content as Record<string, unknown>;
	if (typeof raw.title !== "string" || typeof raw.body !== "string") {
		return null;
	}
	if (!raw.title.trim() || !raw.body.trim()) {
		return null;
	}

	const strings = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string")
			: [];

	return {
		title: raw.title,
		subtitle: typeof raw.subtitle === "string" ? raw.subtitle : null,
		body: raw.body,
		categories: strings(raw.categories),
		keywords: strings(raw.keywords),
		inputsNeeded: strings(raw.inputsNeeded),
		safetyNote: typeof raw.safetyNote === "string" ? raw.safetyNote : null,
	};
}

export function BlogPostPanel({
	projectId,
	organizationId,
	topicId,
	draft,
	working,
	canEdit,
}: {
	projectId: string;
	organizationId: string | null;
	topicId: string;
	draft: TopicDraftState | null;
	working: TopicWorkingDraftState | null;
	/** PR2: a reader sees the draft but gets no controls. */
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const [guidance, setGuidance] = useState("");
	/**
	 * The edit instruction for a REFINE run, kept apart from `guidance`.
	 *
	 * Two fields rather than one, because they ask for different things and a
	 * shared one would silently carry the wrong kind of text into whichever
	 * action was pressed second. Guidance steers a draft that does not exist
	 * yet ("technical audience, 800 words"); this steers a change to one that
	 * does ("make it shorter"). Sent as `guidance` on the wire — it IS the
	 * run's instruction, and putting it there is what records it on the attempt
	 * row.
	 */
	const [refineInstruction, setRefineInstruction] = useState("");
	/**
	 * The editor's text, or null for "showing what the server last returned".
	 *
	 * Null rather than a copy of the body, so a poll landing while the reader has
	 * NOT typed shows the newer text, and one landing while they HAVE typed does
	 * not silently discard what they wrote. That is the whole reason this is not
	 * initialised from `working.body` and synced in an effect: the effect version
	 * has to guess which of the two just changed.
	 */
	const [editedBody, setEditedBody] = useState<string | null>(null);

	const attempt = draft?.latestAttempt ?? null;
	// `isExpired` splits GENERATING in two: a LIVE run is genuinely in flight, a
	// STRANDED one will never report back on its own. The button must stay
	// enabled for the second, because the ONLY code that reclaims a stranded row
	// runs inside the NEXT attempt — disabling on `status === GENERATING` alone
	// would lock the tab with no user action able to free it.
	const isStranded = attempt?.status === "GENERATING" && attempt.isExpired;
	const isGenerating = attempt?.status === "GENERATING" && !isStranded;

	const invalidateDrafts = () => {
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.listTopicDrafts.queryKey({
				input: { projectId, topicId, organizationId },
			}),
		});
	};

	const generate = useMutation(
		orpc.projects.publishingSuite.generateBlogPost.mutationOptions({
			onSuccess: (result) => {
				// `started: false` is an ANSWER, not a failure — Temporal is down,
				// or a run this tab has not seen yet is already filling the row.
				// Reporting either as an error would send the reader looking for
				// a fault that is not theirs.
				if (!result.started) {
					toast.info(
						result.reason === "unavailable"
							? "Generation is unavailable right now. Try again in a few minutes."
							: "A blog post is already being generated for this topic.",
					);
				}
				invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not start the blog post.");
			},
		}),
	);

	const adopt = useMutation(
		orpc.projects.publishingSuite.adoptBlogPostDraft.mutationOptions({
			onSuccess: () => {
				// The adopted text replaces whatever the editor was showing, so
				// the local override has to go with it — otherwise the reader
				// adopts a version and goes on looking at the old one.
				setEditedBody(null);
				toast.success("Saved as the working blog post.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"The saved blog post changed while you were reading. Refreshed — take another look.",
					);
					invalidateDrafts();
					return;
				}
				toast.error("Could not adopt that version.");
			},
		}),
	);

	const saveBody = useMutation(
		orpc.projects.publishingSuite.saveBlogPostBody.mutationOptions({
			onSuccess: () => {
				setEditedBody(null);
				toast.success("Blog post saved.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				// A CONFLICT means someone else changed the draft while this tab
				// was editing. The edit is NOT discarded — `editedBody` is left
				// standing so the reader can copy their text before refreshing.
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"Someone else changed this blog post while you were editing. Your text is still here — copy it before refreshing.",
					);
					return;
				}
				toast.error("Could not save the blog post.");
			},
		}),
	);

	const doc = readBlogPostDocument(draft?.latestReady?.content ?? null);
	const readyId = draft?.latestReady?.id ?? null;

	const bodyValue = editedBody ?? working?.body ?? "";
	const isDirty = editedBody !== null && editedBody !== (working?.body ?? "");

	/**
	 * Whether a generated version exists that the working draft did not come
	 * from — i.e. a regeneration the reader has not adopted.
	 *
	 * `readyId` non-null FIRST, for the reason `ShortPostPanel` documents: a
	 * working draft whose source candidate was deleted carries a null
	 * `sourceDraftId` under the composite FK's `ON DELETE SET NULL`, and
	 * comparing `null !== null` would otherwise answer "no newer version" for a
	 * topic that has one.
	 */
	const hasUnadoptedVersion =
		readyId !== null && working?.sourceDraftId !== readyId;

	/**
	 * Whether the safety note describes a version the saved text did not come
	 * from.
	 *
	 * The same predicate its Case Study and Stakeholder Email siblings spell
	 * as `!bodyIsFromLatest && working?.hasBody === true`; written directly
	 * here because this panel has no export path and so no second reader for
	 * the intermediate. Gated on there being a saved body to qualify — with no
	 * working draft the sentence would be false, since there is no "version
	 * this text was saved from".
	 *
	 * This panel had no qualifier of any kind before slice A6, which made it
	 * the worst of the three rather than the reference.
	 */
	const notesDescribeAnotherVersion =
		hasUnadoptedVersion && working?.hasBody === true;

	/**
	 * The safety fields of the version the BODY came from.
	 *
	 * `doc` is the newest READY candidate — right for the comparison panes,
	 * wrong for anything describing the text in the editor. The A6 qualifier
	 * covered half of it and could not reach the other half at all: when v1 was
	 * generalized and v2 needs none, `doc.safetyNote` is null, the section does
	 * not render, and the reader loses the explanation of the document they
	 * hold while the export carries it away silently.
	 *
	 * The qualifier survives only for what it can still describe — a source row
	 * past retention, where the newest note is all there is.
	 */
	const adoptedDoc = readBlogPostDocument(working?.sourceContent ?? null);
	const safetyDoc =
		notesDescribeAnotherVersion && adoptedDoc ? adoptedDoc : doc;
	const noteDescribesAnotherVersion =
		notesDescribeAnotherVersion && adoptedDoc === null;

	const handleAdopt = () => {
		if (!readyId) {
			return;
		}
		// FR35 is satisfied structurally — generation can only CREATE a working
		// draft, never replace one — but adopting a later version over saved
		// text IS a replacement. It is the reader's own action, so this confirms
		// rather than blocks. Unsaved editor text is called out separately,
		// because that is the part no refresh brings back.
		const warning = isDirty
			? "This replaces the saved blog post AND discards your unsaved edits. Continue?"
			: "This replaces the blog post you saved earlier. Continue?";
		if (working?.hasBody && !window.confirm(warning)) {
			return;
		}
		adopt.mutate({
			projectId,
			topicId,
			organizationId,
			draftId: readyId,
			// Optimistic concurrency: when THIS tab last saw the working draft.
			// Keyed on `working` existing, NOT on `hasBody` — a row with a blank
			// body still exists and still has an `updatedAt` the server compares
			// against, so sending null for it would report every such save as
			// stale.
			expectedUpdatedAt: working ? new Date(working.updatedAt) : null,
		});
	};

	const handleSaveBody = () => {
		if (!working || !isDirty) {
			return;
		}
		saveBody.mutate({
			projectId,
			topicId,
			organizationId,
			body: bodyValue,
			expectedUpdatedAt: new Date(working.updatedAt),
		});
	};

	/**
	 * The two halves of the comparison, built before the return so each can
	 * ask whether the other exists.
	 *
	 * The panel used to stack them — the editor here, the generated version
	 * several sections below, the safety blocks in between — while telling the
	 * reader in prose that regenerating "writes a new version to compare
	 * against". Comparing meant scrolling, so the promise was not kept.
	 */
	const candidate =
		doc && hasUnadoptedVersion ? (
			<CandidateDraft
				version={draft?.latestReady?.version ?? null}
				title={doc.title}
				subtitle={doc.subtitle}
				body={doc.body}
				replacesSavedDraft={Boolean(working?.hasBody)}
				action={
					canEdit ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleAdopt}
							disabled={adopt.isPending}
						>
							{working?.hasBody
								? "Use this version"
								: "Save as working draft"}
						</Button>
					) : null
				}
			/>
		) : null;

	const savedDraft = working?.hasBody ? (
		<section className="space-y-2">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="editorial-label" id="blog-post-editor">
					Working blog post
				</h3>
				{isDirty ? (
					<span
						className="text-muted-foreground text-xs"
						role="status"
					>
						Unsaved changes
					</span>
				) : null}
			</div>
			{/* Only while a candidate sits beside it: with one draft on
			    screen there is nothing to tell apart. */}
			{candidate ? (
				<SavedDraftCaption>
					Saved. This is the blog post the topic holds — editing here
					changes it.
				</SavedDraftCaption>
			) : null}
			{canEdit ? (
				<>
					<Textarea
						aria-labelledby="blog-post-editor"
						value={bodyValue}
						onChange={(e) => setEditedBody(e.target.value)}
						maxLength={BODY_MAX}
						rows={20}
						className="font-mono text-sm leading-relaxed"
						disabled={saveBody.isPending}
					/>
					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="button"
							onClick={handleSaveBody}
							disabled={!isDirty || saveBody.isPending}
						>
							{saveBody.isPending ? (
								<Loader2Icon
									className="mr-2 size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							Save changes
						</Button>
						{isDirty ? (
							<Button
								type="button"
								variant="ghost"
								onClick={() => setEditedBody(null)}
								disabled={saveBody.isPending}
							>
								Discard changes
							</Button>
						) : null}
					</div>
				</>
			) : (
				<div className="rounded-xl border border-border bg-muted/40 p-4">
					<p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
						{working.body}
					</p>
				</div>
			)}
		</section>
	) : null;

	return (
		<div className="space-y-5">
			{canEdit ? (
				<section className="space-y-2">
					<label
						className="editorial-label block"
						htmlFor="blog-post-guidance"
					>
						Guidance (optional)
					</label>
					<Textarea
						id="blog-post-guidance"
						value={guidance}
						onChange={(e) => setGuidance(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={3}
						placeholder="Tone, audience, length, key points, categories, keywords, or things to avoid."
						disabled={isGenerating || generate.isPending}
					/>
					<div className="flex items-center gap-3">
						<Button
							type="button"
							onClick={() =>
								generate.mutate({
									projectId,
									topicId,
									organizationId,
									guidance: guidance.trim() || null,
								})
							}
							disabled={isGenerating || generate.isPending}
						>
							{isGenerating || generate.isPending ? (
								<Loader2Icon
									className="mr-2 size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<SparklesIcon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
							)}
							{doc ? "Regenerate draft" : "Generate blog post"}
						</Button>
						{isGenerating ? (
							<span
								className="text-muted-foreground text-sm"
								role="status"
							>
								Writing the draft…
							</span>
						) : null}
					</div>
					{doc ? (
						<p className="text-muted-foreground text-xs">
							Regenerating writes a new version to compare
							against. The blog post you have saved is not
							affected until you adopt it.
						</p>
					) : null}
				</section>
			) : null}

			{/*
			 * A SECOND action, never a replacement for the one above. Regenerate
			 * rebuilds the post from the planning analysis; this one revises the
			 * saved text. Both are useful and they answer different questions,
			 * so the panel offers both — and offers this one only once there is
			 * something saved to revise, since without a working draft it has no
			 * input and would just be a regeneration with a confusing label.
			 */}
			{canEdit && working?.hasBody ? (
				<section className="space-y-2">
					<label
						className="editorial-label block"
						htmlFor="blog-post-refine"
					>
						Refine the saved draft
					</label>
					<Textarea
						id="blog-post-refine"
						value={refineInstruction}
						onChange={(e) => setRefineInstruction(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={2}
						placeholder="Make it shorter. Warmer tone. Lead with the metric."
						disabled={isGenerating || generate.isPending}
					/>
					<div className="flex items-center gap-3">
						<Button
							type="button"
							variant="outline"
							onClick={() =>
								generate.mutate({
									projectId,
									topicId,
									organizationId,
									guidance: refineInstruction.trim() || null,
									refineFromWorkingDraft: true,
								})
							}
							// Required here where it is optional above: a
							// refinement with no instruction is a rewrite of
							// the draft for no stated reason, which is the one
							// thing this action cannot usefully do.
							disabled={
								!refineInstruction.trim() ||
								isGenerating ||
								generate.isPending
							}
						>
							{isGenerating || generate.isPending ? (
								<Loader2Icon
									className="mr-2 size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<PencilLineIcon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
							)}
							Refine draft
						</Button>
					</div>
					<p className="text-muted-foreground text-xs">
						Starts from the blog post you have saved and changes
						only what you ask for. The result arrives as a new
						version to compare against; nothing you have saved
						changes until you adopt it.
					</p>
				</section>
			) : null}

			{isStranded ? (
				<p className="text-muted-foreground text-sm" role="alert">
					The last run didn't report back within its time limit.
					{canEdit ? " Generating again will start a fresh one." : ""}
				</p>
			) : null}

			{attempt?.status === "FAILED" ? (
				<p className="text-muted-foreground text-sm" role="alert">
					{attempt.error ?? "The last draft could not be generated."}
				</p>
			) : null}

			<DraftComparison saved={savedDraft} candidate={candidate} />

			{doc ? (
				<>
					{safetyDoc?.safetyNote ? (
						<GeneralizationNotes
							heading="How this was generalized"
							note={safetyDoc.safetyNote}
							describesAnotherVersion={
								noteDescribesAnotherVersion
							}
						/>
					) : null}

					{doc.inputsNeeded.length > 0 ? (
						<section className="space-y-2">
							<h3 className="editorial-label">Inputs needed</h3>
							<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
								{doc.inputsNeeded.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</section>
					) : null}

					{doc.categories.length > 0 ? (
						<section className="space-y-2">
							<h3 className="editorial-label">
								Suggested categories
							</h3>
							<p className="text-muted-foreground text-sm">
								{doc.categories.join(", ")}
							</p>
						</section>
					) : null}

					{doc.keywords.length > 0 ? (
						<section className="space-y-2">
							<h3 className="editorial-label">
								Suggested keywords
							</h3>
							<p className="text-muted-foreground text-sm">
								{doc.keywords.join(", ")}
							</p>
						</section>
					) : null}
				</>
			) : !isGenerating &&
				attempt?.status !== "FAILED" &&
				!working?.hasBody ? (
				<p className="text-muted-foreground text-sm">
					No blog post draft yet.
				</p>
			) : null}
		</div>
	);
}
