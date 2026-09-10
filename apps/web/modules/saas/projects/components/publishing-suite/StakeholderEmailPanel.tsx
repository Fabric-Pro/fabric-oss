"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon, PencilLineIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyDraftButton } from "./CopyDraftButton";
import {
	CandidateDraft,
	DraftComparison,
	SavedDraftCaption,
} from "./DraftComparison";
import { DraftDownloadDropdown } from "./DraftDownloadDropdown";
import { DraftVersions } from "./DraftVersions";
import { GeneralizationNotes, OTHER_VERSION_NOTE } from "./GeneralizationNotes";
import type { TopicDraftState, TopicWorkingDraftState } from "./GenerationTabs";

/** Mirrors the API's own bounds, so a field cannot submit what it would reject. */
const GUIDANCE_MAX = 2000;
const BODY_MAX = 24000;

/**
 * The Stakeholder Email generation panel (Fizzy #1854, Phase 2C slice 2).
 *
 * Mirrors `CaseStudyPanel` deliberately and closely — the same `editedBody`
 * sentinel, the same stranded/generating split, the same optimistic-concurrency
 * key, the same CONFLICT branch that keeps a reader's text, the same export
 * caveat block — because the two products have the same shape: one generation
 * seeds one editable draft, and a later version is offered rather than applied.
 *
 * WHAT IT DOES NOT MIRROR, and the difference is the point: there is no clamp
 * here, so nothing on this panel is ever attributed to Fabric. The case study's
 * `customerIdentity` and `metricsBasis` are lowered server-side against the
 * topic's own open approval threads, and its panel says "Set by Fabric" where
 * that happened. `releaseStatus` has no such thread to compare against — Fabric
 * stores no decision kind about whether work shipped, and the activity's header
 * documents why inventing one would be worse than none — so every status this
 * panel renders is the DRAFT's claim and is worded as one. Saying "Fabric set
 * this" over a value nothing checked would be the more expensive failure: a
 * reader who believes a status was verified stops verifying it.
 *
 * What the panel owes a reader is therefore that the safety fields OUTSIDE the
 * editable body are visible, both here and in the file that leaves the app:
 * which release state the draft asserts, who it was written for, what is still
 * missing, and what the draft wrote around. `composeExportMarkdown` carries the
 * same facts into the download, because that is where the on-screen safeguards
 * stop applying — the moment the draft becomes an attachment.
 *
 * All of those describe the LATEST READY generation, and the editor holds the
 * WORKING draft — the same document until a regeneration nobody adopted, and a
 * different one after. `notesDescribeAnotherVersion` says which, and every
 * safety surface is qualified by it rather than only the export.
 */

type ReleaseStatus =
	| "SHIPPED"
	| "IN_PROGRESS"
	| "PLANNED"
	| "UPCOMING"
	| "UNCONFIRMED";

const RELEASE_STATUSES: readonly ReleaseStatus[] = [
	"SHIPPED",
	"IN_PROGRESS",
	"PLANNED",
	"UPCOMING",
	"UNCONFIRMED",
];

/**
 * One phrasing per value, used by BOTH the panel and the export.
 *
 * One map rather than two sets of words: the caveat block exists so a reader of
 * the file learns what a reader of the page learns, and two spellings of the
 * same status are two statuses as soon as one of them is edited.
 *
 * Every one says "the draft" rather than stating the fact directly. Nothing
 * checked these — see the component doc — and "Shipped." reads as Fabric's
 * finding where "The draft says the work is delivered" reads as what it is: a
 * claim made from the source material, which the reader is the one who can
 * confirm.
 */
const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
	SHIPPED: "The draft says the work is delivered and in use.",
	IN_PROGRESS: "The draft says the work is underway, not finished.",
	PLANNED: "The draft says the work is agreed but not started.",
	UPCOMING: "The draft says a release is close.",
	UNCONFIRMED:
		"The source material didn't say whether this has shipped, so the draft asserts no release state.",
};

interface StakeholderEmailDocument {
	subject: string;
	body: string;
	audience: string | null;
	releaseStatus: ReleaseStatus;
	inputsNeeded: string[];
	safetyNote: string | null;
}

/**
 * Read a stakeholder email out of a draft's stored `content`.
 *
 * Defensive rather than trusting, for the reason its Case Study sibling
 * documents: `content` is `Json?`, so a row written by an older shape must
 * degrade to "nothing to show" instead of throwing inside a render.
 *
 * `releaseStatus` falls back to `UNCONFIRMED` rather than to the first member of
 * the enum. A garbled or absent status reading as `SHIPPED` would turn a storage
 * defect into a claim that work is live — the one direction in which being
 * wrong is expensive, on the one content type that gets sent to a sponsor.
 */
function readStakeholderEmailDocument(
	content: unknown,
): StakeholderEmailDocument | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const raw = content as Record<string, unknown>;
	if (typeof raw.subject !== "string" || typeof raw.body !== "string") {
		return null;
	}
	if (!raw.subject.trim() || !raw.body.trim()) {
		return null;
	}

	// Trimmed and emptied out, not merely type-checked. A whitespace-only entry
	// survives `typeof v === "string"` and then renders as a bullet with nothing
	// in it, and on the export path as a caveat line naming no caveat. The
	// schema rejects such an entry at write time now, but this reader also sees
	// rows written before it did, and `audience` below has always done this --
	// the lists simply were not brought along.
	const strings = (value: unknown): string[] =>
		Array.isArray(value)
			? value
					.filter((v): v is string => typeof v === "string")
					.map((v) => v.trim())
					.filter((v) => v.length > 0)
			: [];

	return {
		subject: raw.subject.trim(),
		body: raw.body.trim(),
		// An empty string is not an audience. Trimmed to null so the panel says
		// "doesn't name an audience" rather than rendering a blank line under a
		// heading that promises one.
		audience:
			typeof raw.audience === "string" && raw.audience.trim()
				? raw.audience.trim()
				: null,
		releaseStatus: RELEASE_STATUSES.includes(
			raw.releaseStatus as ReleaseStatus,
		)
			? (raw.releaseStatus as ReleaseStatus)
			: "UNCONFIRMED",
		inputsNeeded: strings(raw.inputsNeeded),
		safetyNote:
			typeof raw.safetyNote === "string" && raw.safetyNote.trim()
				? raw.safetyNote.trim()
				: null,
	};
}

/**
 * The Markdown that leaves the app, caveats and all.
 *
 * The problem this solves: every safety field lives OUTSIDE the editable body.
 * On screen that is right — they are advice about the draft, and an author who
 * had to delete four sections after every regeneration would stop regenerating.
 * In an exported file it is a hole. A naive export hands someone a clean DOCX of
 * an email whose release state nobody could confirm and that is missing two
 * facts, with none of that visible — and a stakeholder email is the format most
 * likely to be forwarded verbatim to the person it is about.
 *
 * So a draft that is not clean is prefixed with a block naming all of it. A
 * clean one is exported unchanged: a caveat that fires on every draft is a
 * caveat nobody reads.
 *
 * WHICH RELEASE STATES COUNT AS UNCLEAN, and the line is drawn deliberately.
 * Only `UNCONFIRMED` does. The other four are carried by the prose itself — an
 * email written under `PLANNED` says "we're planning to", and a reader of the
 * file learns the release state from the sentence in front of them. `UNCONFIRMED`
 * is the one state the body cannot express, because it means the draft asserted
 * no release state at all: the file reads as a complete update, and nothing in
 * it says that whether this shipped was never established. That is exactly the
 * gap a caveat block is for, and caveating the other four as well would put a
 * warning on almost every export and train the reader past this one.
 *
 * `bodyIsFromLatest` is part of "clean" rather than a detail. The safety fields
 * describe the latest READY generation, and the working body may have been
 * saved from an earlier one — in which case the honest thing to export is the
 * notes plus the fact that they describe a different version. Silently
 * attaching them to text they do not describe would be the under-warning this
 * whole block exists to prevent. The same sentence is on screen too: the export
 * is the LAST place that gap can be caught, never the only one.
 *
 * WHY THE COPY BUTTON DOES NOT GET THIS STRING, deliberately — the same
 * asymmetry `composeExportMarkdown` in `CaseStudyPanel.tsx` documents. A
 * download produces a FILE, which travels on its own: the caveats are the only
 * thing that goes with it once it is an attachment. A copy lands in a buffer
 * whose owner is looking at this page right now, with the safety blocks above
 * the button they just pressed, and is usually pasted straight into a mail
 * client. Injecting four lines the reader never saw into a message they are
 * about to send is its own surprise, and it makes the button's contract
 * ("copies exactly the text you are looking at") false.
 */
function composeExportMarkdown({
	body,
	doc,
	safetyDoc,
	bodyIsFromLatest,
}: {
	body: string;
	doc: StakeholderEmailDocument | null;
	/**
	 * Where the SAFETY NOTE comes from — the version the body was adopted from
	 * when that is known, the newest ready one otherwise. Separate from `doc`
	 * because the rest of this header is metadata about the candidate (which
	 * the caveat flags as another version's), while the note has to describe
	 * the text actually being exported.
	 */
	safetyDoc: StakeholderEmailDocument | null;
	bodyIsFromLatest: boolean;
}): string {
	if (!doc) {
		return body;
	}

	const isClean =
		doc.releaseStatus !== "UNCONFIRMED" &&
		doc.inputsNeeded.length === 0 &&
		bodyIsFromLatest &&
		// The note that would be EXPORTED, not the newest one: a body adopted
		// from a generalized version is not clean because the candidate above
		// it happens to be.
		!safetyDoc?.safetyNote;
	if (isClean) {
		return body;
	}

	const lines: string[] = [
		"# Draft caveats — not ready to send",
		"",
		"This stakeholder email was exported from Fabric as a draft. These notes are part of the draft; delete this section once they are settled.",
		"",
		`- Release status: ${RELEASE_STATUS_LABELS[doc.releaseStatus]}`,
		`- Audience: ${
			doc.audience
				? `written for ${doc.audience}.`
				: "the draft doesn't name one — check it suits whoever receives it."
		}`,
	];

	if (!bodyIsFromLatest) {
		lines.push(`- ${OTHER_VERSION_NOTE}`);
	}
	if (safetyDoc?.safetyNote) {
		lines.push(`- Safety note: ${safetyDoc.safetyNote}`);
	}
	if (doc.inputsNeeded.length > 0) {
		lines.push("", "## Still needed before sending", "");
		for (const item of doc.inputsNeeded) {
			lines.push(`- ${item}`);
		}
	}
	lines.push("", "---", "");

	return `${lines.join("\n")}\n${body}`;
}

export function StakeholderEmailPanel({
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
	 * yet; this steers a change to one that does ("make it shorter"). Sent as
	 * `guidance` on the wire — it IS the run's instruction, and putting it there
	 * is what records it on the attempt row.
	 */
	const [refineInstruction, setRefineInstruction] = useState("");
	/**
	 * The editor's text, or null for "showing what the server last returned".
	 *
	 * Null rather than a copy of the body, so a poll landing while the reader has
	 * NOT typed shows the newer text, and one landing while they HAVE typed does
	 * not silently discard what they wrote.
	 */
	const [editedBody, setEditedBody] = useState<string | null>(null);

	const attempt = draft?.latestAttempt ?? null;
	// `isExpired` splits GENERATING in two: a LIVE run is genuinely in flight, a
	// STRANDED one will never report back on its own. The button must stay
	// enabled for the second, because the ONLY code that reclaims a stranded row
	// runs inside the NEXT attempt.
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
		orpc.projects.publishingSuite.generateStakeholderEmail.mutationOptions({
			onSuccess: (result) => {
				// `started: false` is an ANSWER, not a failure — Temporal is
				// down, or a run this tab has not seen yet is already filling
				// the row. Reporting either as an error would send the reader
				// looking for a fault that is not theirs.
				if (!result.started) {
					toast.info(
						result.reason === "unavailable"
							? "Generation is unavailable right now. Try again in a few minutes."
							: "A stakeholder email is already being generated for this topic.",
					);
				}
				invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not start the stakeholder email.");
			},
		}),
	);

	const adopt = useMutation(
		orpc.projects.publishingSuite.adoptStakeholderEmailDraft.mutationOptions(
			{
				onSuccess: () => {
					// The adopted text replaces whatever the editor was showing,
					// so the local override has to go with it — otherwise the
					// reader adopts a version and goes on looking at the old one.
					setEditedBody(null);
					toast.success("Saved as the working stakeholder email.");
					invalidateDrafts();
				},
				onError: (error: unknown) => {
					const code = (error as { code?: string } | null)?.code;
					if (code === "CONFLICT") {
						toast.error(
							"The saved stakeholder email changed while you were reading. Refreshed — take another look.",
						);
						invalidateDrafts();
						return;
					}
					toast.error("Could not adopt that version.");
				},
			},
		),
	);

	const saveBody = useMutation(
		orpc.projects.publishingSuite.saveStakeholderEmailBody.mutationOptions({
			onSuccess: () => {
				setEditedBody(null);
				toast.success("Stakeholder email saved.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				// A CONFLICT means someone else changed the draft while this tab
				// was editing. The edit is NOT discarded — `editedBody` is left
				// standing so the reader can copy their text before refreshing.
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"Someone else changed this stakeholder email while you were editing. Your text is still here — copy it before refreshing.",
					);
					return;
				}
				toast.error("Could not save the stakeholder email.");
			},
		}),
	);

	const doc = readStakeholderEmailDocument(
		draft?.latestReady?.content ?? null,
	);
	const readyId = draft?.latestReady?.id ?? null;

	const bodyValue = editedBody ?? working?.body ?? "";
	const isDirty = editedBody !== null && editedBody !== (working?.body ?? "");

	/**
	 * Whether a generated version exists that the working draft did not come
	 * from — i.e. a regeneration the reader has not adopted.
	 *
	 * `readyId` non-null FIRST: a working draft whose source candidate was
	 * deleted carries a null `sourceDraftId` under the composite FK's
	 * `ON DELETE SET NULL`, and comparing `null !== null` would otherwise answer
	 * "no newer version" for a topic that has one.
	 */
	const hasUnadoptedVersion =
		readyId !== null && working?.sourceDraftId !== readyId;

	/**
	 * Whether the safety blocks on screen describe the text in the editor.
	 *
	 * `doc` is the LATEST READY generation; the editor, the copy button and the
	 * download all operate on the WORKING draft. Those are the same document
	 * most of the time and a different one after any regeneration the reader has
	 * not adopted — at which point the page prints v2's release status directly
	 * above v1's prose, with nothing saying so.
	 *
	 * That is reachable without any misuse, and it is worse here than on the
	 * case study because the release status can move in the SAFE-LOOKING
	 * direction: v1 is written while nothing in the sources says the work is
	 * live, so it reports UNCONFIRMED and hedges throughout; the release lands,
	 * a regeneration produces a v2 that honestly reports SHIPPED. `latestReady`
	 * is v2, the working body is still v1's, and the panel would read "the work
	 * is delivered and in use" over an email that carefully says nothing of the
	 * kind. The amber banner disappears at the same moment, so the one surface
	 * that would have flagged it is gone.
	 *
	 * Gated on there being a body to qualify. With no working draft the sentence
	 * would be false — there is no "version this text was saved from" — and the
	 * export cannot reach that state at all, since the download only renders
	 * beside an editor.
	 */
	const bodyIsFromLatest = !hasUnadoptedVersion;
	const notesDescribeAnotherVersion =
		!bodyIsFromLatest && working?.hasBody === true;

	/**
	 * The safety fields of the version the BODY came from.
	 *
	 * `doc` is the newest READY candidate — right for the comparison panes,
	 * wrong for anything describing the text in the editor. A qualifier covered
	 * half of it and could not reach the other half: when v1 was generalized
	 * and v2 needs none, `doc.safetyNote` is null, the section does not render
	 * at all, and the reader loses the explanation of the document they hold
	 * while the export carries it away silently.
	 */
	const adoptedDoc = readStakeholderEmailDocument(
		working?.sourceContent ?? null,
	);
	const safetyDoc =
		notesDescribeAnotherVersion && adoptedDoc ? adoptedDoc : doc;
	// The qualifier survives only for the case it can still describe: a source
	// row past retention, where the newest note is all there is. With the
	// adopted version in hand the note IS this text's, and saying otherwise
	// would be false.
	const noteDescribesAnotherVersion =
		notesDescribeAnotherVersion && adoptedDoc === null;

	const handleAdopt = (draftId: string | null = readyId) => {
		if (!draftId) {
			return;
		}
		// FR35 is satisfied structurally — generation can only CREATE a working
		// draft, never replace one — but adopting a later version over saved
		// text IS a replacement. Unsaved editor text is called out separately,
		// because that is the part no refresh brings back.
		const warning = isDirty
			? "This replaces the saved stakeholder email AND discards your unsaved edits. Continue?"
			: "This replaces the stakeholder email you saved earlier. Continue?";
		if (working?.hasBody && !window.confirm(warning)) {
			return;
		}
		adopt.mutate({
			projectId,
			topicId,
			organizationId,
			draftId,
			// Optimistic concurrency: when THIS tab last saw the working draft.
			// Keyed on `working` EXISTING, not on `hasBody` — a row with a blank
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
	 * ask whether the other exists. See `DraftComparison` for why they no
	 * longer sit at opposite ends of the panel.
	 */
	const candidate =
		hasUnadoptedVersion && doc ? (
			<CandidateDraft
				version={draft?.latestReady?.version ?? null}
				title={doc.subject}
				body={doc.body}
				replacesSavedDraft={Boolean(working?.hasBody)}
				action={
					canEdit ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => handleAdopt()}
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
				<h3 className="publishing-label" id="stakeholder-email-editor">
					Working stakeholder email
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
					Saved. This is the email the topic holds — editing here
					changes it, and it is what the copy and download controls
					below send.
				</SavedDraftCaption>
			) : null}
			{canEdit ? (
				<>
					<Textarea
						aria-labelledby="stakeholder-email-editor"
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
						{/* The bare body, deliberately — see
						    `composeExportMarkdown` for why the two
						    controls beside each other egress different
						    strings. */}
						<CopyDraftButton markdown={bodyValue} />
						<DraftDownloadDropdown
							markdown={composeExportMarkdown({
								body: bodyValue,
								doc,
								safetyDoc,
								bodyIsFromLatest,
							})}
							filename={doc?.subject ?? "stakeholder-email"}
						/>
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
						className="publishing-label block"
						htmlFor="stakeholder-email-guidance"
					>
						Guidance (optional)
					</label>
					<Textarea
						id="stakeholder-email-guidance"
						value={guidance}
						onChange={(e) => setGuidance(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={3}
						placeholder="Who it goes to, the tone, the ask, the points to lead with, anything to leave out."
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
							{doc
								? "Regenerate draft"
								: "Generate stakeholder email"}
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
							against. The stakeholder email you have saved is not
							affected until you adopt it.
						</p>
					) : null}
				</section>
			) : null}

			{/*
			 * A SECOND action, never a replacement for the one above.
			 * Regenerate rebuilds the stakeholder email from the planning analysis; this
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
						htmlFor="stakeholder-email-refine"
					>
						Refine the saved draft
					</label>
					<Textarea
						id="stakeholder-email-refine"
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
						Starts from the stakeholder email you have saved and
						changes only what you ask for. The result arrives as a
						new version to compare against; nothing you have saved
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

			{doc?.releaseStatus === "UNCONFIRMED" ? (
				// A banner in WORDS. The border tint is secondary — a reader who
				// cannot see it must still learn that the release state was never
				// established, which is the fact this format gets wrong most
				// expensively. The other four states get no banner: the email's
				// own prose carries them, and a warning on every draft is a
				// warning nobody reads.
				<section className="space-y-1 rounded-xl border border-highlight/40 bg-highlight/10 p-4">
					<h3 className="publishing-label">
						Release status not confirmed
					</h3>
					<p className="text-sm leading-relaxed">
						The source material didn't say whether this work has
						shipped, so the draft doesn't claim it either way.
						Confirm the release state and say so plainly before you
						send this — an update a stakeholder reads as a launch is
						the mistake this format makes most easily.
					</p>
					{notesDescribeAnotherVersion ? (
						<p className="text-sm leading-relaxed">
							{OTHER_VERSION_NOTE}
						</p>
					) : null}
				</section>
			) : null}

			{doc ? (
				<section className="space-y-2">
					<h3 className="publishing-label">What the draft claims</h3>
					{/* The qualifier sits ABOVE the values it qualifies, and is
					    the one surface that renders whatever the two versions
					    say — so the reader still learns the notes are about
					    other text in the case where the unconfirmed banner has
					    disappeared entirely. */}
					{notesDescribeAnotherVersion ? (
						<p className="text-muted-foreground text-sm leading-relaxed">
							{OTHER_VERSION_NOTE}
						</p>
					) : null}
					<dl className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm">
						<div className="space-y-0.5">
							<dt className="font-medium">Release status</dt>
							<dd className="text-muted-foreground leading-relaxed">
								{RELEASE_STATUS_LABELS[doc.releaseStatus]}
							</dd>
						</div>
						<div className="space-y-0.5">
							<dt className="font-medium">Audience</dt>
							<dd className="text-muted-foreground leading-relaxed">
								{doc.audience
									? `Written for ${doc.audience}.`
									: "The draft doesn't name an audience — check it suits whoever receives it."}
							</dd>
						</div>
					</dl>
					{/* Every line above is the DRAFT's account of the source
					    material. Unlike the case study's customer identity and
					    metrics basis, nothing here is checked server-side —
					    Fabric holds no record of what has shipped — and a reader
					    told otherwise stops checking, which is the one behaviour
					    this block must not cause. */}
					<p className="text-muted-foreground text-xs leading-relaxed">
						These are the draft's own reading of the source
						material. Nothing here was checked against a release
						record — you are the one who can confirm it.
					</p>
				</section>
			) : null}

			<DraftComparison saved={savedDraft} candidate={candidate} />

			{/* Every earlier run, and a way back into one. See `DraftVersions` —
			    the rows always persisted and the read path folded them to two, so
			    the version number counted runs rather than naming a place you could
			    go. */}
			<DraftVersions
				versions={draft?.versions ?? []}
				adoptedId={working?.sourceDraftId ?? null}
				isAdopting={adopt.isPending}
				onAdopt={canEdit ? (id) => handleAdopt(id) : undefined}
				renderBody={(id) => {
					const version = readStakeholderEmailDocument(
						draft?.versions?.find((v) => v.id === id)?.content ??
							null,
					);
					return version ? (
						<div className="space-y-2">
							<p className="font-medium text-foreground text-sm">
								{version.subject}
							</p>
							<p className="whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
								{version.body}
							</p>
						</div>
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
							heading="What the draft wrote around"
							note={safetyDoc.safetyNote}
							describesAnotherVersion={
								noteDescribesAnotherVersion
							}
						/>
					) : null}

					{doc.inputsNeeded.length > 0 ? (
						<section className="space-y-2">
							<h3 className="publishing-label">Inputs needed</h3>
							{notesDescribeAnotherVersion ? (
								<p className="text-muted-foreground text-sm leading-relaxed">
									{OTHER_VERSION_NOTE}
								</p>
							) : null}
							<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
								{doc.inputsNeeded.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</section>
					) : null}
				</>
			) : !isGenerating &&
				attempt?.status !== "FAILED" &&
				!working?.hasBody ? (
				<p className="text-muted-foreground text-sm">
					No stakeholder email draft yet.
				</p>
			) : null}
		</div>
	);
}
