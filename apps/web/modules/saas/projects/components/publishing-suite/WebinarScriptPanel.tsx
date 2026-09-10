"use client";

import {
	composeWebinarScriptWorkingDraftBody,
	RELEASE_STATUS_LABELS,
	type WebinarScriptDocument,
} from "@repo/utils/publishing-webinar-script-body";
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

/** Mirrors the API's own bounds, so a field cannot submit what it would reject. */
const GUIDANCE_MAX = 2000;
const BODY_MAX = 40000;

/**
 * The Webinar / Demo Script generation panel (Fizzy #1988, Phase 2D-1).
 *
 * Mirrors `CaseStudyPanel` and `StakeholderEmailPanel` deliberately and
 * closely — the same `editedBody` sentinel, the same stranded/generating
 * split, the same optimistic-concurrency key, the same CONFLICT branch that
 * keeps a reader's text, the same candidate/saved comparison, the same
 * `safetyDoc` split that reads the safety note off the version the body was
 * adopted from — because all three products share one shape: one generation
 * seeds one editable draft, and a later version is offered rather than
 * applied. `BlogPostPanel` is the fourth of that family and shares everything
 * but the export, which it has none of.
 *
 * WHAT IS DIFFERENT, and each difference has a reason:
 *
 *  - The document is structured across a dozen fields rather than a single
 *    prose `body`. Everything from `title` through `suggestedCta` is already
 *    IN the working draft's text — `composeWebinarScriptWorkingDraftBody`
 *    composes it, the same function the generation activity seeds with — so
 *    the RENDER below surfaces, separately from the editor, only the fields
 *    that composer deliberately EXCLUDES: `isScaffold`, `releaseStatus`,
 *    `suggestedAssets`, `inputsNeeded` and `safetyNote`. (The reader still
 *    parses every field — building the candidate preview and the export both
 *    need the whole document, not just the excluded ones.) The excluded
 *    fields are advice ABOUT the draft, not part of it, for the same reason
 *    the Case Study's approval fields are: an author who had to delete four
 *    sections before every regeneration would stop regenerating.
 *  - `releaseStatus` has six values where the family's other enums have
 *    three (the Case Study's `customerIdentity` and `metricsBasis`) or five
 *    (the Stakeholder Email's own `releaseStatus`). Six is not five plus one:
 *    this one DROPS `UPCOMING`, folding it into `PLANNED`, and adds `PREVIEW`
 *    and `CONCEPT`. `UNCONFIRMED` is in both and is the default here.
 *    `RELEASE_STATUS_LABELS` is imported from `@repo/utils` rather than
 *    redeclared here: the export composer in the same module uses the exact
 *    same map, and two hand-maintained copies of the same six sentences are
 *    two sentences as soon as one of them is edited.
 *  - `promptSource` gets a notice this family's other two panels do not
 *    render. It is the only per-draft signal that the organization's own
 *    editable prompt was NOT used — either nothing was bound
 *    (`DEFAULT_UNBOUND`) or the bound prompt's body could not be rendered and
 *    the code-side default was recovered (`DEFAULT_RENDER_FAILED`) — and
 *    nothing else on the page says so.
 *  - The asset clamp carries a `kind` the Case Study's does not: which of the
 *    three restricting decision kinds (an open asset approval, an
 *    unconfirmed internal-UI capture, an unconfirmed video walkthrough)
 *    caused Fabric to move a claimed-confirmed asset into the
 *    needs-confirmation list. Rendering the LABEL alone would say Fabric
 *    acted without saying why; this is the one place in the app that reads
 *    `assetKinds` at all, and it exists to make it visible.
 *  - The download IS a locally-owned composer, `composeExportMarkdown`,
 *    mirroring the Case Study's and Stakeholder Email's rather than calling
 *    `composeWebinarScriptExport(doc, clamped)` from `@repo/utils` directly.
 *    That shared composer rebuilds the whole file from the structured
 *    document and has no way to accept a reader's free-text edits — calling
 *    it here would silently swap the download for a different generation
 *    than the one the editor and the copy button show, which is exactly the
 *    bug an earlier version of this file shipped. `composeExportMarkdown`
 *    instead prefixes a caveat block — the scaffold line, the release
 *    status, both suggested-asset lists with the clamp attribution (kind
 *    included), `inputsNeeded`, `safetyNote`, and `OTHER_VERSION_NOTE` when
 *    the working draft was saved from an earlier generation — onto the
 *    reader's own `bodyValue`, the same text the editor and the copy button
 *    show. `composeWebinarScriptExport` still exists in `@repo/utils`: it has
 *    no production caller left in this panel, but Task 10's re-review flagged
 *    a future webinar-script export endpoint that would need exactly this
 *    structured composer, so it stays.
 */

type ReleaseStatus = WebinarScriptDocument["releaseStatus"];
const RELEASE_STATUSES: readonly ReleaseStatus[] = [
	"SHIPPED",
	"IN_PROGRESS",
	"PLANNED",
	"PREVIEW",
	"CONCEPT",
	"UNCONFIRMED",
];

type PromptSourceValue = "BOUND" | "DEFAULT_UNBOUND" | "DEFAULT_RENDER_FAILED";
const PROMPT_SOURCES: readonly PromptSourceValue[] = [
	"BOUND",
	"DEFAULT_UNBOUND",
	"DEFAULT_RENDER_FAILED",
];

/**
 * Said when the draft was NOT written from the organization's own bound
 * prompt. `BOUND` gets no entry: the notice renders only for the other two,
 * and the reader's document type check (`!== "BOUND"`) is what decides that,
 * not a `default` case here — a third non-bound value added later without a
 * matching entry is a compile error, not a silent blank.
 *
 * Falls back to the UNBOUND wording for anything unrecognized — see
 * `readWebinarScriptDocument`'s own comment on `promptSource` for why an
 * absent or garbled value fails toward showing this notice rather than
 * hiding it.
 */
const PROMPT_SOURCE_NOTICE: Record<
	Exclude<PromptSourceValue, "BOUND">,
	string
> = {
	DEFAULT_UNBOUND:
		"No organization prompt is bound for the webinar script — this draft was written from Fabric's own default.",
	DEFAULT_RENDER_FAILED:
		"The organization's bound prompt could not be rendered — this draft was written from Fabric's own default instead.",
};

/**
 * One phrase per {@link ASSET_RESTRICTING_KINDS} member
 * (`@repo/utils/publishing-asset-clamp`), for the attribution line Task 8's
 * own comment promises: "we moved this asset, and here is the approval that
 * did it." A label alone would say WHAT moved without saying WHY; this map is
 * the WHY.
 */
const ASSET_CLAMP_KIND_LABELS: Record<string, string> = {
	ASSET_APPROVAL: "an open asset-approval thread",
	INTERNAL_UI: "an open internal-UI review thread",
	VIDEO_WALKTHROUGH: "an open video-walkthrough review thread",
};
const ASSET_CLAMP_KIND_FALLBACK = "an open approval thread";

/**
 * Said of an asset the activity moved OUT of `confirmed`, never of one the
 * model itself put into `needsConfirmation` on its own — mirrors
 * `CaseStudyPanel`'s identical `ASSET_CLAMP_NOTE` and the reasoning behind
 * its separate wording: "the draft was unsure" and "Fabric overruled the
 * draft" are different facts about the same line.
 */
const ASSET_CLAMP_NOTE = "Moved out of the confirmed list by Fabric, from";

interface WebinarScriptClamp {
	assets: string[];
	assetKinds: Record<string, string>;
}

/**
 * The parsed document plus the two generation-block signals this panel reads
 * alongside it. `WebinarScriptDocument & {...}` rather than a nested shape,
 * so this value can be passed directly to `composeWebinarScriptWorkingDraftBody`
 * — which takes exactly that type — without an unwrap at every call site, and
 * so this panel's own `composeExportMarkdown` can read every advice field
 * straight off `doc` instead of re-threading them as separate parameters.
 */
type WebinarScriptPanelDocument = WebinarScriptDocument & {
	promptSource: PromptSourceValue;
	clamped: WebinarScriptClamp;
};

/**
 * Read a webinar script out of a draft's stored `content`.
 *
 * Defensive rather than trusting, for the reason its Case Study and
 * Stakeholder Email siblings document: `content` is `Json?`, so a row written
 * by an older shape — or a wholly different content type's shape — must
 * degrade to "nothing to show" instead of throwing inside a render. A panel
 * that throws takes the whole Topic Item Page with it.
 *
 * Checks the EIGHT fields the schema requires non-empty (`title` through
 * `suggestedCta`, minus the five that default instead — `presenterNotes`,
 * `agenda`, `demoFlow`, `supportingDetails`, `suggestedAssets`) and returns
 * null if any of the eight is missing — never re-validates the whole document
 * against `PublishingWebinarScriptSchema`. That full schema still bounds
 * `suggestedAssets` at 8 entries each, and the asset clamp's
 * `needsConfirmation` append has no cap of its own, so a stored document can
 * legitimately hold more entries than the schema would accept today. Task 10
 * hit exactly this re-validating the adopt path; this reader checks only the
 * fields it actually renders, the same fix.
 *
 * `releaseStatus` falls back to `UNCONFIRMED` — the schema's own default and
 * the most cautious of the six values — rather than to the first member of
 * the enum. A garbled or absent status reading as `SHIPPED` would turn a
 * storage defect into a claim that work is live.
 *
 * `promptSource` falls back to `DEFAULT_UNBOUND` on anything unrecognized,
 * INCLUDING an absent `generation` block entirely (a row from before this
 * field existed). The notice this drives exists to warn a reader that the
 * organization's own prompt was not used; treating "cannot tell" as "it was
 * bound" is the under-warning direction, and this repository's own standing
 * rule is that under-warning is the more expensive mistake.
 */
function readWebinarScriptDocument(
	content: unknown,
): WebinarScriptPanelDocument | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const raw = content as Record<string, unknown>;

	const requiredString = (value: unknown): string | null =>
		typeof value === "string" && value.trim() ? value.trim() : null;
	const optionalString = (value: unknown): string | undefined =>
		typeof value === "string" && value.trim() ? value.trim() : undefined;
	// Trimmed and emptied out, not merely type-checked — see the Case Study and
	// Stakeholder Email readers' identical comment: a whitespace-only entry
	// survives `typeof v === "string"` and then renders as a bullet with
	// nothing in it.
	const strings = (value: unknown): string[] =>
		Array.isArray(value)
			? value
					.filter((v): v is string => typeof v === "string")
					.map((v) => v.trim())
					.filter((v) => v.length > 0)
			: [];

	const title = requiredString(raw.title);
	const sessionPurpose = requiredString(raw.sessionPurpose);
	const recommendedAudience = requiredString(raw.recommendedAudience);
	const suggestedLength = requiredString(raw.suggestedLength);
	const openingTalkTrack = requiredString(raw.openingTalkTrack);
	const keyMessage = requiredString(raw.keyMessage);
	const closingTalkTrack = requiredString(raw.closingTalkTrack);
	const suggestedCta = requiredString(raw.suggestedCta);
	if (
		!title ||
		!sessionPurpose ||
		!recommendedAudience ||
		!suggestedLength ||
		!openingTalkTrack ||
		!keyMessage ||
		!closingTalkTrack ||
		!suggestedCta
	) {
		return null;
	}

	const presenterNotes = optionalString(raw.presenterNotes) ?? null;
	const agenda = strings(raw.agenda);

	const demoFlow = Array.isArray(raw.demoFlow)
		? raw.demoFlow
				.map((step) => {
					if (!step || typeof step !== "object") {
						return null;
					}
					const s = step as Record<string, unknown>;
					const name = requiredString(s.name);
					const whatToShow = requiredString(s.whatToShow);
					const talkTrack = requiredString(s.talkTrack);
					const audienceTakeaway = requiredString(s.audienceTakeaway);
					if (
						!name ||
						!whatToShow ||
						!talkTrack ||
						!audienceTakeaway
					) {
						return null;
					}
					return { name, whatToShow, talkTrack, audienceTakeaway };
				})
				.filter(
					(step): step is NonNullable<typeof step> => step !== null,
				)
		: [];

	const supportingRaw =
		raw.supportingDetails && typeof raw.supportingDetails === "object"
			? (raw.supportingDetails as Record<string, unknown>)
			: {};
	const supportingDetails = {
		problem: optionalString(supportingRaw.problem),
		solution: optionalString(supportingRaw.solution),
		whatMakesItInteresting: optionalString(
			supportingRaw.whatMakesItInteresting,
		),
		evidence: optionalString(supportingRaw.evidence),
		caveats: optionalString(supportingRaw.caveats),
	};

	const assetsRaw =
		raw.suggestedAssets && typeof raw.suggestedAssets === "object"
			? (raw.suggestedAssets as Record<string, unknown>)
			: {};
	const suggestedAssets = {
		confirmed: strings(assetsRaw.confirmed),
		needsConfirmation: strings(assetsRaw.needsConfirmation),
	};

	const releaseStatus = RELEASE_STATUSES.includes(
		raw.releaseStatus as ReleaseStatus,
	)
		? (raw.releaseStatus as ReleaseStatus)
		: "UNCONFIRMED";

	const inputsNeeded = strings(raw.inputsNeeded);
	const safetyNote = optionalString(raw.safetyNote) ?? null;

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
	// (`generate-webinar-script.ts`'s `assetClamp.moved.map(...)`), so a
	// document whose `confirmed` list held the same label twice would
	// otherwise carry that label twice here too — and the render below keys
	// each entry by its label, so a duplicate is a silent React key
	// collision, not a visible bug.
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
		title,
		sessionPurpose,
		recommendedAudience,
		suggestedLength,
		presenterNotes,
		openingTalkTrack,
		agenda,
		keyMessage,
		demoFlow,
		supportingDetails,
		suggestedAssets,
		closingTalkTrack,
		suggestedCta,
		releaseStatus,
		inputsNeeded,
		safetyNote,
		// Recomputed from the (defensively filtered) demo flow, the same way
		// the schema's own transform derives it — matching, rather than
		// trusting, the stored `isScaffold` value. Internal consistency only:
		// nothing downstream of this reader consults the stored field either.
		isScaffold: demoFlow.length === 0,
		promptSource,
		clamped: { assets: clampedAssets, assetKinds },
	};
}

/**
 * The lines every exported caveat block opens with.
 *
 * Shared by the two branches of `composeExportMarkdown` — the full block, and
 * the note-only one an unreadable candidate leaves — because a reader who met
 * two different framings of the same section would have no way to tell which
 * one describes the file in front of them. Spread, never pushed into.
 */
const CAVEAT_HEADING = [
	"# Draft caveats — not ready to present",
	"",
	"This webinar script was exported from Fabric as a draft. These notes are part of the draft; delete this section once they are settled.",
	"",
];

/**
 * The Markdown that leaves the app, caveats and all.
 *
 * Mirrors `StakeholderEmailPanel`'s `composeExportMarkdown` (and the Case
 * Study's before it), down to the `{ body, doc, safetyDoc, bodyIsFromLatest }`
 * those two take: every safety field renders OUTSIDE the editable body, which
 * is right on screen — an author who had to delete four sections before every
 * regeneration would stop regenerating — and is a hole in an exported file,
 * where nothing else catches it once the file leaves Fabric. A draft that is
 * not clean is prefixed with a block naming all of it; a clean one with
 * nothing else to say exports unchanged, because a caveat that fires on every
 * draft is a caveat nobody reads.
 *
 * The mirror stops in two places. `clamped` is this composer's own fifth
 * parameter: the two enum fields the Case Study clamps are lowered in place
 * and reported inline, where an asset is MOVED between two lists and carries
 * the KIND of approval that moved it. And a null `doc` returns early in both
 * siblings, where here it can still emit the safety note — see that branch
 * for why, and for why they are unchanged.
 *
 * Built from `body` (the reader's own `bodyValue`), never from
 * `composeWebinarScriptExport(doc, clamped)` in `@repo/utils`: that composer
 * rebuilds the whole file from the structured document and has no parameter
 * for a reader's free-text edits, so calling it here would silently swap the
 * download for a different generation than the one the editor and the copy
 * button show. Nothing is duplicated by building from `body` instead —
 * `composeWebinarScriptWorkingDraftBody` is exactly the sections this text
 * already contains, so `body` already carries every field the shared
 * composer's section-building shares with the working draft; this function
 * adds only what the working draft deliberately omits.
 *
 * `bodyIsFromLatest` is part of "clean", the same way it is for the
 * Stakeholder Email: the other fields describe the latest READY generation,
 * and the working body may have been saved from an earlier one.
 * `OTHER_VERSION_NOTE` fires here, not only on screen, because the export is
 * the LAST place that gap can be caught. Saying so is all it can do about the
 * candidate's metadata; the safety note is the one field that can be read off
 * the right version instead, which is what `safetyDoc` is for.
 *
 * The clamp attribution here names the KIND per asset, which
 * `composeWebinarScriptExport` does not — its own note joins labels with no
 * reason given. This uses the same map the panel renders on screen,
 * `ASSET_CLAMP_KIND_LABELS`, so the file and the page say the same thing.
 *
 * `suggestedAssets.confirmed` is deliberately NOT one of the fields "clean"
 * is computed from (see `hasConfirmedAssets` below). Every other excluded
 * field this function renders is a warning — a scaffold, an unconfirmed
 * release, an asset nobody has signed off on, an outstanding input, a
 * safety rewrite, a stale version — something a reader needs to resolve
 * before the draft is presentable. A confirmed asset is not that: it is the
 * draft's own advice about which material is ready to use, the same kind of
 * fact `suggestedCta` or `recommendedAudience` is, just excluded from `body`
 * because `composeWebinarScriptWorkingDraftBody` excludes it (see the module
 * docblock). Folding it into `isClean` would force a choice between two
 * wrongs: gate on it and an otherwise-spotless draft gets exported under a
 * "# Draft caveats — not ready to present" heading that is false of it, or
 * leave it out of the gate without a section of its own and the list goes
 * missing from the download exactly the way Task 11's re-review found —
 * silently, because `suggestedAssets` has no other way into an exported
 * file. So it renders in its own section, independent of `isClean`, and
 * `isClean` keeps its narrower job: deciding whether the CAVEAT block has
 * anything to say.
 */
function composeExportMarkdown({
	body,
	doc,
	safetyDoc,
	clamped,
	bodyIsFromLatest,
}: {
	body: string;
	doc: WebinarScriptPanelDocument | null;
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
	safetyDoc: WebinarScriptPanelDocument | null;
	clamped: WebinarScriptClamp;
	bodyIsFromLatest: boolean;
}): string {
	if (!doc) {
		// An unreadable candidate: `readyId` is read off the ROW and `doc` off
		// its CONTENT, so a row whose stored shape this client's schema
		// rejects leaves `readyId` non-null and `doc` null at once. Every
		// caveat line below is one of `doc`'s fields — scaffold state,
		// release status, assets, inputs — and none of them exists here.
		//
		// The safety note is the exception, which is the whole point of
		// `safetyDoc`: it is non-null exactly when the ADOPTED version parsed,
		// and that does not depend on `doc` at all. Returning `body` with a
		// known note in hand ships a file silently missing generalizations
		// that apply to its own text — the failure this split exists to
		// prevent, in the artefact that leaves the product.
		//
		// So the note is emitted alone. Nothing else is invented: a heading
		// with nothing under it, or a placeholder release status, would be a
		// claim about a document nobody can read.
		//
		// `OTHER_VERSION_NOTE` is deliberately NOT among them, and its absence
		// is load-bearing rather than an omission. Reaching this line at all
		// means `safetyDoc` is the ADOPTED version — `safetyDoc` falls back to
		// `doc` otherwise, and `doc` is null here — so the note describes
		// exactly the text being exported. `bodyIsFromLatest` is false in
		// every state that gets here, so the sentence would print
		// unconditionally, and it would be false in all of them: there is no
		// other-version metadata in this block to qualify, only a note that
		// is this text's own. This matches the screen, where the same state
		// leaves `noteDescribesAnotherVersion` false.
		//
		// This goes one step further than `CaseStudyPanel` and
		// `StakeholderEmailPanel`, whose composers return `body`
		// unconditionally here, and than `BlogPostPanel`, which has no export
		// at all. Those three are deliberately unchanged — a strict superset,
		// not a different contract: this emits a note in a case where they
		// emit nothing, and agrees with them everywhere else.
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
		!doc.isScaffold &&
		doc.releaseStatus !== "UNCONFIRMED" &&
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
			`- Scaffold: ${
				doc.isScaffold
					? "yes — the demo flow was not available from the topic context."
					: "no."
			}`,
			`- Release status: ${RELEASE_STATUS_LABELS[doc.releaseStatus]}`,
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
			caveat.push("", "## Still needed before presenting", "");
			for (const item of doc.inputsNeeded) {
				caveat.push(`- ${item}`);
			}
		}
		sections.push(caveat.join("\n"));
	}

	// Content, not a caveat — see the docblock above. Rendered whenever there
	// is a confirmed asset to name, whether or not the caveat block above
	// fired, so a clean draft keeps this list instead of silently dropping it.
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

export function WebinarScriptPanel({
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
	 * has NOT typed shows the newer text, and one landing while they HAVE
	 * typed does not silently discard what they wrote.
	 */
	const [editedBody, setEditedBody] = useState<string | null>(null);

	const attempt = draft?.latestAttempt ?? null;
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
		orpc.projects.publishingSuite.generateWebinarScript.mutationOptions({
			onSuccess: (result) => {
				if (!result.started) {
					toast.info(
						result.reason === "unavailable"
							? "Generation is unavailable right now. Try again in a few minutes."
							: "A webinar script is already being generated for this topic.",
					);
				}
				invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not start the webinar script.");
			},
		}),
	);

	const adopt = useMutation(
		orpc.projects.publishingSuite.adoptWebinarScriptDraft.mutationOptions({
			onSuccess: () => {
				setEditedBody(null);
				toast.success("Saved as the working webinar script.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"The saved webinar script changed while you were reading. Refreshed — take another look.",
					);
					invalidateDrafts();
					return;
				}
				toast.error("Could not adopt that version.");
			},
		}),
	);

	const saveBody = useMutation(
		orpc.projects.publishingSuite.saveWebinarScriptBody.mutationOptions({
			onSuccess: () => {
				setEditedBody(null);
				toast.success("Webinar script saved.");
				invalidateDrafts();
			},
			onError: (error: unknown) => {
				const code = (error as { code?: string } | null)?.code;
				if (code === "CONFLICT") {
					toast.error(
						"Someone else changed this webinar script while you were editing. Your text is still here — copy it before refreshing.",
					);
					return;
				}
				toast.error("Could not save the webinar script.");
			},
		}),
	);

	const doc = readWebinarScriptDocument(draft?.latestReady?.content ?? null);
	const readyId = draft?.latestReady?.id ?? null;

	const bodyValue = editedBody ?? working?.body ?? "";
	const isDirty = editedBody !== null && editedBody !== (working?.body ?? "");

	/**
	 * Whether a generated version exists that the working draft did not come
	 * from — i.e. a regeneration the reader has not adopted. `readyId`
	 * non-null FIRST: a working draft whose source candidate was deleted
	 * carries a null `sourceDraftId` under the composite FK's
	 * `ON DELETE SET NULL`.
	 */
	const hasUnadoptedVersion =
		readyId !== null && working?.sourceDraftId !== readyId;

	/**
	 * Whether the blocks built from `doc` — on screen, AND in the download via
	 * `composeExportMarkdown` — describe a version the text in the editor did
	 * not come from. `doc` is the LATEST READY generation, and the editor, the
	 * copy button and the download all operate on the WORKING draft, which is
	 * the same document most of the time and a different one after any
	 * regeneration the reader has not adopted. Gated on there being a body to
	 * qualify: with no working draft the sentence would be false, since there
	 * is no "version this text was saved from".
	 *
	 * This flag now qualifies only the CANDIDATE's own fields — the scaffold
	 * banner, the release status, the inputs still needed. Those describe the
	 * other version whether or not its predecessor is in hand, so nothing
	 * below narrows them. The safety note is the one field that moves, and it
	 * gets its own flag.
	 */
	const bodyIsFromLatest = !hasUnadoptedVersion;
	const notesDescribeAnotherVersion =
		!bodyIsFromLatest && working?.hasBody === true;

	/**
	 * The safety fields of the version the BODY came from.
	 *
	 * `doc` is the newest READY candidate — right for the comparison panes,
	 * wrong for anything describing the text in the editor. The qualifier
	 * above covered half of that and could not reach the other half at all:
	 * when the adopted version was generalized and the newest needs none,
	 * `doc.safetyNote` is null, the section does not render, and there is
	 * nothing left on screen to qualify. The reader loses the explanation of
	 * the document they are holding, and the export carries it away silently —
	 * the worse half, since a downloaded file is read where this page is not.
	 *
	 * `readWebinarScriptDocument` again rather than a second reader: the source
	 * row's `content` is the same stored shape as the candidate's, and a
	 * hand-written body or a source row past retention parses to null, which is
	 * the honest "no note applies" rather than the newest one.
	 *
	 * Spelled the way `StakeholderEmailPanel` and `BlogPostPanel` spell it, two
	 * names rather than one: `CaseStudyPanel` folds the qualifier back into a
	 * single flag, which also drops it from the candidate's own fields. Those
	 * fields are still another version's, so the split is the part worth
	 * copying.
	 */
	const adoptedDoc = readWebinarScriptDocument(
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
		const warning = isDirty
			? "This replaces the saved webinar script AND discards your unsaved edits. Continue?"
			: "This replaces the webinar script you saved earlier. Continue?";
		if (working?.hasBody && !window.confirm(warning)) {
			return;
		}
		adopt.mutate({
			projectId,
			topicId,
			organizationId,
			draftId: readyId,
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

	const candidateBody = doc ? composeWebinarScriptWorkingDraftBody(doc) : "";
	const candidate =
		hasUnadoptedVersion && doc ? (
			<CandidateDraft
				version={draft?.latestReady?.version ?? null}
				title={doc.title}
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
				<h3 className="editorial-label" id="webinar-script-editor">
					Working webinar script
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
			{candidate ? (
				<SavedDraftCaption>
					Saved. This is the script the topic holds — editing here
					changes it, and it is what the copy and download controls
					below send.
				</SavedDraftCaption>
			) : null}
			{canEdit ? (
				<>
					<Textarea
						aria-labelledby="webinar-script-editor"
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
							filename={doc?.title ?? "webinar-script"}
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
						htmlFor="webinar-script-guidance"
					>
						Guidance (optional)
					</label>
					<Textarea
						id="webinar-script-guidance"
						value={guidance}
						onChange={(e) => setGuidance(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={3}
						placeholder="Audience, session length, which demo steps to include, tone."
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
								: "Generate webinar script"}
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
							against. The webinar script you have saved is not
							affected until you adopt it.
						</p>
					) : null}
				</section>
			) : null}

			{canEdit && working?.hasBody ? (
				<section className="space-y-2">
					<label
						className="editorial-label block"
						htmlFor="webinar-script-refine"
					>
						Refine the saved draft
					</label>
					<Textarea
						id="webinar-script-refine"
						value={refineInstruction}
						onChange={(e) => setRefineInstruction(e.target.value)}
						maxLength={GUIDANCE_MAX}
						rows={2}
						placeholder="Cut the demo to five minutes. Warmer tone. Lead with the metric."
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
						Starts from the webinar script you have saved and
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

			{doc?.isScaffold ? (
				<section className="space-y-1 rounded-xl border border-highlight/40 bg-highlight/10 p-4">
					<h3 className="editorial-label">Scaffold draft</h3>
					<p className="text-sm leading-relaxed">
						There wasn't enough confirmed material to write a demo
						flow, so this is a scaffold — talk tracks and messaging
						without a walkthrough. Fill the gaps under "Inputs
						needed" before presenting it.
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
					<h3 className="editorial-label">Release status</h3>
					{notesDescribeAnotherVersion ? (
						<p className="text-muted-foreground text-sm leading-relaxed">
							{OTHER_VERSION_NOTE}
						</p>
					) : null}
					{/* A single sentence under a heading that already names it —
					    a `<dl>` with one row would repeat "Release status"
					    verbatim and structure a value that has no second field
					    to sit beside. */}
					<p className="rounded-xl border border-border bg-card p-4 text-muted-foreground text-sm leading-relaxed">
						{RELEASE_STATUS_LABELS[doc.releaseStatus]}
					</p>
					{/* Unlike the case study's clamped enums, nothing checks a
					    release claim server-side — the activity carries no
					    customerIdentity/metricsBasis-shaped field for this
					    content type — so a reader told otherwise stops
					    verifying it. */}
					<p className="text-muted-foreground text-xs leading-relaxed">
						This is the draft's own reading of the source material.
						Nothing here was checked against a release record — you
						are the one who can confirm it.
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
								Confirm each one before presenting.
							</p>
							{/* The attribution line Task 8's own comment
							    promises: which of these entries Fabric moved
							    here, and why, rendered separately from the
							    plain list below so a reader can tell an
							    overruled claim from ordinary model caution. */}
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
			   OUTSIDE the `doc` gate below, alone among these blocks, and
			   MOVED rather than copied — a second instance is how the two get
			   to disagree later.

			   `safetyDoc` is non-null exactly when the version the body was
			   adopted from parsed, which does not depend on the newest
			   candidate parsing: an unreadable candidate leaves `doc` null
			   while a known note still applies to the text in the editor.
			   Gating this on `doc` would drop that note from the screen for
			   the same reason the export used to drop it from the file.

			   Every other block in the subtree below genuinely reads `doc`'s
			   own fields and stays gated on it. `CaseStudyPanel`,
			   `StakeholderEmailPanel` and `BlogPostPanel` all still gate
			   theirs — unchanged on purpose; this renders a note where they
			   render nothing, and behaves identically everywhere else.
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
					No webinar script draft yet.
				</p>
			) : null}
		</div>
	);
}
