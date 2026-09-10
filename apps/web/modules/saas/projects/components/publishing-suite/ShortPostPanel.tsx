"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	Loader2Icon,
	PencilLineIcon,
	ScissorsIcon,
	SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DraftVersions } from "./DraftVersions";
import { FEED_FOLD_ESTIMATE, splitAtFeedFold } from "./feed-fold";
import { GeneralizationNotes } from "./GeneralizationNotes";
import type { TopicDraftState, TopicWorkingDraftState } from "./GenerationTabs";

/** Mirrors the API's own bound, so the field cannot submit what it would reject. */
const GUIDANCE_MAX = 2000;

/**
 * The Short Post / Tweet generation panel (Fizzy #1853, Phase 2B-2).
 *
 * FR10/FR12/FR16-FR20 and FR32/FR33: optional guidance, a generate action, the
 * three labeled options it produces, and the control that adopts one as the
 * topic's working draft.
 *
 * Mounted ONLY on the Short Post tab. The Blog Post tab keeps 2B-1's read-only
 * panel until 2B-3, because its contract is different in a way that matters —
 * blog generation seeds a working draft on the first run (FR21) where this one
 * deliberately does not (DV4), so sharing a component would mean a flag deciding
 * which product it is.
 *
 * A DELIBERATE vocabulary split, and the reason the two halves of this file
 * disagree: the stored document, the schema and the `selectShortPostOption`
 * procedure all call these OPTIONS, and nothing user-facing does any more. A PO
 * read "options" under a guidance field as a question to answer rather than
 * three finished posts to choose between, so every string a reader sees now
 * says DRAFT. The field name stays what the API and the temporal activity
 * already write; renaming it would ripple well past a copy fix. Below the
 * render, `option` means the record — above it, "draft" means the thing on
 * screen.
 */

/** One option as the stored draft document holds it. */
interface ShortPostOption {
	label: string;
	text: string;
	estimatedCharacters: number;
}

interface ShortPostDocument {
	options: ShortPostOption[];
	hashtags: string[];
	inputsNeeded: string[];
	safetyNote: string | null;
}

/**
 * Read the three options out of a draft's stored `content`.
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
function readShortPostDocument(content: unknown): ShortPostDocument | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const raw = content as Record<string, unknown>;
	if (!Array.isArray(raw.options)) {
		return null;
	}

	const options: ShortPostOption[] = [];
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

export function ShortPostPanel({
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
	/** PR2: a reader sees the candidate drafts but gets no controls. */
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
		orpc.projects.publishingSuite.generateShortPost.mutationOptions({
			onSuccess: (result) => {
				// `started: false` is an ANSWER, not a failure — Temporal is down,
				// or a run this tab has not seen yet is already filling the row.
				// Reporting either as an error would send the reader looking for
				// a fault that is not theirs.
				if (!result.started) {
					toast.info(
						result.reason === "unavailable"
							? "Generation is unavailable right now. Try again in a few minutes."
							: "A short post is already being generated for this topic.",
					);
				}
				invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not start the short post.");
			},
		}),
	);

	const select = useMutation(
		orpc.projects.publishingSuite.selectShortPostOption.mutationOptions({
			onSuccess: () => {
				toast.success("Saved as the working short post.");
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
						"The saved short post changed while you were choosing. Refreshed — take another look.",
					);
					invalidateDrafts();
					return;
				}
				toast.error("Could not save that draft.");
			},
		}),
	);

	const doc = readShortPostDocument(draft?.latestReady?.content ?? null);
	const readyId = draft?.latestReady?.id ?? null;

	/**
	 * The safety fields of the version the SAVED text came from.
	 *
	 * `doc` is the newest READY candidate — right for the previews, wrong for
	 * anything describing the working draft below them. When v1 was generalized
	 * and v2 needs none, `doc.safetyNote` is null, the section stops rendering,
	 * and the reader loses the explanation of the text they actually hold.
	 *
	 * Blog, Case Study and Stakeholder Email were fixed for this; the two
	 * short-form panels were missed and kept reading the newest candidate.
	 */
	const hasUnadoptedVersion =
		readyId !== null && working?.sourceDraftId !== readyId;
	const notesDescribeAnotherVersion =
		hasUnadoptedVersion && working?.hasBody === true;
	const adoptedDoc = readShortPostDocument(working?.sourceContent ?? null);
	const safetyDoc =
		notesDescribeAnotherVersion && adoptedDoc ? adoptedDoc : doc;
	/** A source row past retention: the newest note is all there is to show. */
	const noteDescribesAnotherVersion =
		notesDescribeAnotherVersion && adoptedDoc === null;

	/**
	 * Whether a saved working draft IS this option.
	 *
	 * Both halves, and the draft id is the half that matters. The prompt is
	 * asked for descriptive labels, so "Direct" recurring in the next
	 * regeneration with entirely different text is the common case rather than
	 * the exotic one — and comparing on the label alone marked that new option as
	 * already saved AND disabled its button, so it could not be adopted at all.
	 * Found in adversarial review; two cases in the panel suite pin both
	 * directions.
	 */
	const isSavedOption = (option: ShortPostOption) =>
		Boolean(
			working?.hasBody &&
				// `readyId` non-null FIRST. Without it, a working draft whose
				// source candidate was deleted (`sourceDraftId` null under the
				// composite FK's `ON DELETE SET NULL`) would compare
				// `null === null` as a match against a topic that has no READY
				// draft at all. Unreachable today only because no options render
				// without one — which is a fact about the caller, not about this
				// predicate, and 2B-3 changes what renders here.
				readyId !== null &&
				working.sourceDraftId === readyId &&
				working.sourceOptionLabel === option.label,
		);

	const handleSelect = (option: ShortPostOption) => {
		if (!readyId) {
			return;
		}
		// FR33 is satisfied structurally — generation only ever writes the
		// candidate table — but REPLACING a saved draft with different text is a
		// real overwrite. It is the user's own action either way, so this
		// confirms rather than blocks. Keyed on the same identity as
		// `isSavedOption`, so a same-labelled option from a newer draft asks
		// instead of slipping through as "the same one".
		if (
			working?.hasBody &&
			!isSavedOption(option) &&
			!window.confirm(
				"This replaces the short post you saved earlier. Continue?",
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

	return (
		<div className="space-y-5">
			{canEdit ? (
				<section className="space-y-2">
					<label
						className="publishing-label block"
						htmlFor="short-post-guidance"
					>
						Guidance (optional)
					</label>
					<Textarea
						id="short-post-guidance"
						value={guidance}
						onChange={(e) => setGuidance(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={3}
						placeholder="Tone, audience, platform, hashtags, a call to action, or a target character count."
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
							{doc ? "Regenerate drafts" : "Generate short post"}
						</Button>
						{isGenerating ? (
							<span
								className="text-muted-foreground text-sm"
								role="status"
							>
								Writing three drafts…
							</span>
						) : null}
					</div>
					{doc ? (
						<p className="text-muted-foreground text-xs">
							Regenerating replaces these candidates. A short post
							you have already saved is not affected.
						</p>
					) : null}
				</section>
			) : null}

			{/*
			 * A SECOND action, never a replacement for the one above.
			 * Regenerate rebuilds the short post from the planning analysis; this
			 * one revises the saved text. Both are useful and they answer
			 * different questions, so the panel offers both — and offers this
			 * one only once there is something saved to revise, since without a
			 * working draft it has no input and would just be a regeneration
			 * with a confusing label.
			 */}
			{canEdit && working?.hasBody ? (
				<section className="space-y-2">
					<label
						className="publishing-label block"
						htmlFor="short-post-refine"
					>
						Refine the saved draft
					</label>
					<Textarea
						id="short-post-refine"
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
						Starts from the short post you have saved and changes
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

			{working?.hasBody ? (
				<section className="space-y-2">
					<h3 className="publishing-label">Working short post</h3>
					<div className="rounded-xl border border-border bg-muted/40 p-4">
						<p className="whitespace-pre-wrap text-sm leading-relaxed">
							{working.body}
						</p>
						{working.sourceOptionLabel ? (
							<p className="mt-3 text-muted-foreground text-xs">
								From “{working.sourceOptionLabel}”.
							</p>
						) : null}
					</div>
				</section>
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
					const version = readShortPostDocument(
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
					 * Three PREVIEWS of one post, not three questions.
					 *
					 * The shape this replaced was a stacked list of bordered
					 * cards, each headed by its variant label with a paragraph
					 * and a button under it, directly below a guidance field
					 * and a generate button — which is, to the character, how
					 * this product renders a question with suggested answers.
					 * A PO read it as exactly that ("i clicked generate and it
					 * asks me more questions?"), and renaming the heading was
					 * never going to fix a resemblance that was structural.
					 *
					 * So the content leads. Each candidate renders as the post
					 * would read, inside a neutral frame that reproduces the
					 * CONSTRAINT a feed imposes — the character count and where
					 * the fold falls — and the variant label drops to a quiet
					 * tag in the frame's header. Deliberately no platform
					 * chrome: no logo, no imitation of anyone's UI. What is
					 * being previewed is the text under a limit, not a
					 * screenshot of a network.
					 */}
					<section className="space-y-3">
						<div className="space-y-1">
							<h3 className="publishing-label">
								Candidate drafts{" "}
								{draft?.latestReady
									? `(version ${draft.latestReady.version})`
									: null}
							</h3>
							<p className="text-muted-foreground text-xs leading-relaxed">
								Three ways of writing the same post. Pick the
								one to work from — nothing is saved until you
								do.
							</p>
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
										className={`overflow-hidden rounded-xl border bg-card ${
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
													Most feeds fold a post after
													roughly {FEED_FOLD_ESTIMATE}{" "}
													characters — the dimmed text
													sits behind “see more”.
												</p>
											) : null}
										</div>
										{canEdit ? (
											<div className="border-border border-t px-4 py-3">
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

					{doc.inputsNeeded.length > 0 ? (
						<section className="space-y-2">
							<h3 className="publishing-label">Inputs needed</h3>
							<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
								{doc.inputsNeeded.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</section>
					) : null}

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
					No short post drafts yet.
				</p>
			) : null}
		</div>
	);
}
