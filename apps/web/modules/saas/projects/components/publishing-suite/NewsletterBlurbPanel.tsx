"use client";

import {
	AUDIENCE_LABELS,
	CTA_STATE_LABELS,
	composeNewsletterBlurbWorkingDraftBody,
	NEWSLETTER_BLURB_BODY_MAX,
	type NewsletterBlurbDocument,
	RELEASE_STATUS_LABELS,
} from "@repo/utils/publishing-newsletter-blurb-body";
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
import { GeneralizationNotes, OTHER_VERSION_NOTE } from "./GeneralizationNotes";
import type { TopicDraftState, TopicWorkingDraftState } from "./GenerationTabs";

/** Mirrors the API's own bound on the guidance box, so a field cannot submit what it would reject. */
const GUIDANCE_MAX = 2000;

/**
 * The editor's bound, IMPORTED rather than restated.
 *
 * Its three siblings each hardcode a number beside the same comment; this one
 * reads the constant `saveNewsletterBlurbBody` is itself bounded by
 * (`procedures/publishing-suite/newsletter-blurb.ts`), because the two numbers
 * that matter here are 24,000 and 40,000 and they belong to different content
 * types. A hardcoded 40,000 copied in from `WebinarScriptPanel` would let a
 * reader type 16,000 characters the server then refuses, after the point where
 * they can still see all of what they wrote.
 */
const BODY_MAX = NEWSLETTER_BLURB_BODY_MAX;

/**
 * The Newsletter Blurb generation panel (Fizzy #1988, Phase 2D-2).
 *
 * Mirrors `WebinarScriptPanel`, and `StakeholderEmailPanel` and `CaseStudyPanel`
 * before it, deliberately and closely — the same `editedBody` sentinel, the same
 * stranded/generating split, the same optimistic-concurrency key, the same
 * CONFLICT branch that keeps a reader's text, the same candidate/saved
 * comparison, the same `safetyDoc` split that reads the safety note off the
 * version the body was adopted from — because all four products share one
 * shape: one generation seeds one editable draft, and a later version is
 * offered rather than applied.
 *
 * WHAT IS DIFFERENT, and each difference has a reason:
 *
 *  - **Three enum fields render, not one.** `releaseStatus`, `audience` and
 *    `ctaState` are all advice ABOUT the draft rather than part of it —
 *    `composeNewsletterBlurbWorkingDraftBody` composes only `headline`, `blurb`
 *    and, when `ctaState` is `PRESENT`, `suggestedCta` — so all three render
 *    outside the editor, as WORDS in a description list. Never as a tint: a
 *    reader who cannot distinguish two colours must still learn who the blurb
 *    was framed for and whether its release claim was ever confirmed.
 *  - **`releaseStatus` has SEVEN values**, and its map is imported from
 *    `@repo/utils/publishing-newsletter-blurb-body` rather than redeclared.
 *    The Webinar Script module exports a map of the same bare name with six
 *    values — no `PILOT`, no `UPCOMING`, and a `CONCEPT` this type does not
 *    have — which an editor auto-import will happily offer. Indexing that one
 *    with a Newsletter status is a `tsc` error; the fix for that error is this
 *    import, never a cast. Sharing the map with the export composer is also
 *    what spec §9.1 requires: a value that renders one way on screen and
 *    another in a downloaded file is a document that disagrees with the product
 *    it came from.
 *  - **There is no `isScaffold`.** Spec §5.2 declares none and §5.5 says so
 *    explicitly: there is no field here whose emptiness means the draft is a
 *    skeleton. A blurb is one paragraph and either exists or does not, and the
 *    gap this type actually reports is a missing call to action, which
 *    `ctaState` names precisely. Do not port the Webinar panel's scaffold
 *    banner across.
 *  - **`promptSource` gets a notice** (spec §9.3), as it does on the Webinar
 *    panel. It is the only per-draft signal that the organization's own
 *    editable prompt was NOT used, and this is the content type whose output is
 *    shortest and therefore likeliest to look already checked.
 *
 * The download is a locally-owned composer, `composeExportMarkdown`, and NOT
 * `composeNewsletterBlurbExport(doc, clamped)` from `@repo/utils` — mirroring
 * the Webinar Script panel, whose own docblock records why. That shared
 * composer rebuilds the whole file from the structured document and has no
 * parameter for a reader's free-text edits, so calling it here would silently
 * swap the download for a different generation than the one the editor and the
 * copy button show. `composeExportMarkdown` instead prefixes a caveat block
 * onto the reader's own `bodyValue`. `composeNewsletterBlurbExport` still
 * exists and is pinned by its own suite; it has no production caller, the same
 * state its Webinar sibling is in.
 */

type ReleaseStatus = NewsletterBlurbDocument["releaseStatus"];
const RELEASE_STATUSES: readonly ReleaseStatus[] = [
	"SHIPPED",
	"IN_PROGRESS",
	"PLANNED",
	"PREVIEW",
	"PILOT",
	"UPCOMING",
	"UNCONFIRMED",
];

type Audience = NewsletterBlurbDocument["audience"];
const AUDIENCES: readonly Audience[] = [
	"INTERNAL",
	"CUSTOMER",
	"PARTNER",
	"COMMUNITY",
	"EXTERNAL",
	"UNSPECIFIED",
];

type CtaState = NewsletterBlurbDocument["ctaState"];

type PromptSourceValue = "BOUND" | "DEFAULT_UNBOUND" | "DEFAULT_RENDER_FAILED";
const PROMPT_SOURCES: readonly PromptSourceValue[] = [
	"BOUND",
	"DEFAULT_UNBOUND",
	"DEFAULT_RENDER_FAILED",
];

/**
 * Said when the draft was NOT written from the organization's own bound prompt.
 * `BOUND` gets no entry: the notice renders only for the other two, and the
 * document's own `!== "BOUND"` check is what decides that, not a `default` case
 * here — a third non-bound value added later without a matching entry is a
 * compile error, not a silent blank.
 */
const PROMPT_SOURCE_NOTICE: Record<
	Exclude<PromptSourceValue, "BOUND">,
	string
> = {
	DEFAULT_UNBOUND:
		"No organization prompt is bound for the newsletter blurb — this draft was written from Fabric's own default.",
	DEFAULT_RENDER_FAILED:
		"The organization's bound prompt could not be rendered — this draft was written from Fabric's own default instead.",
};

/**
 * One phrase per {@link ASSET_RESTRICTING_KINDS} member
 * (`@repo/utils/publishing-asset-clamp`), for the attribution line the
 * generation activity's own comment promises: "we moved this asset, and here is
 * the approval that did it." A label alone would say WHAT moved without saying
 * WHY; this map is the WHY.
 */
const ASSET_CLAMP_KIND_LABELS: Record<string, string> = {
	ASSET_APPROVAL: "an open asset-approval thread",
	INTERNAL_UI: "an open internal-UI review thread",
	VIDEO_WALKTHROUGH: "an open video-walkthrough review thread",
};
const ASSET_CLAMP_KIND_FALLBACK = "an open approval thread";

/**
 * Said of an asset the activity moved OUT of `confirmed`, never of one the model
 * itself put into `needsConfirmation` on its own — "the draft was unsure" and
 * "Fabric overruled the draft" are different facts about the same line, and a
 * reader who cannot tell them apart cannot tell a clamp from ordinary caution.
 *
 * Deliberately NOT the `ASSET_CLAMP_NOTE` in
 * `@repo/utils/publishing-newsletter-blurb-body`, which joins every moved label
 * into one sentence with no reason given. This panel and its download name the
 * KIND per asset, and they use the same map so the file and the page say the
 * same thing.
 */
const ASSET_CLAMP_NOTE = "Moved out of the confirmed list by Fabric, from";

interface NewsletterBlurbClamp {
	assets: string[];
	assetKinds: Record<string, string>;
}

/**
 * The parsed document plus the two generation-block signals this panel reads
 * alongside it. `NewsletterBlurbDocument & {…}` rather than a nested shape, so
 * this value can be passed directly to
 * `composeNewsletterBlurbWorkingDraftBody` — which takes exactly that type —
 * without an unwrap at every call site.
 */
type NewsletterBlurbPanelDocument = NewsletterBlurbDocument & {
	promptSource: PromptSourceValue;
	clamped: NewsletterBlurbClamp;
};

/**
 * Read a newsletter blurb out of a draft's stored `content`.
 *
 * Defensive rather than trusting, and panel-local rather than shared, for the
 * reason all three siblings document: `content` is `Json?`, so a row written by
 * an older shape — or a wholly different content type's shape — must degrade to
 * "nothing to show" instead of throwing inside a render. **A panel that throws
 * takes the whole Topic Item Page with it.**
 *
 * Checks the TWO fields the schema requires non-empty (`headline`, `blurb`) and
 * returns null if either is missing — never re-validates the whole document
 * against `PublishingNewsletterBlurbSchema`. That full schema bounds
 * `suggestedAssets` at 8 entries each, and the asset clamp's
 * `needsConfirmation` append has no cap of its own, so a stored document can
 * legitimately hold more entries than the schema would accept today.
 *
 * Each enum falls back to the value that makes the WEAKEST claim rather than to
 * the first member: `UNCONFIRMED` for a release status, so a storage defect
 * cannot read as "this is live"; `UNSPECIFIED` for an audience, so it cannot
 * read as "this was written for customers"; and `DEFAULT_UNBOUND` for
 * `promptSource`, INCLUDING an absent `generation` block entirely, because the
 * notice it drives exists to warn a reader that the organization's own prompt
 * was not used and treating "cannot tell" as "it was bound" is the
 * under-warning direction.
 *
 * `ctaState` is RECONCILED against the call to action actually present, the same
 * way the schema's own transform derives it — matching, rather than trusting,
 * the stored value. `PRESENT` with nothing to present is a claim with no
 * payload, and this reader also sees rows written before the transform existed;
 * rendering "the draft carries a call to action" over a document that carries
 * none is the one direction in which being wrong costs a reader a send. Tested
 * on the TRIMMED string, since a whitespace-only CTA is not one.
 */
function readNewsletterBlurbDocument(
	content: unknown,
): NewsletterBlurbPanelDocument | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const raw = content as Record<string, unknown>;

	const requiredString = (value: unknown): string | null =>
		typeof value === "string" && value.trim() ? value.trim() : null;
	// Trimmed and emptied out, not merely type-checked — see the siblings'
	// identical comment: a whitespace-only entry survives
	// `typeof v === "string"` and then renders as a bullet with nothing in it.
	const strings = (value: unknown): string[] =>
		Array.isArray(value)
			? value
					.filter((v): v is string => typeof v === "string")
					.map((v) => v.trim())
					.filter((v) => v.length > 0)
			: [];

	const headline = requiredString(raw.headline);
	const blurb = requiredString(raw.blurb);
	if (!headline || !blurb) {
		return null;
	}

	const suggestedCta = requiredString(raw.suggestedCta);
	const storedCtaState = (
		["PRESENT", "UNKNOWN", "OMITTED"] as CtaState[]
	).includes(raw.ctaState as CtaState)
		? (raw.ctaState as CtaState)
		: "UNKNOWN";
	const ctaState: CtaState = suggestedCta
		? "PRESENT"
		: storedCtaState === "OMITTED"
			? "OMITTED"
			: "UNKNOWN";

	const audience = AUDIENCES.includes(raw.audience as Audience)
		? (raw.audience as Audience)
		: "UNSPECIFIED";
	const releaseStatus = RELEASE_STATUSES.includes(
		raw.releaseStatus as ReleaseStatus,
	)
		? (raw.releaseStatus as ReleaseStatus)
		: "UNCONFIRMED";

	const assetsRaw =
		raw.suggestedAssets && typeof raw.suggestedAssets === "object"
			? (raw.suggestedAssets as Record<string, unknown>)
			: {};

	const generation =
		raw.generation && typeof raw.generation === "object"
			? (raw.generation as Record<string, unknown>)
			: {};
	const promptSource = PROMPT_SOURCES.includes(
		generation.promptSource as PromptSourceValue,
	)
		? (generation.promptSource as PromptSourceValue)
		: "DEFAULT_UNBOUND";

	const clampedRaw =
		generation.clamped && typeof generation.clamped === "object"
			? (generation.clamped as Record<string, unknown>)
			: {};
	// Deduped: `clamped.assets` is persisted PRE-dedupe
	// (`generate-newsletter-blurb.ts`'s `assetClamp.moved.map(…)`), so a
	// document whose `confirmed` list held the same label twice would otherwise
	// carry that label twice here too — and the render below keys each entry by
	// its label, so a duplicate is a silent React key collision.
	const clampedAssets = Array.from(new Set(strings(clampedRaw.assets)));
	const assetKindsRaw =
		clampedRaw.assetKinds && typeof clampedRaw.assetKinds === "object"
			? (clampedRaw.assetKinds as Record<string, unknown>)
			: {};
	const assetKinds: Record<string, string> = {};
	for (const asset of clampedAssets) {
		const kind = assetKindsRaw[asset];
		if (typeof kind === "string" && kind.trim()) {
			assetKinds[asset] = kind.trim();
		}
	}

	return {
		headline,
		blurb,
		ctaState,
		suggestedCta,
		audience,
		releaseStatus,
		suggestedAssets: {
			confirmed: strings(assetsRaw.confirmed),
			needsConfirmation: strings(assetsRaw.needsConfirmation),
		},
		inputsNeeded: strings(raw.inputsNeeded),
		safetyNote: requiredString(raw.safetyNote),
		promptSource,
		clamped: { assets: clampedAssets, assetKinds },
	};
}

/**
 * The lines every exported caveat block opens with.
 *
 * Shared by the two branches of {@link composeExportMarkdown} — the full block,
 * and the note-only one an unreadable candidate leaves — because a reader who
 * met two different framings of the same section would have no way to tell
 * which one describes the file in front of them. Spread, never pushed into.
 */
const CAVEAT_HEADING = [
	"# Draft caveats — not ready to send",
	"",
	"This newsletter blurb was exported from Fabric as a draft. These notes are part of the draft; delete this section once they are settled.",
	"",
];

/**
 * The Markdown that leaves the app, caveats and all.
 *
 * Mirrors `WebinarScriptPanel`'s composer of the same name, down to the
 * `{ body, doc, safetyDoc, clamped, bodyIsFromLatest }` it takes: every field
 * outside `headline`/`blurb`/`suggestedCta` renders OUTSIDE the editable body,
 * which is right on screen — an author who had to delete four sections before
 * every regeneration would stop regenerating — and is a hole in an exported
 * file, where nothing else catches it once the file leaves Fabric.
 *
 * A newsletter blurb is short enough to look already checked, and it is pasted
 * into a template addressed to a list. That is precisely the artefact that must
 * not travel without saying who it was framed for and whether its release claim
 * was ever confirmed.
 *
 * A draft that is not clean is prefixed with a block naming all of it; a clean
 * one with nothing else to say exports unchanged, because a caveat that fires
 * on every draft is a caveat nobody reads.
 *
 * WHAT COUNTS AS UNCLEAN. `UNCONFIRMED` release, `UNKNOWN` call to action, an
 * unconfirmed asset, a clamped asset, an outstanding input, a safety note, or a
 * body saved from an earlier generation. The other release states are carried
 * by the prose itself, and the other two call-to-action states are decisions
 * rather than gaps: `PRESENT` puts the line in the body, and `OMITTED` is the
 * draft saying none is useful. `UNKNOWN` is the one this format cannot express
 * in its own prose — the reconciler guarantees there is no CTA text to carry —
 * so the file reads as finished while a send is still missing its ask.
 *
 * `audience` is emitted in the block but never triggers it. `UNSPECIFIED` means
 * the draft was framed for the NARROWEST readership it supports, which is the
 * safe direction; caveating it would put a warning on the draft that took the
 * fewest risks.
 *
 * `suggestedAssets.confirmed` is likewise not part of "clean", and renders in a
 * section of its own regardless — the fix Task 11 of the Webinar slice found.
 * A confirmed asset is the draft's advice about which material is ready to use,
 * not a warning: gating on it would print "not ready to send" over a spotless
 * draft, and leaving it out with no section of its own would drop the list from
 * the download silently, since `suggestedAssets` has no other way into a file.
 */
function composeExportMarkdown({
	body,
	doc,
	safetyDoc,
	clamped,
	bodyIsFromLatest,
}: {
	body: string;
	doc: NewsletterBlurbPanelDocument | null;
	/**
	 * Where the SAFETY NOTE comes from — the version the body was adopted from
	 * when that is known, and the newest ready one otherwise.
	 *
	 * Separate from `doc` because the two describe different things. Everything
	 * else this function emits is metadata ABOUT the candidate, which the
	 * `OTHER_VERSION_NOTE` line below already flags as another version's; the
	 * safety note describes the TEXT being exported, and getting that wrong
	 * means shipping a file whose stated generalizations belong to a draft
	 * nobody adopted — or, when the newest version needs none, shipping one
	 * that silently omits the generalizations that do apply.
	 */
	safetyDoc: NewsletterBlurbPanelDocument | null;
	clamped: NewsletterBlurbClamp;
	bodyIsFromLatest: boolean;
}): string {
	if (!doc) {
		// An unreadable candidate: `readyId` is read off the ROW and `doc` off
		// its CONTENT, so a row whose stored shape this client rejects leaves
		// `readyId` non-null and `doc` null at once. Every caveat line below is
		// one of `doc`'s fields, and none of them exists here.
		//
		// The safety note is the exception, which is the whole point of
		// `safetyDoc`: it is non-null exactly when the ADOPTED version parsed,
		// and that does not depend on `doc` at all. Returning `body` with a
		// known note in hand ships a file silently missing generalizations that
		// apply to its own text.
		//
		// Nothing else is invented: a heading with nothing under it, or a
		// placeholder release status, would be a claim about a document nobody
		// can read. `OTHER_VERSION_NOTE` is deliberately absent too — reaching
		// this line means `safetyDoc` IS the adopted version, so the note
		// describes exactly the text being exported and the sentence would be
		// false. The screen agrees: `noteDescribesAnotherVersion` is false in
		// this same state.
		if (!safetyDoc?.safetyNote) {
			return body;
		}

		const noteOnly = [
			...CAVEAT_HEADING,
			`- Safety note: ${safetyDoc.safetyNote}`,
		];
		return `${noteOnly.join("\n")}\n\n---\n\n${body}`;
	}

	const isClean =
		doc.releaseStatus !== "UNCONFIRMED" &&
		doc.ctaState !== "UNKNOWN" &&
		doc.suggestedAssets.needsConfirmation.length === 0 &&
		clamped.assets.length === 0 &&
		doc.inputsNeeded.length === 0 &&
		// The note that would be EXPORTED, not the newest one — a body adopted
		// from a generalized version is not clean just because the candidate
		// above it happens to be.
		!safetyDoc?.safetyNote &&
		bodyIsFromLatest;
	const hasConfirmedAssets = doc.suggestedAssets.confirmed.length > 0;
	if (isClean && !hasConfirmedAssets) {
		return body;
	}

	const sections: string[] = [];

	if (!isClean) {
		const caveat: string[] = [
			...CAVEAT_HEADING,
			`- Release status: ${RELEASE_STATUS_LABELS[doc.releaseStatus]}`,
			`- Audience: ${AUDIENCE_LABELS[doc.audience]}`,
			`- Call to action: ${CTA_STATE_LABELS[doc.ctaState]}`,
		];

		if (!bodyIsFromLatest) {
			caveat.push(`- ${OTHER_VERSION_NOTE}`);
		}
		if (safetyDoc?.safetyNote) {
			caveat.push(`- Safety note: ${safetyDoc.safetyNote}`);
		}
		if (doc.suggestedAssets.needsConfirmation.length > 0) {
			caveat.push(
				`- Assets needing confirmation: ${doc.suggestedAssets.needsConfirmation.join(", ")}.`,
			);
		}
		for (const asset of clamped.assets) {
			const kindLabel =
				ASSET_CLAMP_KIND_LABELS[clamped.assetKinds[asset] ?? ""] ??
				ASSET_CLAMP_KIND_FALLBACK;
			caveat.push(
				`- ${asset} — ${ASSET_CLAMP_NOTE} ${kindLabel} naming it.`,
			);
		}
		if (doc.inputsNeeded.length > 0) {
			caveat.push("", "## Still needed before sending", "");
			for (const item of doc.inputsNeeded) {
				caveat.push(`- ${item}`);
			}
		}
		sections.push(caveat.join("\n"));
	}

	// Content, not a caveat — see the docblock. Rendered whenever there is a
	// confirmed asset to name, whether or not the caveat block above fired.
	if (hasConfirmedAssets) {
		sections.push(
			[
				"## Suggested assets",
				"",
				...doc.suggestedAssets.confirmed.map((asset) => `- ${asset}`),
			].join("\n"),
		);
	}

	return `${sections.join("\n\n")}\n\n---\n\n${body}`;
}

export function NewsletterBlurbPanel({
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
	 * The edit instruction for a REFINE run, kept apart from `guidance` — see
	 * `CaseStudyPanel`'s identical field for why a shared one would silently
	 * carry the wrong kind of text into whichever action was pressed second.
	 */
	const [refineInstruction, setRefineInstruction] = useState("");
	/**
	 * The editor's text, or null for "showing what the server last returned".
	 * Null rather than a copy of the body, so a poll landing while the reader
	 * has NOT typed shows the newer text, and one landing while they HAVE typed
	 * does not silently discard what they wrote.
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
		orpc.projects.publishingSuite.generateNewsletterBlurb.mutationOptions({
			onSuccess: (result) => {
				// `started: false` is an ANSWER, not a failure — Temporal is
				// down, or a run this tab has not seen yet is already filling
				// the row.
				if (!result.started) {
					toast.info(
						result.reason === "unavailable"
							? "Generation is unavailable right now. Try again in a few minutes."
							: "A newsletter blurb is already being generated for this topic.",
					);
				}
				invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not start the newsletter blurb.");
			},
		}),
	);

	const adopt = useMutation(
		orpc.projects.publishingSuite.adoptNewsletterBlurbDraft.mutationOptions(
			{
				onSuccess: () => {
					setEditedBody(null);
					toast.success("Saved as the working newsletter blurb.");
					invalidateDrafts();
				},
				onError: (error: unknown) => {
					const code = (error as { code?: string } | null)?.code;
					if (code === "CONFLICT") {
						toast.error(
							"The saved newsletter blurb changed while you were reading. Refreshed — take another look.",
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
		orpc.projects.publishingSuite.saveNewsletterBlurbBody.mutationOptions({
			onSuccess: () => {
				setEditedBody(null);
				toast.success("Newsletter blurb saved.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				// A CONFLICT means someone else changed the draft while this tab
				// was editing. The edit is NOT discarded — `editedBody` is left
				// standing so the reader can copy their text before refreshing.
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"Someone else changed this newsletter blurb while you were editing. Your text is still here — copy it before refreshing.",
					);
					return;
				}
				toast.error("Could not save the newsletter blurb.");
			},
		}),
	);

	const doc = readNewsletterBlurbDocument(
		draft?.latestReady?.content ?? null,
	);
	const readyId = draft?.latestReady?.id ?? null;

	const bodyValue = editedBody ?? working?.body ?? "";
	const isDirty = editedBody !== null && editedBody !== (working?.body ?? "");

	/**
	 * Whether a generated version exists that the working draft did not come
	 * from — i.e. a regeneration the reader has not adopted. `readyId` non-null
	 * FIRST: a working draft whose source candidate was deleted carries a null
	 * `sourceDraftId` under the composite FK's `ON DELETE SET NULL`, and
	 * comparing `null !== null` would otherwise answer "no newer version" for a
	 * topic that has one.
	 */
	const hasUnadoptedVersion =
		readyId !== null && working?.sourceDraftId !== readyId;

	/**
	 * Whether the blocks built from `doc` — on screen, AND in the download via
	 * `composeExportMarkdown` — describe a version the text in the editor did
	 * not come from. Gated on there being a body to qualify: with no working
	 * draft the sentence would be false, since there is no "version this text
	 * was saved from".
	 *
	 * This flag qualifies only the CANDIDATE's own fields — the claims list, the
	 * inputs still needed. The safety note is the one field that moves, and it
	 * gets its own flag.
	 */
	const bodyIsFromLatest = !hasUnadoptedVersion;
	const notesDescribeAnotherVersion =
		!bodyIsFromLatest && working?.hasBody === true;

	/**
	 * The safety fields of the version the BODY came from.
	 *
	 * `doc` is the newest READY candidate — right for the comparison panes,
	 * wrong for anything describing the text in the editor. The qualifier above
	 * covers half of that and cannot reach the other half at all: when the
	 * adopted version was generalized and the newest needs none,
	 * `doc.safetyNote` is null, the section does not render, and there is
	 * nothing left on screen to qualify. The reader loses the explanation of the
	 * document they are holding, and the export carries it away silently.
	 *
	 * `readNewsletterBlurbDocument` again rather than a second reader: the
	 * source row's `content` is the same stored shape as the candidate's, and a
	 * hand-written body or a source row past retention parses to null, which is
	 * the honest "no note applies" rather than the newest one.
	 */
	const adoptedDoc = readNewsletterBlurbDocument(
		working?.sourceContent ?? null,
	);
	const safetyDoc =
		notesDescribeAnotherVersion && adoptedDoc ? adoptedDoc : doc;
	// The qualifier survives only for the case it can still describe: a source
	// row past retention, where the newest note is all there is. With the
	// adopted version in hand the note IS this text's, and saying otherwise
	// beside it would be false.
	const noteDescribesAnotherVersion =
		notesDescribeAnotherVersion && adoptedDoc === null;

	const handleAdopt = () => {
		if (!readyId) {
			return;
		}
		// FR35 is satisfied structurally — generation can only CREATE a working
		// draft, never replace one — but adopting a later version over saved
		// text IS a replacement. Unsaved editor text is called out separately,
		// because that is the part no refresh brings back.
		const warning = isDirty
			? "This replaces the saved newsletter blurb AND discards your unsaved edits. Continue?"
			: "This replaces the newsletter blurb you saved earlier. Continue?";
		if (working?.hasBody && !window.confirm(warning)) {
			return;
		}
		adopt.mutate({
			projectId,
			topicId,
			organizationId,
			draftId: readyId,
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

	const candidateBody = doc
		? composeNewsletterBlurbWorkingDraftBody(doc)
		: "";
	const candidate =
		hasUnadoptedVersion && doc ? (
			<CandidateDraft
				version={draft?.latestReady?.version ?? null}
				title={doc.headline}
				body={candidateBody}
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
				<h3 className="editorial-label" id="newsletter-blurb-editor">
					Working newsletter blurb
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
			{/* Only while a candidate sits beside it: with one draft on screen
			    there is nothing to tell apart. */}
			{candidate ? (
				<SavedDraftCaption>
					Saved. This is the blurb the topic holds — editing here
					changes it, and it is what the copy and download controls
					below send.
				</SavedDraftCaption>
			) : null}
			{canEdit ? (
				<>
					<Textarea
						aria-labelledby="newsletter-blurb-editor"
						value={bodyValue}
						onChange={(e) => setEditedBody(e.target.value)}
						maxLength={BODY_MAX}
						rows={12}
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
						{/* The bare body, deliberately — a copy lands in a
						    buffer whose owner is looking at the safety blocks
						    on this page as they press it; a download becomes a
						    file that travels on its own. */}
						<CopyDraftButton markdown={bodyValue} />
						<DraftDownloadDropdown
							markdown={composeExportMarkdown({
								body: bodyValue,
								doc,
								safetyDoc,
								clamped: doc?.clamped ?? {
									assets: [],
									assetKinds: {},
								},
								bodyIsFromLatest,
							})}
							filename={doc?.headline ?? "newsletter-blurb"}
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
						className="editorial-label block"
						htmlFor="newsletter-blurb-guidance"
					>
						Guidance (optional)
					</label>
					<Textarea
						id="newsletter-blurb-guidance"
						value={guidance}
						onChange={(e) => setGuidance(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={3}
						placeholder="Which newsletter it goes in, how long, who reads it, the ask to close on."
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
									// Empty guidance is null, not "": the
									// column means "what the reader asked for",
									// and "" is a guidance section with nothing
									// in it.
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
								: "Generate newsletter blurb"}
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
							against. The newsletter blurb you have saved is not
							affected until you adopt it.
						</p>
					) : null}
				</section>
			) : null}

			{/*
			 * A SECOND action, never a replacement for the one above.
			 * Regenerate rebuilds the blurb from the planning analysis; this one
			 * revises the saved text. Offered only once there is something saved
			 * to revise, since without a working draft it has no input.
			 */}
			{canEdit && working?.hasBody ? (
				<section className="space-y-2">
					<label
						className="editorial-label block"
						htmlFor="newsletter-blurb-refine"
					>
						Refine the saved draft
					</label>
					<Textarea
						id="newsletter-blurb-refine"
						value={refineInstruction}
						onChange={(e) => setRefineInstruction(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={2}
						placeholder="Make it one sentence. Warmer tone. Lead with the metric."
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
							// refinement with no instruction is a rewrite of the
							// draft for no stated reason.
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
						Starts from the newsletter blurb you have saved and
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

			{doc && doc.promptSource !== "BOUND" ? (
				<p className="text-muted-foreground text-sm leading-relaxed">
					{PROMPT_SOURCE_NOTICE[doc.promptSource]}
				</p>
			) : null}

			{doc ? (
				<section className="space-y-2">
					<h3 className="editorial-label">What the draft claims</h3>
					{/* The qualifier sits ABOVE the values it qualifies: a
					    reader must learn whose text this describes before
					    reading it, not after. */}
					{notesDescribeAnotherVersion ? (
						<p className="text-muted-foreground text-sm leading-relaxed">
							{OTHER_VERSION_NOTE}
						</p>
					) : null}
					{/* WORDS, never tints. Each value is a full sentence rather
					    than a coloured chip, so nothing here is carried by
					    colour alone and nothing needs an icon to decode. */}
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
								{AUDIENCE_LABELS[doc.audience]}
							</dd>
						</div>
						<div className="space-y-0.5">
							<dt className="font-medium">Call to action</dt>
							<dd className="text-muted-foreground leading-relaxed">
								{CTA_STATE_LABELS[doc.ctaState]}
							</dd>
						</div>
					</dl>
					{/* Nothing above was checked server-side — Fabric holds no
					    record of what has shipped or of who a newsletter goes
					    to — and a reader told otherwise stops checking, which
					    is the one behaviour this block must not cause. */}
					<p className="text-muted-foreground text-xs leading-relaxed">
						These are the draft's own reading of the source
						material. Nothing here was checked against a release
						record — you are the one who can confirm it.
					</p>
				</section>
			) : null}

			{doc &&
			(doc.suggestedAssets.confirmed.length > 0 ||
				doc.suggestedAssets.needsConfirmation.length > 0) ? (
				<div className="grid gap-4 sm:grid-cols-2">
					{doc.suggestedAssets.confirmed.length > 0 ? (
						<section className="space-y-2 rounded-xl border border-border bg-muted/40 p-4">
							<h3 className="editorial-label">
								Assets confirmed
							</h3>
							<p className="text-muted-foreground text-xs leading-relaxed">
								The draft lists these as confirmed for use. That
								is its own account of the source material, not
								an approval record — check anything you have not
								confirmed yourself.
							</p>
							<ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
								{doc.suggestedAssets.confirmed.map((asset) => (
									<li key={asset}>{asset}</li>
								))}
							</ul>
						</section>
					) : null}
					{doc.suggestedAssets.needsConfirmation.length > 0 ? (
						<section className="space-y-2 rounded-xl border border-highlight/40 bg-highlight/10 p-4">
							<h3 className="editorial-label">
								Assets needing confirmation
							</h3>
							<p className="text-xs leading-relaxed">
								Referenced by the draft but NOT confirmed.
								Confirm each one before sending.
							</p>
							{/* Which of these entries Fabric moved here, and
							    why, rendered separately from the plain list
							    below so a reader can tell an overruled claim
							    from ordinary model caution. */}
							{doc.clamped.assets.length > 0 ? (
								<ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed">
									{doc.clamped.assets.map((asset) => (
										<li key={asset}>
											{asset} — {ASSET_CLAMP_NOTE}{" "}
											{ASSET_CLAMP_KIND_LABELS[
												doc.clamped.assetKinds[asset] ??
													""
											] ?? ASSET_CLAMP_KIND_FALLBACK}{" "}
											naming it.
										</li>
									))}
								</ul>
							) : null}
							<ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
								{doc.suggestedAssets.needsConfirmation.map(
									(asset) => (
										<li key={asset}>{asset}</li>
									),
								)}
							</ul>
						</section>
					) : null}
				</div>
			) : null}

			<DraftComparison saved={savedDraft} candidate={candidate} />

			{/*
			   OUTSIDE the `doc` gate below, alone among these blocks, and MOVED
			   rather than copied — a second instance is how the two get to
			   disagree later.

			   `safetyDoc` is non-null exactly when the version the body was
			   adopted from parsed, which does not depend on the newest candidate
			   parsing: an unreadable candidate leaves `doc` null while a known
			   note still applies to the text in the editor. Gating this on `doc`
			   would drop that note from the screen for the same reason it used
			   to drop from the file.
			*/}
			{safetyDoc?.safetyNote ? (
				<GeneralizationNotes
					heading="What the draft wrote around"
					note={safetyDoc.safetyNote}
					describesAnotherVersion={noteDescribesAnotherVersion}
				/>
			) : null}

			{doc ? (
				<>
					{doc.inputsNeeded.length > 0 ? (
						<section className="space-y-2">
							<h3 className="editorial-label">Inputs needed</h3>
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
					No newsletter blurb draft yet.
				</p>
			) : null}
		</div>
	);
}
