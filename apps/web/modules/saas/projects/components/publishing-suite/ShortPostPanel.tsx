"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
	/** PR2: a reader sees the options but gets no controls. */
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const [guidance, setGuidance] = useState("");

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
				toast.error("Could not save that option.");
			},
		}),
	);

	const doc = readShortPostDocument(draft?.latestReady?.content ?? null);
	const readyId = draft?.latestReady?.id ?? null;

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
						className="editorial-label block"
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
							{doc ? "Regenerate options" : "Generate short post"}
						</Button>
						{isGenerating ? (
							<span
								className="text-muted-foreground text-sm"
								role="status"
							>
								Writing three options…
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
					<h3 className="editorial-label">Working short post</h3>
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

			{doc ? (
				<>
					{doc.safetyNote ? (
						<section className="space-y-2">
							<h3 className="editorial-label">
								How this was generalized
							</h3>
							<p className="text-muted-foreground text-sm leading-relaxed">
								{doc.safetyNote}
							</p>
						</section>
					) : null}

					<section className="space-y-3">
						<h3 className="editorial-label">
							Options{" "}
							{draft?.latestReady
								? `(version ${draft.latestReady.version})`
								: null}
						</h3>
						<ul className="space-y-3">
							{doc.options.map((option, index) => {
								const isSaved = isSavedOption(option);
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
										className="rounded-xl border border-border bg-card p-4"
									>
										<div className="flex items-baseline justify-between gap-3">
											<h4 className="font-medium text-sm">
												{option.label}
											</h4>
											<span className="text-muted-foreground text-xs">
												~{option.estimatedCharacters}{" "}
												characters
											</span>
										</div>
										<p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
											{option.text}
										</p>
										{canEdit ? (
											<Button
												type="button"
												variant="outline"
												size="sm"
												className="mt-3"
												onClick={() =>
													handleSelect(option)
												}
												disabled={
													select.isPending || isSaved
												}
											>
												{isSaved
													? "Saved as working draft"
													: "Use this option"}
											</Button>
										) : null}
									</li>
								);
							})}
						</ul>
					</section>

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

					{doc.hashtags.length > 0 ? (
						<section className="space-y-2">
							<h3 className="editorial-label">
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
					No short post options yet.
				</p>
			) : null}
		</div>
	);
}
