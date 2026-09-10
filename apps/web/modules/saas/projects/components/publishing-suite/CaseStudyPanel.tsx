"use client";

import { CASE_STUDY_CLAMP_REASON } from "@repo/utils/publishing-case-study-clamp";
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
const BODY_MAX = 40000;

/**
 * The Case Study generation panel (Fizzy #1854, Phase 2C-1).
 *
 * Mirrors `BlogPostPanel` deliberately and closely — the same `editedBody`
 * sentinel, the same stranded/generating split, the same optimistic-concurrency
 * key, the same CONFLICT branch that keeps a reader's text — because the two
 * products have the same shape: one generation seeds one editable draft, and a
 * later version is offered rather than applied.
 *
 * What it adds is everything that makes a case study the most approval-sensitive
 * type in the suite. The generated document carries safety fields OUTSIDE the
 * editable body — is this a scaffold, may the customer be named, are the results
 * confirmed, which assets are cleared, what is still missing — and every one of
 * them has a reader here:
 *
 *  - The `generation.clamped` record is the one that would otherwise be
 *    write-only telemetry. The activity lowers an `APPROVED` customer identity
 *    or a `CONFIRMED` metrics basis when the topic still has the matching open
 *    approval, moves a claimed-confirmed asset an open thread names out of the
 *    cleared list, logs all of it, and stores it. Nobody would ever see that a
 *    claim was lowered — or that the locked clause worked — unless this panel
 *    said so. The reasons are compared against the SHARED
 *    `CASE_STUDY_CLAMP_REASON` vocabulary rather than literals repeated here,
 *    because an unrecognised reason reads as "not clamped".
 *  - The export carries the same fields, because a download is exactly where
 *    the on-screen safeguards stop applying: the moment the draft becomes an
 *    email attachment. See `composeExportMarkdown`, which also documents why
 *    the copy button next to it does NOT get the caveat block.
 *
 * All of those describe the LATEST READY generation, and the editor holds the
 * WORKING draft — the same document until a regeneration nobody adopted, and a
 * different one after. `notesDescribeAnotherVersion` says which, and every
 * safety surface is qualified by it rather than only the export.
 */

type CustomerIdentity = "APPROVED" | "ANONYMIZED" | "APPROVAL_NEEDED";
type MetricsBasis = "CONFIRMED" | "QUALITATIVE" | "PLACEHOLDER";

const CUSTOMER_IDENTITIES: readonly CustomerIdentity[] = [
	"APPROVED",
	"ANONYMIZED",
	"APPROVAL_NEEDED",
];
const METRICS_BASES: readonly MetricsBasis[] = [
	"CONFIRMED",
	"QUALITATIVE",
	"PLACEHOLDER",
];

/**
 * One phrasing per value, used by BOTH the panel and the export.
 *
 * One map rather than two sets of words: the caveat block exists so a reader of
 * the PDF learns what a reader of the page learns, and two spellings of the same
 * status are two statuses as soon as one of them is edited.
 */
const CUSTOMER_IDENTITY_LABELS: Record<CustomerIdentity, string> = {
	APPROVED: "Named with approval.",
	ANONYMIZED: "Anonymized — the draft does not name the customer.",
	APPROVAL_NEEDED: "Approval needed before the customer can be named.",
};

const METRICS_BASIS_LABELS: Record<MetricsBasis, string> = {
	CONFIRMED: "Confirmed figures.",
	QUALITATIVE: "Described qualitatively — the draft claims no figures.",
	PLACEHOLDER: "Placeholder figures — not measured results.",
};

/** Said of a field the activity lowered, never of one the model chose. */
const CLAMP_NOTE =
	"Set by Fabric from an open approval thread, not claimed by the draft.";

/**
 * Said of assets the activity moved OUT of `confirmedAssets`.
 *
 * Separate wording from `CLAMP_NOTE` because it reports a different action: the
 * two enum fields were LOWERED in place, where an asset was MOVED between two
 * lists a reader can see. "Set by Fabric" would leave them looking for a field
 * that changed.
 */
const ASSET_CLAMP_NOTE =
	"Moved out of the cleared list by Fabric, from an open approval thread naming them:";

interface CaseStudyDocument {
	title: string;
	body: string;
	customerIdentity: CustomerIdentity;
	metricsBasis: MetricsBasis;
	isScaffold: boolean;
	confirmedAssets: string[];
	assetsNeedingConfirmation: string[];
	categories: string[];
	keywords: string[];
	inputsNeeded: string[];
	safetyNote: string | null;
	/**
	 * Which fields the activity lowered against an open approval thread.
	 *
	 * The two enums are booleans — the value they were lowered TO is already in
	 * `customerIdentity` / `metricsBasis`, so all this record adds is who set it.
	 * `assets` carries LABELS instead, because the moved entries are otherwise
	 * indistinguishable from the ones the model itself put in the
	 * needs-confirmation list, and "the draft was unsure" and "Fabric overruled
	 * the draft" are different facts about the same line.
	 */
	clamped: {
		customerIdentity: boolean;
		metricsBasis: boolean;
		assets: string[];
	};
}

/**
 * Read a case study out of a draft's stored `content`.
 *
 * Defensive rather than trusting, for the reason its Blog Post sibling
 * documents: `content` is `Json?`, so a row written by an older shape must
 * degrade to "nothing to show" instead of throwing inside a render.
 *
 * The two enums fall back to their MOST CAUTIOUS value rather than to their
 * first one. A garbled or absent `customerIdentity` reading as `APPROVED` would
 * turn a storage defect into a claim that a customer approved being named —
 * the one direction in which being wrong is expensive.
 */
function readCaseStudyDocument(content: unknown): CaseStudyDocument | null {
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

	const generation =
		raw.generation && typeof raw.generation === "object"
			? (raw.generation as Record<string, unknown>)
			: {};
	const clampedRaw =
		generation.clamped && typeof generation.clamped === "object"
			? (generation.clamped as Record<string, unknown>)
			: {};

	return {
		title: raw.title.trim(),
		body: raw.body.trim(),
		customerIdentity: CUSTOMER_IDENTITIES.includes(
			raw.customerIdentity as CustomerIdentity,
		)
			? (raw.customerIdentity as CustomerIdentity)
			: "APPROVAL_NEEDED",
		metricsBasis: METRICS_BASES.includes(raw.metricsBasis as MetricsBasis)
			? (raw.metricsBasis as MetricsBasis)
			: "PLACEHOLDER",
		isScaffold: raw.isScaffold === true,
		confirmedAssets: strings(raw.confirmedAssets),
		assetsNeedingConfirmation: strings(raw.assetsNeedingConfirmation),
		categories: strings(raw.categories),
		keywords: strings(raw.keywords),
		inputsNeeded: strings(raw.inputsNeeded),
		safetyNote:
			typeof raw.safetyNote === "string" && raw.safetyNote.trim()
				? raw.safetyNote.trim()
				: null,
		// Compared against the SHARED vocabulary, not against a literal spelled
		// again here. The writer of these values is a Temporal activity in
		// another package; an unrecognised reason reads as "not clamped", so a
		// rename against two hardcoded strings would make the warning VANISH
		// while the clamped label stayed — silent under-warning on the surface
		// whose whole purpose is to warn. See `publishing-case-study-clamp`.
		clamped: {
			customerIdentity:
				clampedRaw.customerIdentity ===
				CASE_STUDY_CLAMP_REASON.customerIdentity,
			metricsBasis:
				clampedRaw.metricsBasis ===
				CASE_STUDY_CLAMP_REASON.metricsBasis,
			assets: strings(clampedRaw.assets),
		},
	};
}

/**
 * The Markdown that leaves the app, caveats and all.
 *
 * The problem this solves: every safety field lives OUTSIDE the editable body.
 * On screen that is right — they are advice about the draft, and an author who
 * had to delete four sections after every regeneration would stop regenerating.
 * In an exported file it is a hole. A naive export hands someone a clean PDF of
 * a draft that is a scaffold, whose customer identity is still awaiting
 * approval, and that is missing three proof points, with none of that visible —
 * and a downloaded case study is the artefact most likely to be forwarded
 * outside the org, where nobody can see this page at all.
 *
 * So a draft that is not clean is prefixed with a block naming all of it. A
 * clean one is exported unchanged: a caveat that fires on every draft is a
 * caveat nobody reads.
 *
 * `bodyIsFromLatest` is part of "clean" rather than a detail. The safety fields
 * describe the latest READY generation, and the working body may have been
 * saved from an earlier one — in which case the honest thing to export is the
 * notes plus the fact that they describe a different version. Silently
 * attaching them to text they do not describe would be the under-warning this
 * whole block exists to prevent. The same sentence is now on screen too, beside
 * each of the three safety surfaces: the export is the LAST place that gap can
 * be caught, never the only one.
 *
 * WHY THE COPY BUTTON DOES NOT GET THIS STRING, deliberately. The two controls
 * sit next to each other and egress the same text, so the asymmetry has to be a
 * decision rather than an oversight. A download produces a FILE, which travels
 * on its own: the caveats are the only thing that goes with it once it is an
 * attachment, and nobody downstream can see this page. A copy lands in a buffer
 * whose owner is looking at this page right now — the safety blocks are on
 * screen above the button they just pressed — and it is usually pasted straight
 * back into an editor mid-sentence. Injecting four lines the reader never saw
 * into a clipboard is its own surprise, and it makes the button's contract
 * ("copies exactly the text you are looking at") false. Pinned from both
 * directions in `publishing-case-study-panel.test.tsx`: the copy suite asserts
 * the bare body, the download suite asserts the caveats.
 */
function composeExportMarkdown({
	body,
	doc,
	safetyDoc,
	bodyIsFromLatest,
}: {
	body: string;
	doc: CaseStudyDocument | null;
	/**
	 * Where the SAFETY NOTE comes from — the version the body was adopted from
	 * when that is known, and the newest ready one otherwise.
	 *
	 * Separate from `doc` because the two describe different things. The rest
	 * of this header is metadata about the candidate, which the caveat below
	 * already flags as belonging to another version; the safety note describes
	 * the TEXT being exported, and getting that wrong means shipping a document
	 * whose stated generalizations belong to a draft nobody adopted.
	 */
	safetyDoc: CaseStudyDocument | null;
	bodyIsFromLatest: boolean;
}): string {
	if (!doc) {
		return body;
	}

	// The asset CLAMP is its own term, not a consequence of the one above it.
	// Today the activity moves a disputed asset into `assetsNeedingConfirmation`
	// as it records the clamp, so the two are non-empty together — but that
	// coupling lives in another package, and a document that carries the clamp
	// record with an empty needs-confirmation list (an older write, a partial
	// one) would otherwise export as CLEAN with a disputed asset still sitting
	// in the cleared list. Cheap to state, and it fails toward warning.
	const isClean =
		!doc.isScaffold &&
		doc.customerIdentity === "APPROVED" &&
		doc.metricsBasis === "CONFIRMED" &&
		doc.inputsNeeded.length === 0 &&
		doc.assetsNeedingConfirmation.length === 0 &&
		doc.clamped.assets.length === 0 &&
		bodyIsFromLatest &&
		// The note that would be EXPORTED, not the newest one — a body adopted
		// from a generalized version is not clean just because the candidate
		// above it happens to be.
		!safetyDoc?.safetyNote;
	if (isClean) {
		return body;
	}

	const lines: string[] = [
		"# Draft caveats — not cleared for publication",
		"",
		"This case study was exported from Fabric with approvals still outstanding. These notes are part of the draft; delete this section once they are settled.",
		"",
		`- Draft status: ${
			doc.isScaffold
				? "scaffold — an outline with placeholders, not a finished case study"
				: "full draft"
		}.`,
		`- Customer identity: ${CUSTOMER_IDENTITY_LABELS[doc.customerIdentity]}${
			doc.clamped.customerIdentity ? ` ${CLAMP_NOTE}` : ""
		}`,
		`- Results basis: ${METRICS_BASIS_LABELS[doc.metricsBasis]}${
			doc.clamped.metricsBasis ? ` ${CLAMP_NOTE}` : ""
		}`,
	];

	// Still driven by the version relationship: the metadata ABOVE this line —
	// approval status, results basis, scaffold state — is the candidate's and
	// genuinely describes another version, even once the safety note below has
	// been corrected to the adopted one.
	if (!bodyIsFromLatest) {
		lines.push(`- ${OTHER_VERSION_NOTE}`);
	}
	if (safetyDoc?.safetyNote) {
		lines.push(`- Safety note: ${safetyDoc.safetyNote}`);
	}
	if (doc.assetsNeedingConfirmation.length > 0) {
		lines.push(
			`- Assets awaiting confirmation: ${doc.assetsNeedingConfirmation.join(", ")}.`,
		);
	}
	if (doc.clamped.assets.length > 0) {
		lines.push(`- ${ASSET_CLAMP_NOTE} ${doc.clamped.assets.join(", ")}.`);
	}
	if (doc.inputsNeeded.length > 0) {
		lines.push("", "## Still needed before publishing", "");
		for (const item of doc.inputsNeeded) {
			lines.push(`- ${item}`);
		}
	}
	lines.push("", "---", "");

	return `${lines.join("\n")}\n${body}`;
}

export function CaseStudyPanel({
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
		orpc.projects.publishingSuite.generateCaseStudy.mutationOptions({
			onSuccess: (result) => {
				// `started: false` is an ANSWER, not a failure — Temporal is
				// down, or a run this tab has not seen yet is already filling
				// the row. Reporting either as an error would send the reader
				// looking for a fault that is not theirs.
				if (!result.started) {
					toast.info(
						result.reason === "unavailable"
							? "Generation is unavailable right now. Try again in a few minutes."
							: "A case study is already being generated for this topic.",
					);
				}
				invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not start the case study.");
			},
		}),
	);

	const adopt = useMutation(
		orpc.projects.publishingSuite.adoptCaseStudyDraft.mutationOptions({
			onSuccess: () => {
				// The adopted text replaces whatever the editor was showing, so
				// the local override has to go with it — otherwise the reader
				// adopts a version and goes on looking at the old one.
				setEditedBody(null);
				toast.success("Saved as the working case study.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"The saved case study changed while you were reading. Refreshed — take another look.",
					);
					invalidateDrafts();
					return;
				}
				toast.error("Could not adopt that version.");
			},
		}),
	);

	const saveBody = useMutation(
		orpc.projects.publishingSuite.saveCaseStudyBody.mutationOptions({
			onSuccess: () => {
				setEditedBody(null);
				toast.success("Case study saved.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				// A CONFLICT means someone else changed the draft while this tab
				// was editing. The edit is NOT discarded — `editedBody` is left
				// standing so the reader can copy their text before refreshing.
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"Someone else changed this case study while you were editing. Your text is still here — copy it before refreshing.",
					);
					return;
				}
				toast.error("Could not save the case study.");
			},
		}),
	);

	const doc = readCaseStudyDocument(draft?.latestReady?.content ?? null);
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
	 * not adopted — at which point the page prints v2's approval status directly
	 * above v1's prose, with nothing saying so.
	 *
	 * That is reachable without any misuse: an open customer-name question
	 * clamps v1 to APPROVAL_NEEDED while v1's body still names the customer (the
	 * clamp changes the label, not the prose); the question is then answered
	 * "we are not naming them" and closed; a regeneration produces an unclamped
	 * v2 that honestly reports APPROVED. `latestReady` is v2, the working body
	 * is still v1's, and the panel would read "Named with approval" over text
	 * written under an open question. The scaffold case is worse, because the
	 * amber banner DISAPPEARS: v2 is a full draft, so the warning vanishes while
	 * the text about to be shared is still the scaffold.
	 *
	 * Gated on there being a body to qualify. With no working draft the sentence
	 * would be false — there is no "version this text was saved from" — and the
	 * export cannot reach that state at all, since the download only renders
	 * beside an editor.
	 */
	const bodyIsFromLatest = !hasUnadoptedVersion;
	const bodyIsFromAnotherVersion =
		!bodyIsFromLatest && working?.hasBody === true;

	/**
	 * The safety fields of the version the BODY came from.
	 *
	 * `doc` is the newest READY candidate, which is the right source for the
	 * comparison panes and the wrong one for anything describing the text in
	 * the editor. Adding a qualifier — "these notes describe another version" —
	 * covered half of it, and could not reach the other half at all: when v1
	 * was generalized and v2 needs none, `doc.safetyNote` is null, the section
	 * does not render, and there is nothing on screen to qualify. The reader
	 * loses the explanation of the document they are actually holding, and the
	 * export carries it away silently.
	 *
	 * So the note is read off the adopted version when there is one, and the
	 * qualifier survives only for the case it can still describe — a source row
	 * gone past retention, where the newest note is all there is.
	 */
	const adoptedDoc = readCaseStudyDocument(working?.sourceContent ?? null);
	const safetyDoc = bodyIsFromAnotherVersion && adoptedDoc ? adoptedDoc : doc;
	const notesDescribeAnotherVersion =
		bodyIsFromAnotherVersion && adoptedDoc === null;

	const handleAdopt = (draftId: string | null = readyId) => {
		if (!draftId) {
			return;
		}
		// FR35 is satisfied structurally — generation can only CREATE a working
		// draft, never replace one — but adopting a later version over saved
		// text IS a replacement. Unsaved editor text is called out separately,
		// because that is the part no refresh brings back.
		const warning = isDirty
			? "This replaces the saved case study AND discards your unsaved edits. Continue?"
			: "This replaces the case study you saved earlier. Continue?";
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
				title={doc.title}
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
				<h3 className="publishing-label" id="case-study-editor">
					Working case study
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
					Saved. This is the case study the topic holds — editing here
					changes it, and it is what the copy and download controls
					below send.
				</SavedDraftCaption>
			) : null}
			{canEdit ? (
				<>
					<Textarea
						aria-labelledby="case-study-editor"
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
							filename={doc?.title ?? "case-study"}
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
						htmlFor="case-study-guidance"
					>
						Guidance (optional)
					</label>
					<Textarea
						id="case-study-guidance"
						value={guidance}
						onChange={(e) => setGuidance(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={3}
						placeholder="Audience, the outcome to lead with, which results may be named, sections to include or leave out."
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
							{doc ? "Regenerate draft" : "Generate case study"}
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
							against. The case study you have saved is not
							affected until you adopt it.
						</p>
					) : null}
				</section>
			) : null}

			{/*
			 * A SECOND action, never a replacement for the one above.
			 * Regenerate rebuilds the case study from the planning analysis; this
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
						htmlFor="case-study-refine"
					>
						Refine the saved draft
					</label>
					<Textarea
						id="case-study-refine"
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
						Starts from the case study you have saved and changes
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

			{doc?.isScaffold ? (
				// A banner in WORDS. The border tint is secondary — a reader who
				// cannot see it must still learn that this is an outline, which
				// is the single most consequential thing about the draft.
				<section className="space-y-1 rounded-xl border border-highlight/40 bg-highlight/10 p-4">
					<h3 className="publishing-label">Scaffold draft</h3>
					<p className="text-sm leading-relaxed">
						There wasn't enough confirmed material to write a full
						case study, so this is an outline with placeholders
						rather than a finished draft. Fill the gaps under
						"Inputs needed" before sharing it.
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
					<h3 className="publishing-label">Approval status</h3>
					{/* The qualifier sits ABOVE the values it qualifies, and is
					    the one surface that renders whatever the two versions
					    say — so the reader still learns the notes are about
					    other text in the case where the scaffold banner has
					    disappeared entirely. */}
					{notesDescribeAnotherVersion ? (
						<p className="text-muted-foreground text-sm leading-relaxed">
							{OTHER_VERSION_NOTE}
						</p>
					) : null}
					<dl className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm">
						<div className="space-y-0.5">
							<dt className="font-medium">Customer identity</dt>
							<dd className="text-muted-foreground leading-relaxed">
								{CUSTOMER_IDENTITY_LABELS[doc.customerIdentity]}
								{doc.clamped.customerIdentity
									? ` ${CLAMP_NOTE}`
									: null}
							</dd>
						</div>
						<div className="space-y-0.5">
							<dt className="font-medium">Results basis</dt>
							<dd className="text-muted-foreground leading-relaxed">
								{METRICS_BASIS_LABELS[doc.metricsBasis]}
								{doc.clamped.metricsBasis
									? ` ${CLAMP_NOTE}`
									: null}
							</dd>
						</div>
					</dl>
				</section>
			) : null}

			{doc &&
			(doc.confirmedAssets.length > 0 ||
				doc.assetsNeedingConfirmation.length > 0 ||
				doc.clamped.assets.length > 0) ? (
				<div className="grid gap-4 sm:grid-cols-2">
					{doc.confirmedAssets.length > 0 ? (
						<section className="space-y-2 rounded-xl border border-border bg-muted/40 p-4">
							<h3 className="publishing-label">
								Assets cleared for use
							</h3>
							{/* NOT "approved, and safe to publish". Every other
							    field in this panel is labelled as whose claim it
							    is, and this one is the model's: it reports what
							    the source material led it to believe, and no
							    approval record was consulted to produce it. The
							    two enum fields above are at least clamped
							    against open threads; a reader told "safe to
							    publish" stops checking, which is the one
							    behaviour this list must not cause. */}
							<p className="text-muted-foreground text-xs leading-relaxed">
								The draft lists these as cleared for use. That
								is its own account of the source material, not
								an approval record — check anything you have not
								confirmed yourself.
							</p>
							<ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
								{doc.confirmedAssets.map((asset) => (
									<li key={asset}>{asset}</li>
								))}
							</ul>
						</section>
					) : null}
					{doc.assetsNeedingConfirmation.length > 0 ||
					doc.clamped.assets.length > 0 ? (
						<section className="space-y-2 rounded-xl border border-highlight/40 bg-highlight/10 p-4">
							<h3 className="publishing-label">
								Assets awaiting confirmation
							</h3>
							<p className="text-xs leading-relaxed">
								Referenced by the draft but NOT approved.
								Confirm each one before publishing.
							</p>
							{/* Named separately from the list they are now in.
							    An entry the model itself was unsure about and
							    one Fabric took off the cleared list are the same
							    line otherwise, and only the second says the
							    draft claimed something an open thread contradicts. */}
							{doc.clamped.assets.length > 0 ? (
								<p className="text-xs leading-relaxed">
									{ASSET_CLAMP_NOTE}{" "}
									{doc.clamped.assets.join(", ")}.
								</p>
							) : null}
							<ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
								{doc.assetsNeedingConfirmation.map((asset) => (
									<li key={asset}>{asset}</li>
								))}
							</ul>
						</section>
					) : null}
				</div>
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
					const version = readCaseStudyDocument(
						draft?.versions?.find((v) => v.id === id)?.content ??
							null,
					);
					return version ? (
						<div className="space-y-2">
							<p className="font-medium text-foreground text-sm">
								{version.title}
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
							heading="How this was generalized"
							note={safetyDoc.safetyNote}
							describesAnotherVersion={
								notesDescribeAnotherVersion
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

					{doc.categories.length > 0 ? (
						<section className="space-y-2">
							<h3 className="publishing-label">
								Suggested categories
							</h3>
							<p className="text-muted-foreground text-sm">
								{doc.categories.join(", ")}
							</p>
						</section>
					) : null}

					{doc.keywords.length > 0 ? (
						<section className="space-y-2">
							<h3 className="publishing-label">
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
					No case study draft yet.
				</p>
			) : null}
		</div>
	);
}
