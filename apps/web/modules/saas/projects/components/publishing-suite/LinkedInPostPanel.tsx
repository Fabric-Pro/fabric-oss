"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Textarea } from "@ui/components/textarea";
import {
	Loader2Icon,
	PencilLineIcon,
	ScissorsIcon,
	SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyDraftButton } from "./CopyDraftButton";
import { DraftDownloadDropdown } from "./DraftDownloadDropdown";
import { DraftLockBanner, useDraftEditLock } from "./DraftEditLock";
import { DraftRefinementReview, useDraftRefinement } from "./DraftRefinement";
import { DraftVersions } from "./DraftVersions";
import { FEED_FOLD_ESTIMATE, splitAtFeedFold } from "./feed-fold";
import { GeneralizationNotes } from "./GeneralizationNotes";
import type { TopicDraftState, TopicWorkingDraftState } from "./GenerationTabs";

/** Mirrors the API's own bound, so the field cannot submit what it would reject. */
const GUIDANCE_MAX = 2000;

/**
 * The saved draft gets a working area, not a four-row box.
 *
 * The same idiom the Planning & Analysis editor uses for its region: a floor so
 * the draft stays editable on a laptop, viewport-relative between the bounds so
 * a tall screen is actually used, and a ceiling so a maximised window does not
 * run the text past where the eye tracks. A LinkedIn post is written and
 * rewritten in place — `rows={4}` was a keyhole over a draft usually longer
 * than itself.
 */
const WORKING_DRAFT_HEIGHT_CLASS = "h-[clamp(24rem,60vh,44rem)]";

/**
 * The LinkedIn Post generation panel (Fizzy #1851).
 *
 * A sibling of `ShortPostPanel`, not a reuse of it, and the reason is the same
 * one that makes LinkedIn its own content type rather than a re-labelled tweet:
 * a LinkedIn feed hides everything after the first line or two behind "see
 * more" and imposes no hard ceiling, where X imposes a hard ceiling and hides
 * nothing. So the two panels emphasise opposite things. The tweet's preview
 * shows a character count against a limit and mentions the fold in passing;
 * this one leads with the fold, because on this platform the opening line is
 * the whole of what most readers will ever see.
 *
 * What they DO share is the fold arithmetic itself, imported from `feed-fold`.
 * That constant was written for LinkedIn's behaviour in the first place, and a
 * second copy of it here would be two numbers describing one platform.
 *
 * Mounted on the LinkedIn Post tab — see `GENERATION_ACTIVE_POST_TYPES` in
 * `topic-shared.ts` for the activation this waits on.
 *
 * The same vocabulary split the short post made, for the same reason: the
 * stored document, the schema and the `selectLinkedInPostOption` procedure all
 * call these OPTIONS, and nothing user-facing does. A PO read "options" under a
 * guidance field as a question to answer rather than finished posts to choose
 * between, so every string a reader sees says DRAFT. Below the render, `option`
 * means the record — above it, "draft" means the thing on screen.
 */

/** One option as the stored draft document holds it. */
interface LinkedInPostOption {
	label: string;
	text: string;
	estimatedCharacters: number;
}

interface LinkedInPostDocument {
	options: LinkedInPostOption[];
	hashtags: string[];
	inputsNeeded: string[];
	safetyNote: string | null;
}

/**
 * Read the options out of a draft's stored `content`.
 *
 * Defensive rather than trusting: `content` is `Json?`, so a row written by an
 * older shape must degrade to "no options" instead of throwing inside a render.
 * A panel that crashes takes the whole Topic Item Page with it.
 *
 * Not exported: only this file reads it, and the component test drives it
 * through the rendered panel rather than calling it directly — which is the
 * honest way to test it anyway, since what matters is that a bad shape produces
 * an empty state rather than an exception.
 */
function readLinkedInPostDocument(
	content: unknown,
): LinkedInPostDocument | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const raw = content as Record<string, unknown>;
	if (!Array.isArray(raw.options)) {
		return null;
	}

	const options: LinkedInPostOption[] = [];
	for (const item of raw.options) {
		if (item == null || typeof item !== "object") {
			continue;
		}
		const o = item as Record<string, unknown>;
		if (typeof o.label !== "string" || typeof o.text !== "string") {
			continue;
		}
		options.push({
			label: o.label,
			text: o.text,
			estimatedCharacters:
				typeof o.estimatedCharacters === "number"
					? o.estimatedCharacters
					: // The model's estimate is what is stored, and it is not
						// recomputed when present. Falling back to the raw
						// length here is a display convenience for an older row,
						// not a second source of truth.
						o.text.length,
		});
	}
	if (options.length === 0) {
		return null;
	}

	return {
		options,
		hashtags: Array.isArray(raw.hashtags)
			? raw.hashtags.filter((h): h is string => typeof h === "string")
			: [],
		inputsNeeded: Array.isArray(raw.inputsNeeded)
			? raw.inputsNeeded.filter((i): i is string => typeof i === "string")
			: [],
		safetyNote: typeof raw.safetyNote === "string" ? raw.safetyNote : null,
	};
}

export function LinkedInPostPanel({
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
	/** A reader sees the candidate drafts but gets no controls. */
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
	 * yet; this steers a change to one that does ("make it shorter"). Sent as
	 * `guidance` on the wire — it IS the run's instruction, and putting it there
	 * is what records it on the attempt row.
	 */
	const [refineInstruction, setRefineInstruction] = useState("");
	/**
	 * Both instructions live behind a button now, so each owns its open state
	 * and closes on submit. A popover left standing over the panel covers the
	 * drafts the reader just asked it to change.
	 */
	const [guidanceOpen, setGuidanceOpen] = useState(false);
	const [refineOpen, setRefineOpen] = useState(false);

	const attempt = draft?.latestAttempt ?? null;
	// `isExpired` splits GENERATING in two: a LIVE run is genuinely in flight, a
	// STRANDED one will never report back on its own. The button must stay
	// enabled for the second, because the ONLY code that reclaims a stranded row
	// runs inside the NEXT attempt — disabling on `status === GENERATING` alone
	// would lock the tab with no user action able to free it.
	const isStranded = attempt?.status === "GENERATING" && attempt.isExpired;
	const isGenerating = attempt?.status === "GENERATING" && !isStranded;

	/**
	 * The refinement proposal for this content type, and the three mutations
	 * that drive it.
	 *
	 * A refinement no longer writes a draft row, so NOTHING about it can be
	 * read off `attempt`: there is no GENERATING attempt to watch, no falling
	 * edge to clear a local flag on, and no candidate to adopt. It also stops
	 * being a run that produces OPTIONS — the generation schema requires three
	 * distinct ones, which is why asking to cut a line used to come back as
	 * three rewrites. One revision of the saved text, reviewed as a diff.
	 */
	const refinement = useDraftRefinement({
		projectId,
		topicId,
		organizationId,
		postType: "LINKEDIN_POST",
		working,
		label: "LinkedIn post",
		// Accepting replaces the saved body, so unsaved typing in the
		// editor is the one thing here a refresh cannot bring back.
		// Asked in the same words the adopt path has always used.
		confirmAccept: () =>
			!isBodyDirty ||
			window.confirm(
				"Saving the refined LinkedIn post discards your unsaved edits. Continue?",
			),
		// The accepted text replaces what the editor was showing, so the
		// local override goes with it — otherwise the next Save writes
		// the old text back over the refinement just accepted.
		onAccepted: () => setEditedBody(null),
	});

	const invalidateDrafts = () => {
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.listTopicDrafts.queryKey({
				input: { projectId, topicId, organizationId },
			}),
		});
	};

	const generate = useMutation(
		orpc.projects.publishingSuite.generateLinkedInPost.mutationOptions({
			onSuccess: (result) => {
				// `started: false` is an ANSWER, not a failure — Temporal is down,
				// or a run this tab has not seen yet is already filling the row.
				// Reporting either as an error would send the reader looking for
				// a fault that is not theirs.
				if (!result.started) {
					toast.info(
						result.reason === "unavailable"
							? "Generation is unavailable right now. Try again in a few minutes."
							: "A LinkedIn post is already being generated for this topic.",
					);
				}
				invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not start the LinkedIn post.");
			},
		}),
	);

	const select = useMutation(
		orpc.projects.publishingSuite.selectLinkedInPostOption.mutationOptions({
			onSuccess: () => {
				toast.success("Saved as the working LinkedIn post.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				// A CONFLICT means someone else changed the working draft while
				// this tab was looking at an older one. Refreshing is the fix, so
				// say that rather than reporting a generic failure — and pull the
				// new state in so the next click is against what is actually
				// saved.
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"The saved LinkedIn post changed while you were choosing. Refreshed — take another look.",
					);
					invalidateDrafts();
					return;
				}
				toast.error("Could not save that draft.");
			},
		}),
	);

	const doc = readLinkedInPostDocument(draft?.latestReady?.content ?? null);
	const readyId = draft?.latestReady?.id ?? null;

	/**
	 * The safety fields of the version the SAVED text came from — the same
	 * correction `ShortPostPanel` carries, for the same reason: `doc` is the
	 * newest READY candidate, so a v1-generalized / v2-clean pair drops the
	 * section while the saved text is still the generalized one.
	 */
	const hasUnadoptedVersion =
		readyId !== null && working?.sourceDraftId !== readyId;
	const notesDescribeAnotherVersion =
		hasUnadoptedVersion && working?.hasBody === true;
	const adoptedDoc = readLinkedInPostDocument(working?.sourceContent ?? null);
	const safetyDoc =
		notesDescribeAnotherVersion && adoptedDoc ? adoptedDoc : doc;
	/** A source row past retention: the newest note is all there is to show. */
	const noteDescribesAnotherVersion =
		notesDescribeAnotherVersion && adoptedDoc === null;

	/**
	 * Whether a saved working draft IS this option.
	 *
	 * Both halves, and the draft id is the half that matters. The prompt is
	 * asked for descriptive labels, so "Result first" recurring in the next
	 * regeneration with entirely different text is the common case rather than
	 * the exotic one — and comparing on the label alone would mark that new
	 * option as already saved AND disable its button, so it could not be adopted
	 * at all.
	 */
	const isSavedOption = (option: LinkedInPostOption) =>
		Boolean(
			working?.hasBody &&
				// `readyId` non-null FIRST. Without it, a working draft whose
				// source candidate was deleted (`sourceDraftId` null under the
				// composite FK's `ON DELETE SET NULL`) would compare
				// `null === null` as a match against a topic that has no READY
				// draft at all.
				readyId !== null &&
				working.sourceDraftId === readyId &&
				working.sourceOptionLabel === option.label,
		);

	const handleSelect = (option: LinkedInPostOption) => {
		if (!readyId) {
			return;
		}
		// Generation only ever writes the candidate table, so nothing here can
		// clobber saved work on its own — but REPLACING a saved draft with
		// different text is a real overwrite. It is the user's own action either
		// way, so this confirms rather than blocks. Keyed on the same identity as
		// `isSavedOption`, so a same-labelled option from a newer draft asks
		// instead of slipping through as "the same one".
		if (
			working?.hasBody &&
			!isSavedOption(option) &&
			!window.confirm(
				"This replaces the LinkedIn post you saved earlier. Continue?",
			)
		) {
			return;
		}
		select.mutate({
			projectId,
			topicId,
			organizationId,
			draftId: readyId,
			optionLabel: option.label,
			// Optimistic concurrency: when THIS tab last saw the working draft.
			// The server refuses if it has moved on, so two people choosing
			// different options do not silently overwrite one another — the loser
			// is told rather than left believing their choice stuck.
			//
			// Keyed on `working` existing, NOT on `hasBody`: a row whose body is
			// blank still exists and still has an `updatedAt` the server will
			// compare against, so sending null for it would report every such
			// save as stale.
			expectedUpdatedAt: working ? new Date(working.updatedAt) : null,
		});
	};

	const [editedBody, setEditedBody] = useState<string | null>(null);
	const bodyValue = editedBody ?? working?.body ?? "";
	const isBodyDirty =
		editedBody !== null && editedBody !== (working?.body ?? "");

	const saveBody = useMutation(
		orpc.projects.publishingSuite.saveLinkedInPostBody.mutationOptions({
			onSuccess: () => {
				setEditedBody(null);
				toast.success("LinkedIn post saved.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				// A CONFLICT means somebody else changed the draft while this
				// tab was editing. The edit is NOT discarded — `editedBody` is
				// left standing so the reader can copy their text first. The
				// working draft is SHARED per topic, so this is a real
				// collision rather than a theoretical one.
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"Someone else changed this LinkedIn post while you were editing. Your text is still here — copy it before refreshing.",
					);
					return;
				}
				toast.error("Could not save the LinkedIn post.");
			},
		}),
	);

	const handleSaveBody = () => {
		if (!working || !isBodyDirty) {
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
	 * One field with two homes: the first-run block under the empty state, and
	 * the "Regenerate drafts" popover once candidates exist. Built once so the
	 * two cannot drift — they share an `id`, and a second copy of that is a
	 * second chance for the label to stop naming the field it points at. Only
	 * ever one of them is mounted, so the id stays unique on the page.
	 */
	/** Live in one place too: the run is one run wherever it was started. */
	const generatingStatus = isGenerating ? (
		<span className="text-muted-foreground text-sm" role="status">
			Writing three drafts…
		</span>
	) : null;

	const guidanceField = (
		<div className="space-y-2">
			<label
				className="publishing-label block"
				htmlFor="linkedin-post-guidance"
			>
				Guidance (optional)
			</label>
			<Textarea
				id="linkedin-post-guidance"
				value={guidance}
				onChange={(e) => setGuidance(e.target.value)}
				maxLength={GUIDANCE_MAX}
				rows={3}
				placeholder="Tone, who should be posting it, the audience, a call to action, or how long it should run."
				disabled={isGenerating || generate.isPending}
			/>
		</div>
	);

	// Advisory only: it says who else is in the draft and never refuses a write.
	const editLock = useDraftEditLock({
		projectId,
		topicId,
		organizationId,
		postType: "LINKEDIN_POST",
		canEdit,
		hasDraft: Boolean(working?.hasBody),
		isDirty: isBodyDirty,
	});

	return (
		<div className="space-y-5">
			<DraftLockBanner
				heldBy={editLock.heldBy}
				onTakeOver={editLock.takeOver}
			/>
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

			{working?.hasBody ? (
				<section className="space-y-2">
					<h3 className="publishing-label">Working LinkedIn post</h3>
					<div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
						{/* EDITABLE. The five long-form panels have had a
						    textarea over the adopted body since 2B-3; TWEET and
						    LINKEDIN_POST were deferred there and never picked
						    up, so the two drafts most likely to need a word
						    changed before posting were the two you could not
						    change. Same column, same compare-and-set. */}
						{canEdit ? (
							<Textarea
								aria-label="Working LinkedIn post"
								value={bodyValue}
								onChange={(e) => setEditedBody(e.target.value)}
								className={WORKING_DRAFT_HEIGHT_CLASS}
								disabled={saveBody.isPending}
							/>
						) : (
							<p className="whitespace-pre-wrap text-sm leading-relaxed">
								{working.body}
							</p>
						)}
						<div className="flex flex-wrap items-center gap-2">
							{canEdit ? (
								<>
									<Button
										type="button"
										size="sm"
										onClick={handleSaveBody}
										disabled={
											!isBodyDirty || saveBody.isPending
										}
									>
										{saveBody.isPending ? (
											<Loader2Icon
												className="mr-2 size-4 motion-safe:animate-spin"
												aria-hidden="true"
											/>
										) : null}
										Save changes
									</Button>
									{isBodyDirty ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => setEditedBody(null)}
											disabled={saveBody.isPending}
										>
											Discard changes
										</Button>
									) : null}
									{/*
									 * A SECOND action, never a replacement for
									 * regeneration. Regenerate rebuilds the post
									 * from the planning analysis; this one
									 * revises the saved text, which is why it
									 * belongs in that text's own action row. As
									 * a field above the draft it asked the
									 * reader to describe a change to something
									 * they could not see while typing it.
									 */}
									<Popover
										open={refineOpen}
										onOpenChange={setRefineOpen}
									>
										<PopoverTrigger asChild>
											<Button
												type="button"
												variant="outline"
												size="sm"
												disabled={!refinement.canStart}
											>
												<PencilLineIcon
													className="mr-2 size-4"
													aria-hidden="true"
												/>
												Refine with AI
											</Button>
										</PopoverTrigger>
										<PopoverContent
											align="start"
											className="w-[min(24rem,calc(100vw-2rem))] space-y-3 p-3"
										>
											<div className="space-y-1">
												<label
													className="publishing-label block"
													htmlFor="linkedin-post-refine"
												>
													Refine the saved draft
												</label>
												<p className="text-muted-foreground text-xs leading-relaxed">
													Starts from the LinkedIn
													post you have saved and
													changes only what you ask
													for. The result comes back
													as a proposed revision of
													that text, shown as a diff
													you accept or discard — it
													does not make a new version,
													and nothing you have saved
													changes until you accept it.
												</p>
											</div>
											<Textarea
												id="linkedin-post-refine"
												value={refineInstruction}
												onChange={(e) =>
													setRefineInstruction(
														e.target.value,
													)
												}
												maxLength={GUIDANCE_MAX}
												rows={3}
												placeholder="Stronger opening line. Cut the middle. Less formal."
												disabled={!refinement.canStart}
											/>
											<Button
												type="button"
												size="sm"
												onClick={() => {
													refinement.start(
														refineInstruction,
													);
													setRefineOpen(false);
												}}
												// Required here where it is
												// optional for a generation: a
												// refinement with no
												// instruction is a rewrite of
												// the draft for no stated
												// reason, which is the one
												// thing this action cannot
												// usefully do.
												disabled={
													!refineInstruction.trim() ||
													!refinement.canStart
												}
											>
												{refinement.isRunning ? (
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
										</PopoverContent>
									</Popover>
									{/* The pending state where the press happened, rather than
									    only in the drafts section further down. */}
									{refinement.isRunning ? (
										<output className="flex items-center gap-2 text-muted-foreground text-sm">
											<Loader2Icon
												className="size-4 motion-safe:animate-spin"
												aria-hidden="true"
											/>
											Revising your saved LinkedIn post…
										</output>
									) : null}
								</>
							) : null}
							<CopyDraftButton markdown={bodyValue} />
							<DraftDownloadDropdown
								markdown={bodyValue}
								filename="linkedin-post"
							/>
						</div>
						{/* Which AI does what, said where the two meet.

						    The AI Assistant rail stays docked on this tab and opens with
						    "tell me how to change the planning analysis" — true of what
						    it does, and easy to read on a draft tab as an offer to change
						    THIS text. It cannot: its readable context carries the topic
						    and the analysis and no draft at all, and the one thing it
						    writes is the analysis editor.

						    Said here rather than by hiding the rail, because the rail is a
						    working tool on this page — it answers questions about the
						    topic — and a tool removed because it does less than a reader
						    hoped teaches nothing. Named, not placed: the rail closes
						    itself on a narrow viewport, so "on the right" is wrong on a
						    phone the way naming a column is.

						    Gated, because the action row above is not: both affordances
						    it names belong to someone who can edit. */}
						{canEdit ? (
							<p className="text-muted-foreground text-xs leading-relaxed">
								Refine with AI is what edits this LinkedIn post
								— the AI Assistant works on the planning
								analysis, not on drafts.
							</p>
						) : null}
						{working.sourceOptionLabel ? (
							<p className="text-muted-foreground text-xs">
								From “{working.sourceOptionLabel}”.
							</p>
						) : null}
					</div>
				</section>
			) : null}

			{/* Directly under the draft it revises, because that is what it
			    is about: a proposal to change the saved LinkedIn post, not a
			    fourth option beside the three a generation produces. The
			    candidates grid below is untouched by it. */}
			{working?.hasBody ? (
				<DraftRefinementReview
					refinement={refinement}
					baseline={working.body}
					label="LinkedIn post"
					canEdit={canEdit}
				/>
			) : null}

			{/* Read-only here, deliberately. A short-form run produces
			    SEVERAL options, so restoring a version means picking one of its
			    options — which is the panel's own "Use this draft" affordance, not
			    something a version list can do on its own. Viewing is still the
			    thing that was missing: "version 2" had no version 1 to open. */}
			<DraftVersions
				versions={draft?.versions ?? []}
				adoptedId={working?.sourceDraftId ?? null}
				renderBody={(id) => {
					const version = readLinkedInPostDocument(
						draft?.versions?.find((v) => v.id === id)?.content ??
							null,
					);
					return version && version.options.length > 0 ? (
						<ul className="space-y-3">
							{version.options.map((option) => (
								<li
									key={option.label}
									className="rounded-lg border border-border p-3"
								>
									<p className="font-medium text-foreground text-xs uppercase tracking-[0.14em]">
										{option.label}
									</p>
									<p className="mt-1 whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
										{option.text}
									</p>
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground text-sm">
							That version's content could not be read.
						</p>
					);
				}}
			/>

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

					{/*
					 * Three PREVIEWS of one post, not three questions — the
					 * shape `ShortPostPanel` arrived at after a PO read a
					 * stacked list of labelled cards under a guidance field as
					 * the product's question-with-suggested-answers control.
					 *
					 * What differs here is the emphasis. On X the constraint a
					 * writer is fighting is the ceiling, so the count leads. On
					 * LinkedIn there is no ceiling worth showing and the
					 * constraint is the FOLD, so the dimming is the point of the
					 * preview rather than a footnote to it — hence the
					 * explanation above the list, where it frames all three,
					 * instead of only under the ones long enough to trigger it.
					 *
					 * Deliberately no platform chrome: no logo, no imitation of
					 * anyone's UI, no brand colour. What is being previewed is
					 * the text under a constraint, not a screenshot of a
					 * network.
					 */}
					<section className="space-y-3">
						<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
							<div className="space-y-1">
								<h3 className="publishing-label">
									Candidate drafts{" "}
									{draft?.latestReady
										? `(version ${draft.latestReady.version})`
										: null}
								</h3>
								<p className="text-muted-foreground text-xs leading-relaxed">
									Three ways of writing the same post. Pick
									the one to work from — nothing is saved
									until you do. Text past roughly the first{" "}
									{FEED_FOLD_ESTIMATE} characters is dimmed:
									that is the part a feed hides behind “see
									more”, so judge each draft on what stays
									bright.
								</p>
							</div>
							{/*
							 * Regeneration belongs WITH the candidates it
							 * replaces. Above the working draft it was a
							 * guidance field floating over content it does not
							 * act on; here the button sits on the section it
							 * rewrites, and the guidance that steers it is one
							 * click away instead of permanently on screen.
							 */}
							{canEdit ? (
								<div className="flex items-center gap-3">
									{generatingStatus}
									<Popover
										open={guidanceOpen}
										onOpenChange={setGuidanceOpen}
									>
										<PopoverTrigger asChild>
											<Button
												type="button"
												size="sm"
												disabled={
													isGenerating ||
													generate.isPending
												}
											>
												{isGenerating ||
												generate.isPending ? (
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
												Regenerate drafts
											</Button>
										</PopoverTrigger>
										<PopoverContent
											align="end"
											className="w-[min(24rem,calc(100vw-2rem))] space-y-3 p-3"
										>
											<p className="text-muted-foreground text-xs leading-relaxed">
												Regenerating replaces these
												candidates. A LinkedIn post you
												have already saved is not
												affected.
											</p>
											{guidanceField}
											<Button
												type="button"
												size="sm"
												onClick={() => {
													generate.mutate({
														projectId,
														topicId,
														organizationId,
														guidance:
															guidance.trim() ||
															null,
													});
													setGuidanceOpen(false);
												}}
												disabled={
													isGenerating ||
													generate.isPending
												}
											>
												<SparklesIcon
													className="mr-2 size-4"
													aria-hidden="true"
												/>
												Regenerate
											</Button>
										</PopoverContent>
									</Popover>
								</div>
							) : null}
						</div>
						{/* THREE COLUMNS, not a stack.
						 *
						 * Asked for twice — as "OPTIONS (VERSION 1) reads as
						 * questions, a rename wont fix it, we need to change this
						 * design", and again from the other direction as "three
						 * different versions, almost like another set of
						 * questions ... do you want this more like this, more like
						 * that". The first round restyled the cards and left the
						 * structure: a vertical list of bordered cards, each with a
						 * button under it, which is to the character how this
						 * product renders a question with suggested answers.
						 *
						 * Side by side, the same variants stop being three
						 * documents to read in order and become one choice to make.
						 * That is the whole difference, and it is structural rather
						 * than cosmetic — which is why the restyle did not reach it.
						 *
						 * Stacked below `lg`. Three columns of a tweet at phone
						 * width is three columns of one word.
						 */}
						<ul className="grid gap-4 lg:grid-cols-3">
							{doc.options.map((option, index) => {
								const isSaved = isSavedOption(option);
								const { visible, folded } = splitAtFeedFold(
									option.text,
								);
								return (
									<li
										// Position, not label. The schema refuses to
										// persist colliding labels, but `content` is a
										// JSON column that this component parses
										// defensively, so the key does not assume what
										// the parser declines to. The list is replaced
										// wholesale on regeneration and never reordered,
										// so the index is stable for as long as a row is
										// on screen.
										key={`${index}:${option.label}`}
										// `flex h-full flex-col` with `mt-auto`
										// on the footer below: the grid already
										// stretches the cards to a shared height,
										// but the action sat directly under the
										// text, so a short candidate floated its
										// button level with its neighbours' prose
										// and the three read as ragged.
										className={`flex h-full flex-col overflow-hidden rounded-xl border bg-card ${
											isSaved
												? "border-primary/60"
												: "border-border"
										}`}
									>
										<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-border border-b bg-muted/40 px-4 py-2">
											{/* A tag, not a headline. Still an
											    `h4`, so the outline a screen
											    reader walks keeps naming which
											    candidate is which. */}
											<h4 className="font-normal text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
												{option.label}
											</h4>
											<span className="text-muted-foreground text-xs tabular-nums">
												~{option.estimatedCharacters}{" "}
												characters
											</span>
										</div>
										<div className="px-4 py-4">
											{/*
											 * ONE paragraph with an inline
											 * dimmed span, not two blocks
											 * around a rule. A block split
											 * would read the fold more
											 * literally, but it puts a line
											 * break into what a reader
											 * selects and copies — and the
											 * text they copy is the post they
											 * are about to publish.
											 */}
											<p className="whitespace-pre-wrap break-words text-base leading-relaxed">
												{folded ? (
													<>
														<span>{visible}</span>
														{/*
														 * Dimmed, not hidden.
														 * It is the reader's
														 * own text and it has
														 * to stay legible —
														 * `--muted-foreground`
														 * rather than a lighter
														 * tint invented for the
														 * effect.
														 */}
														<span className="text-muted-foreground">
															{folded}
														</span>
													</>
												) : (
													option.text
												)}
											</p>
											{folded ? (
												// The words carry it, not the
												// dimming: a reader who cannot
												// see the tint still learns
												// where the post folds.
												<p className="mt-3 flex items-start gap-2 border-border border-t pt-3 text-muted-foreground text-xs leading-relaxed">
													<ScissorsIcon
														className="mt-0.5 size-3.5 shrink-0"
														aria-hidden="true"
													/>
													The dimmed text sits behind
													“see more”. Only the opening
													is certain to be read.
												</p>
											) : (
												// Said explicitly rather than
												// left to the absence of a
												// note. A short draft clearing
												// the fold entirely is the best
												// outcome this preview can
												// report, and silence reads as
												// "the check did not run".
												<p className="mt-3 border-border border-t pt-3 text-muted-foreground text-xs leading-relaxed">
													Short enough to show in full
													— nothing is hidden behind
													“see more”.
												</p>
											)}
										</div>
										{canEdit ? (
											<div className="mt-auto border-border border-t px-4 py-3">
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														handleSelect(option)
													}
													disabled={
														select.isPending ||
														isSaved
													}
												>
													{isSaved
														? "Saved as working draft"
														: "Use this draft"}
												</Button>
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
					</section>

					{doc.hashtags.length > 0 ? (
						<section className="space-y-2">
							<h3 className="publishing-label">
								Suggested hashtags
							</h3>
							<p className="text-muted-foreground text-sm">
								{doc.hashtags.join(" ")}
							</p>
						</section>
					) : null}
				</>
			) : !isGenerating && attempt?.status !== "FAILED" ? (
				<p className="text-muted-foreground text-sm">
					No LinkedIn post drafts yet.
				</p>
			) : null}

			{/*
			 * The FIRST run keeps its field on the page. There are no
			 * candidates yet for a button to sit on, and someone who has never
			 * run this tab should be shown what steers it rather than have to
			 * find it behind a popover. Once a draft exists the same field
			 * moves into the "Regenerate drafts" popover above — the two are
			 * one `guidanceField`, never two copies.
			 */}
			{canEdit && !doc ? (
				<section className="space-y-2">
					{guidanceField}
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
							Generate LinkedIn post
						</Button>
						{generatingStatus}
					</div>
				</section>
			) : null}
		</div>
	);
}
